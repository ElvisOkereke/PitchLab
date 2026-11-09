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

test('YOUTUBE_API_KEY is optional and empty counts as unset', () => {
  expect(loadEnv({ LLM_API_KEY: 'k' }).YOUTUBE_API_KEY).toBeUndefined();
  expect(loadEnv({ LLM_API_KEY: 'k', YOUTUBE_API_KEY: '' }).YOUTUBE_API_KEY).toBeUndefined();
  expect(loadEnv({ LLM_API_KEY: 'k', YOUTUBE_API_KEY: 'abc' }).YOUTUBE_API_KEY).toBe('abc');
});

test('BLUESKY_HANDLE and BLUESKY_APP_PASSWORD are optional and empty counts as unset', () => {
  const e = loadEnv({ LLM_API_KEY: 'k', BLUESKY_HANDLE: '', BLUESKY_APP_PASSWORD: '' });
  expect(e.BLUESKY_HANDLE).toBeUndefined();
  expect(e.BLUESKY_APP_PASSWORD).toBeUndefined();
  expect(loadEnv({ LLM_API_KEY: 'k', BLUESKY_HANDLE: 'me.bsky.social', BLUESKY_APP_PASSWORD: 'abcd-efgh' })).toMatchObject({ BLUESKY_HANDLE: 'me.bsky.social', BLUESKY_APP_PASSWORD: 'abcd-efgh' });
});

test('SCRAPER_PROVIDER and SCRAPER_API_KEY are optional; the provider is one of three', () => {
  const e = loadEnv({ LLM_API_KEY: 'k', SCRAPER_PROVIDER: '', SCRAPER_API_KEY: '' });
  expect(e.SCRAPER_PROVIDER).toBeUndefined();
  expect(e.SCRAPER_API_KEY).toBeUndefined();
  for (const p of ['scrapingbee', 'zenrows', 'apify']) expect(loadEnv({ LLM_API_KEY: 'k', SCRAPER_PROVIDER: p, SCRAPER_API_KEY: 'x' }).SCRAPER_PROVIDER).toBe(p);
  expect(() => loadEnv({ LLM_API_KEY: 'k', SCRAPER_PROVIDER: 'brightdata', SCRAPER_API_KEY: 'sekrit' })).toThrow(/SCRAPER_PROVIDER/);
  try {
    loadEnv({ LLM_API_KEY: 'k', SCRAPER_PROVIDER: 'nope', SCRAPER_API_KEY: 'sekrit-value' });
  } catch (e) {
    expect(String(e)).not.toContain('sekrit-value');
  }
});
