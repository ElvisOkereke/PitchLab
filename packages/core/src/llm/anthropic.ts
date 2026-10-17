import Anthropic from '@anthropic-ai/sdk';
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
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      searchRequests: msg.usage.server_tool_use?.web_search_requests ?? 0,
    },
  };
}

export function createAnthropicAdapter(opts: { baseURL: string; key: string }): ProviderAdapter {
  // apiKey: null stops the SDK picking up ANTHROPIC_API_KEY (which would win over the bearer token).
  const client = new Anthropic({
    baseURL: opts.baseURL,
    apiKey: null,
    authToken: opts.key,
    timeout: 15 * 60_000,
    maxRetries: 0,
  });

  return {
    async complete(r: AdapterRequest): Promise<AdapterResponse> {
      const tools: Anthropic.ToolUnion[] = [];
      const params: Anthropic.MessageCreateParamsNonStreaming = {
        model: r.model,
        max_tokens: r.maxTokens,
        messages: r.messages,
        ...(r.system ? { system: r.system } : {}),
      };
      if (r.jsonSchema) {
        tools.push({
          name: r.jsonSchema.name,
          description: `Return the ${r.jsonSchema.name} result as structured data.`,
          input_schema: r.jsonSchema.schema as Anthropic.Tool.InputSchema,
        });
        params.tool_choice = { type: 'tool', name: r.jsonSchema.name };
      }
      if (r.webSearch) {
        tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: r.webSearch.maxUses });
      }
      if (tools.length) params.tools = tools;

      const msg = await client.messages.stream(params).finalMessage();
      return mapAnthropicMessage(msg, r.jsonSchema?.name);
    },

    async embed(): Promise<never> {
      throw new Error('embeddings are not supported on the anthropic adapter');
    },
  };
}
