import { describe, it, expect, vi } from 'vitest';

const create = vi.fn();
vi.mock('openai', () => ({
  default: class { chat = { completions: { create } }; embeddings = { create: vi.fn() }; },
}));

import { createOpenAIAdapter } from '../../src/llm/openai';

const req = { model: 'gpt-6-sol', messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 8000 };
const reply = (finish_reason: string) => ({
  choices: [{ message: { content: '{"n":1}' }, finish_reason }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
});

describe('createOpenAIAdapter truncation', () => {
  it('flags finish_reason length as truncated', async () => {
    create.mockResolvedValueOnce(reply('length'));
    const res = await createOpenAIAdapter({ baseURL: 'http://x', key: 'k' }).complete(req);
    expect(res.truncated).toBe(true);
  });

  it('does not flag a normal stop', async () => {
    create.mockResolvedValueOnce(reply('stop'));
    const res = await createOpenAIAdapter({ baseURL: 'http://x', key: 'k' }).complete(req);
    expect(res.truncated).toBeFalsy();
  });
});
