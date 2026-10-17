import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mapAnthropicMessage } from '../../src/llm/anthropic';

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
