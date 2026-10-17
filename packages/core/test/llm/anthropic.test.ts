import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildAnthropicParams, createAnthropicAdapter, isForcedToolChoiceRejection, isStreamForbidden, mapAnthropicMessage,
} from '../../src/llm/anthropic';
import type { AdapterRequest } from '../../src/llm/types';

const fixture = JSON.parse(
  readFileSync(new URL('../helpers/fixtures/anthropic-websearch.json', import.meta.url), 'utf8'),
);

describe('mapAnthropicMessage', () => {
  it('maps a web-search message to text, deduped sources and usage', () => {
    const res = mapAnthropicMessage(fixture);
    expect(res.text).toBe(
      "I'll search for recent complaints about invoice reconciliation." +
        'Owners report spending hours each week matching invoices' +
        ', and tools built for enterprises are a poor fit.',
    );
    expect(res.sources).toEqual([
      {
        url: 'https://example.com/forum/invoices',
        title: 'Invoice reconciliation is killing me',
        citedText: 'I spend 6 hours every week matching invoices to bank lines.',
      },
      {
        url: 'https://example.org/blog/ap-automation',
        title: 'Why AP automation still fails SMBs',
        citedText: 'Enterprise AP suites assume a dedicated finance team.',
      },
    ]);
    expect(res.usage).toEqual({ inputTokens: 2100, outputTokens: 180, searchRequests: 1 });
    expect(res.json).toBeUndefined();
  });

  it('returns the named tool_use input as json', () => {
    const msg = {
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'verdict', input: { pass: true } }],
      usage: { input_tokens: 5, output_tokens: 7, server_tool_use: null },
    };
    const res = mapAnthropicMessage(msg as never, 'verdict');
    expect(res.json).toEqual({ pass: true });
    expect(res.sources).toEqual([]);
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 7, searchRequests: 0 });
  });

  it('counts cache-write and cache-read tokens as input tokens', () => {
    const msg = {
      content: [{ type: 'text', text: 'ok', citations: null }],
      usage: {
        input_tokens: 10, output_tokens: 3, server_tool_use: null,
        cache_creation_input_tokens: 2000, cache_read_input_tokens: 500,
      },
    };
    expect(mapAnthropicMessage(msg as never).usage).toEqual({ inputTokens: 2510, outputTokens: 3, searchRequests: 0 });
  });
});

const noCreate = vi.fn().mockRejectedValue(new Error('non-streaming path not expected'));
const schema = { type: 'object', properties: { pass: { type: 'boolean' } }, required: ['pass'] };
const structuredReq = (model: string, extra: Partial<AdapterRequest> = {}): AdapterRequest => ({
  model, system: 'You are a judge.', messages: [{ role: 'user', content: 'Judge it.' }], maxTokens: 8000,
  jsonSchema: { name: 'verdict', schema }, ...extra,
});

describe('buildAnthropicParams', () => {
  it('forces the schema tool when forceTool is set, with no extra instruction', () => {
    const params = buildAnthropicParams(structuredReq('claude-haiku-5-5'), { forceTool: true });
    expect(params.tool_choice).toEqual({ type: 'tool', name: 'verdict' });
    expect(params.tools).toEqual([expect.objectContaining({ name: 'verdict', input_schema: schema })]);
    expect(params.system).toBe('You are a judge.');
  });

  it('without forceTool uses auto with a single call and names the tool in the system prompt', () => {
    const params = buildAnthropicParams(structuredReq('claude-opus-5-5'), { forceTool: false });
    expect(params.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(params.system).toContain('You are a judge.');
    expect(params.system).toContain('`verdict` tool');
    const noSystem = buildAnthropicParams(structuredReq('claude-opus-5-5', { system: undefined }), { forceTool: false });
    expect(noSystem.system).toContain('`verdict` tool');
  });

  it('re-asserts the tool instruction in the latest user message on a re-ask (auto mode only)', () => {
    const messages: AdapterRequest['messages'] = [
      { role: 'user', content: 'Long stable prompt' },
      { role: 'assistant', content: '{}' },
      { role: 'user', content: 'Your output was invalid' },
    ];
    const auto = buildAnthropicParams(structuredReq('claude-opus-5-5', { messages }), { forceTool: false });
    expect(auto.messages[2]!.content).toContain('Your output was invalid');
    expect(auto.messages[2]!.content).toContain('`verdict` tool');
    const forced = buildAnthropicParams(structuredReq('claude-haiku-5-5', { messages }), { forceTool: true });
    expect(forced.messages[2]).toEqual({ role: 'user', content: 'Your output was invalid' });
  });

  // Live run 2026-10-17: Fuelix returns 400 "Model 'claude-opus-5-5' requires a cache_control breakpoint
  // on prompts of 1024 tokens or more."
  it('puts a cache_control breakpoint on the first user message only', () => {
    const params = buildAnthropicParams(structuredReq('claude-opus-5-5', {
      messages: [{ role: 'user', content: 'Long stable prompt' }, { role: 'assistant', content: '{}' }],
    }), { forceTool: false });
    expect(params.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Long stable prompt', cache_control: { type: 'ephemeral' } }],
    });
    expect(params.messages[1]).toEqual({ role: 'assistant', content: '{}' });
  });

  it('leaves plain and research requests without tool_choice or instruction', () => {
    const plain = buildAnthropicParams({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }, { forceTool: false });
    expect(plain.tool_choice).toBeUndefined();
    expect(plain.tools).toBeUndefined();
    expect(plain.system).toBeUndefined();
    const research = buildAnthropicParams({
      model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'find' }], maxTokens: 100, webSearch: { maxUses: 2 },
    }, { forceTool: false });
    expect(research.tool_choice).toBeUndefined();
    expect(research.tools).toEqual([expect.objectContaining({ name: 'web_search', max_uses: 2 })]);
  });

  it('refuses a request that carries both jsonSchema and webSearch', () => {
    expect(() => buildAnthropicParams(structuredReq('claude-haiku-5-5', { webSearch: { maxUses: 1 } }), { forceTool: true }))
      .toThrow(/both jsonSchema and webSearch/);
  });
});

describe('createAnthropicAdapter tool_choice fallback', () => {
  // Error text observed on the live run (claude-opus-5-5), delivered as an SSE error event.
  const rejection = () => new Error(
    '{"type":"error","error":{"message":"Error code: 400 - {\'type\': \'error\', \'error\': {\'type\': \'invalid_request_error\', ' +
      '\'message\': \'tool_choice: type \\"tool\\" and \\"any\\" are not supported for this model.\'}}","type":"anthropic.BadRequestError"}}',
  );
  const toolReply = {
    content: [{ type: 'tool_use', id: 't1', name: 'verdict', input: { pass: true } }],
    usage: { input_tokens: 1, output_tokens: 1, server_tool_use: null },
  };

  it('recognises the forced tool_choice rejection and nothing else', () => {
    expect(isForcedToolChoiceRejection(rejection())).toBe(true);
    expect(isForcedToolChoiceRejection(new Error('400 {"error":{"message":"max_tokens: too large"}}'))).toBe(false);
    expect(isForcedToolChoiceRejection('tool_choice not supported')).toBe(false);
  });

  it('on the rejection retries once with auto, then goes straight to auto for that model', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(rejection())
      .mockResolvedValue(toolReply);
    const adapter = createAnthropicAdapter({ baseURL: 'x', key: 'k', transport: { stream: send, create: noCreate } });

    expect((await adapter.complete(structuredReq('claude-new-model'))).json).toEqual({ pass: true });
    expect(send.mock.calls.map((c) => c[0].tool_choice.type)).toEqual(['tool', 'auto']);

    await adapter.complete(structuredReq('claude-new-model'));
    expect(send.mock.calls.map((c) => c[0].tool_choice.type)).toEqual(['tool', 'auto', 'auto']);

    // Other models are unaffected and still forced.
    await adapter.complete(structuredReq('claude-haiku-5-5'));
    expect(send.mock.calls[3]![0].tool_choice).toEqual({ type: 'tool', name: 'verdict' });
  });

  it('uses auto from the start for models known to reject forced tool_choice', async () => {
    const send = vi.fn().mockResolvedValue(toolReply);
    const adapter = createAnthropicAdapter({ baseURL: 'x', key: 'k', transport: { stream: send, create: noCreate } });
    await adapter.complete(structuredReq('claude-opus-5-5'));
    await adapter.complete(structuredReq('claude-sonnet-5-5'));
    expect(send.mock.calls.map((c) => c[0].tool_choice.type)).toEqual(['auto', 'auto']);
  });

  it('does not fall back on other errors', async () => {
    const send = vi.fn().mockRejectedValue(new Error('400 {"error":{"message":"max_tokens: too large"}}'));
    const adapter = createAnthropicAdapter({ baseURL: 'x', key: 'k', transport: { stream: send, create: noCreate } });
    await expect(adapter.complete(structuredReq('claude-haiku-5-5'))).rejects.toThrow('max_tokens: too large');
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('createAnthropicAdapter streaming 403 fallback', () => {
  // Live run 2026-10-17: Fuelix intermittently answered every streaming /v1/messages request (any claude
  // model) with this SSE error event while the same request without streaming succeeded.
  const streamForbidden = () => new Error(
    '{"type":"error","error":{"message":"Error code: 403 - {\'error\': \'forbidden\'}","type":"anthropic.PermissionDeniedError"}}',
  );
  const textReply = { content: [{ type: 'text', text: 'pong', citations: null }], usage: { input_tokens: 1, output_tokens: 1, server_tool_use: null } };
  const plainReq: AdapterRequest = { model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'ping' }], maxTokens: 50 };

  it('recognises only the streaming 403 forbidden error', () => {
    expect(isStreamForbidden(streamForbidden())).toBe(true);
    expect(isStreamForbidden(new Error('401 {"error":{"message":"invalid token"}}'))).toBe(false);
    expect(isStreamForbidden('Error code: 403 forbidden')).toBe(false);
  });

  it('retries the same params once without streaming when the stream is forbidden', async () => {
    const stream = vi.fn().mockRejectedValue(streamForbidden());
    const create = vi.fn().mockResolvedValue(textReply);
    const adapter = createAnthropicAdapter({ baseURL: 'x', key: 'k', transport: { stream, create } });
    expect((await adapter.complete(plainReq)).text).toBe('pong');
    expect(stream).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toEqual(stream.mock.calls[0]![0]);
  });

  it('does not use the non-streaming path for other errors, and surfaces a non-streaming failure', async () => {
    const create = vi.fn().mockRejectedValue(new Error('403 {"error":"forbidden"}'));
    const other = createAnthropicAdapter({
      baseURL: 'x', key: 'k', transport: { stream: vi.fn().mockRejectedValue(new Error('500 boom')), create },
    });
    await expect(other.complete(plainReq)).rejects.toThrow('500 boom');
    expect(create).not.toHaveBeenCalled();

    const both = createAnthropicAdapter({
      baseURL: 'x', key: 'k', transport: { stream: vi.fn().mockRejectedValue(streamForbidden()), create },
    });
    await expect(both.complete(plainReq)).rejects.toThrow('403 {"error":"forbidden"}');
    expect(create).toHaveBeenCalledTimes(1);
  });
});

