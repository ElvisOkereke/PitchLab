import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildAnthropicParams, mapAnthropicMessage } from '../../src/llm/anthropic';

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
});

describe('buildAnthropicParams', () => {
  const schema = { type: 'object', properties: { pass: { type: 'boolean' } }, required: ['pass'] };

  // Live run 2026-10-17: claude-opus-5-5 and claude-sonnet-5-5 return 400
  // 'tool_choice: type "tool" and "any" are not supported for this model.'
  it('never forces tool_choice for structured output; uses auto with one call and names the tool in the system prompt', () => {
    const params = buildAnthropicParams({
      model: 'claude-opus-5-5',
      system: 'You are a judge.',
      messages: [{ role: 'user', content: 'Judge it.' }],
      maxTokens: 8000,
      jsonSchema: { name: 'verdict', schema },
    });
    expect(params.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    expect(params.tools).toEqual([expect.objectContaining({ name: 'verdict', input_schema: schema })]);
    expect(params.system).toContain('You are a judge.');
    expect(params.system).toContain('`verdict` tool');
  });

  it('adds the tool instruction as the system prompt when none was given', () => {
    const params = buildAnthropicParams({
      model: 'claude-haiku-5-5',
      messages: [{ role: 'user', content: 'Judge it.' }],
      maxTokens: 8000,
      jsonSchema: { name: 'verdict', schema },
    });
    expect(params.system).toContain('`verdict` tool');
  });

  it('leaves plain and research requests without tool_choice', () => {
    const plain = buildAnthropicParams({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });
    expect(plain.tool_choice).toBeUndefined();
    expect(plain.tools).toBeUndefined();
    expect(plain.system).toBeUndefined();
    const research = buildAnthropicParams({
      model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'find' }], maxTokens: 100, webSearch: { maxUses: 2 },
    });
    expect(research.tool_choice).toBeUndefined();
    expect(research.tools).toEqual([expect.objectContaining({ name: 'web_search', max_uses: 2 })]);
  });
});
