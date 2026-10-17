import { loadEnv } from '../../src/config/env';

it('applies defaults', () => {
  const env = loadEnv({ LLM_API_KEY: 'k' });
  expect(env.LLM_ANTHROPIC_BASE_URL).toBe('https://api.fuelix.ai');
  expect(env.LLM_OPENAI_BASE_URL).toBe('https://api.fuelix.ai/v1');
  expect(env.DATABASE_URL).toBe('pglite://.data/pglite');
  expect(env.LLM_MAX_CONCURRENCY).toBe(4);
  expect(env.MODEL_OVERRIDES).toEqual({});
});
it('names missing vars without leaking values', () => {
  expect(() => loadEnv({ LLM_MAX_CONCURRENCY: 'abc' })).toThrow(/LLM_API_KEY/);
});
it('parses MODEL_OVERRIDES JSON', () => {
  expect(loadEnv({ LLM_API_KEY: 'k', MODEL_OVERRIDES: '{"gate":"gemini-3.1-pro"}' }).MODEL_OVERRIDES).toEqual({ gate: 'gemini-3.1-pro' });
});
