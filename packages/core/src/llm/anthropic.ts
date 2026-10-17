import Anthropic from '@anthropic-ai/sdk';
import { NO_FORCED_TOOL_CHOICE } from '../config/models';
import type { AdapterRequest, AdapterResponse, ProviderAdapter, Source } from './types';

type MappableMessage = Pick<Anthropic.Message, 'content' | 'usage'>;

/** Map a final Anthropic message to the provider-neutral response shape. */
export function mapAnthropicMessage(msg: MappableMessage, toolName?: string): AdapterResponse {
  const texts: string[] = [];
  const sources = new Map<string, Source>();
  let json: unknown;

  const addSource = (s: Source) => {
    const existing = sources.get(s.url);
    if (!existing) {
      sources.set(s.url, Object.fromEntries(Object.entries(s).filter(([, v]) => v != null)) as Source);
      return;
    }
    existing.title ??= s.title;
    existing.citedText ??= s.citedText;
  };

  for (const block of msg.content) {
    if (block.type === 'text') {
      texts.push(block.text);
      for (const c of block.citations ?? []) {
        if (c.type === 'web_search_result_location') addSource({ url: c.url, citedText: c.cited_text });
      }
    } else if (block.type === 'web_search_tool_result') {
      if (Array.isArray(block.content)) {
        for (const r of block.content) addSource({ url: r.url, title: r.title });
      }
    } else if (block.type === 'tool_use' && json === undefined && (!toolName || block.name === toolName)) {
      json = block.input;
    }
  }

  return {
    text: texts.join(''),
    ...(json !== undefined ? { json } : {}),
    sources: [...sources.values()],
    usage: {
      // Cached prompt tokens are reported separately; count them so cost/usage logs don't drop them.
      inputTokens: msg.usage.input_tokens
        + (msg.usage.cache_creation_input_tokens ?? 0) + (msg.usage.cache_read_input_tokens ?? 0),
      outputTokens: msg.usage.output_tokens,
      searchRequests: msg.usage.server_tool_use?.web_search_requests ?? 0,
    },
  };
}

/** True for the API error a model returns when it does not support forced tool_choice (`tool`/`any`). */
export function isForcedToolChoiceRejection(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : '';
  return /tool_choice/.test(msg) && /not supported/.test(msg);
}

/**
 * Build Messages API params. Structured output uses one tool, forced via `tool_choice: tool` when
 * `forceTool` is set; otherwise `tool_choice: auto` (single call) plus an instruction naming the tool in
 * the system prompt and, on re-asks, in the latest user message. A reply without the tool call is caught
 * by the router's re-ask loop.
 * The first user message carries a cache_control breakpoint: Fuelix rejects claude-opus-5-5 prompts of
 * 1024+ tokens without one, and it lets re-asks reuse the cached tools + system + prompt prefix.
 */
export function buildAnthropicParams(
  r: AdapterRequest,
  { forceTool }: { forceTool: boolean },
): Anthropic.MessageCreateParamsNonStreaming {
  if (r.jsonSchema && r.webSearch) throw new Error('anthropic adapter: a request cannot use both jsonSchema and webSearch');
  const tools: Anthropic.ToolUnion[] = [];
  let system = r.system;
  const toolName = r.jsonSchema?.name;
  const instruction = toolName && !forceTool
    ? `Give your final answer by calling the \`${toolName}\` tool exactly once with the complete result. Do not answer in plain text.`
    : null;
  const last = r.messages.length - 1;
  const messages: Anthropic.MessageParam[] = r.messages.map((m, i) => {
    const text = instruction && i === last && i > 0 && m.role === 'user' ? `${m.content}\n\n${instruction}` : m.content;
    return i === 0
      ? { role: m.role, content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] }
      : { role: m.role, content: text };
  });
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: r.model,
    max_tokens: r.maxTokens,
    messages,
  };
  if (r.jsonSchema) {
    tools.push({
      name: r.jsonSchema.name,
      description: `Return the ${r.jsonSchema.name} result as structured data.`,
      input_schema: r.jsonSchema.schema as Anthropic.Tool.InputSchema,
    });
    params.tool_choice = forceTool
      ? { type: 'tool', name: r.jsonSchema.name }
      : { type: 'auto', disable_parallel_tool_use: true };
    if (instruction) system = system ? `${system}\n\n${instruction}` : instruction;
  }
  if (r.webSearch) {
    tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: r.webSearch.maxUses });
  }
  if (tools.length) params.tools = tools;
  if (system) params.system = system;
  return params;
}

type Send = (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<MappableMessage>;
export type AnthropicTransport = { stream: Send; create: Send };

/**
 * True for the gateway's streaming-only rejection: Fuelix intermittently answers streaming /v1/messages
 * requests with an SSE error event `Error code: 403 - {'error': 'forbidden'}` while the same request
 * without streaming succeeds (live run 2026-10-17).
 */
export function isStreamForbidden(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : '';
  return /Error code: 403\b/.test(msg) && /forbidden/.test(msg);
}

export function createAnthropicAdapter(opts: { baseURL: string; key: string; transport?: AnthropicTransport }): ProviderAdapter {
  let transport = opts.transport;
  if (!transport) {
    // apiKey: null stops the SDK picking up ANTHROPIC_API_KEY (which would win over the bearer token).
    // The explicit timeout also lets the SDK accept long non-streaming requests (used only as a fallback).
    const client = new Anthropic({
      baseURL: opts.baseURL,
      apiKey: null,
      authToken: opts.key,
      timeout: 15 * 60_000,
      maxRetries: 0,
    });
    transport = {
      stream: (params) => client.messages.stream(params).finalMessage(),
      create: (params) => client.messages.create(params),
    };
  }
  const { stream, create } = transport;
  /** Stream by default; retry once without streaming only on the gateway's streaming 403. */
  const sendMessage: Send = async (params) => {
    try {
      return await stream(params);
    } catch (err) {
      if (!isStreamForbidden(err)) throw err;
      return create(params);
    }
  };
  /** Models that rejected forced tool_choice during this process (beyond the known NO_FORCED_TOOL_CHOICE set). */
  const learnedNoForce = new Set<string>();

  return {
    async complete(r: AdapterRequest): Promise<AdapterResponse> {
      const forceTool = !!r.jsonSchema && !NO_FORCED_TOOL_CHOICE.has(r.model) && !learnedNoForce.has(r.model);
      let msg: MappableMessage;
      try {
        msg = await sendMessage(buildAnthropicParams(r, { forceTool }));
      } catch (err) {
        if (!forceTool || !isForcedToolChoiceRejection(err)) throw err;
        learnedNoForce.add(r.model);
        msg = await sendMessage(buildAnthropicParams(r, { forceTool: false }));
      }
      return mapAnthropicMessage(msg, r.jsonSchema?.name);
    },

    async embed(): Promise<never> {
      throw new Error('embeddings are not supported on the anthropic adapter');
    },
  };
}
