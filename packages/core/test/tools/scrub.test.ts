import { describe, expect, it } from 'vitest';
import { scrubSecrets } from '../../src/tools/scrub';

const R = '[redacted]';

describe('scrubSecrets', () => {
  it('leaves ordinary error messages unchanged', () => {
    for (const s of [
      '503 Service Unavailable at harvest',
      'Model config: gate model (claude-opus-5-5) must be a different family from ideate (claude-opus-5-5)',
      'Structured output failed validation after 2 attempts: summary.price.amount is required',
      'fetch failed: ECONNRESET',
      '',
    ]) expect(scrubSecrets(s)).toBe(s);
  });

  it('redacts bearer tokens and Authorization headers', () => {
    expect(scrubSecrets('401 for Bearer abc.def.ghi on call')).toBe(`401 for Bearer ${R} on call`);
    expect(scrubSecrets('sent Authorization: Basic dXNlcjpwYXNz\nnext line')).toBe(`sent Authorization: ${R}\nnext line`);
    expect(scrubSecrets('{"authorization":"token xyz"}')).toBe(`{"authorization":"${R}"}`);
  });

  it('redacts provider key shapes', () => {
    for (const key of [
      'sk-ant-api03-abcdEFGH1234', 'sk-proj-x1y2z3w4v5', 'xoxb-1234-5678-abcdef', 'ghp_abcdefghij0123456789ABCD',
      'github_pat_11ABCDEFG0123456789_abcdef', 'AKIAIOSFODNN7EXAMPLE', 'AIzaSyA1b2C3d4E5f6G7h8I9j0',
    ]) {
      const out = scrubSecrets(`key ${key} rejected`);
      expect(out, key).toBe(`key ${R} rejected`);
    }
  });

  it('redacts any 24+ char token with letters and digits, but not long plain words', () => {
    expect(scrubSecrets('token a1B2c3D4e5F6g7H8i9J0k1L2 end')).toBe(`token ${R} end`);
    expect(scrubSecrets('id 3f2a9c1e-7b4d-4e8a-9f00-1a2b3c4d5e6f')).toBe(`id ${R}`);
    expect(scrubSecrets('deep-case-claims-verification-step')).toBe('deep-case-claims-verification-step');
    expect(scrubSecrets('abc123def456ghi789jkl01')).toBe('abc123def456ghi789jkl01'); // 23 chars
    expect(scrubSecrets('------------------------------')).toBe('------------------------------');
  });

  it('strips URL userinfo, query strings and fragments', () => {
    expect(scrubSecrets('GET https://user:pw@host.test/path?x=1 failed')).toBe('GET https://host.test/path failed');
    expect(scrubSecrets('see http://api.test/v1/items?api_key=abc&q=2#frag.')).toBe('see http://api.test/v1/items');
    expect(scrubSecrets('connect postgres://bcg:hunter2@127.0.0.1:5433/bcg refused')).toBe('connect postgres://127.0.0.1:5433/bcg refused');
    expect(scrubSecrets('https://news.example/item/1')).toBe('https://news.example/item/1');
  });

  it('redacts api_key / token / secret / password assignments', () => {
    expect(scrubSecrets('api_key=abc123 retry')).toBe(`api_key=${R} retry`);
    expect(scrubSecrets('apikey: "hunter2"')).toBe(`apikey: ${R}`);
    expect(scrubSecrets('API-KEY=zzz')).toBe(`API-KEY=${R}`);
    expect(scrubSecrets('access_token=abc, next')).toBe(`access_token=${R}, next`);
    expect(scrubSecrets("password: 'p w'")).toBe(`password: ${R}`);
    expect(scrubSecrets('client secret=shh;')).toBe(`client secret=${R};`);
    expect(scrubSecrets('token limit exceeded')).toBe('token limit exceeded');
  });

  it('is linear: 1MB hostile inputs finish well under a second', () => {
    const MB = 1_000_000;
    const inputs = [
      'a'.repeat(MB), 'a1'.repeat(MB / 2), 'http://'.repeat(MB / 7), 'https://x@'.repeat(MB / 10), 'token='.repeat(MB / 6),
      'token:"'.repeat(MB / 7), 'Bearer '.repeat(MB / 7), 'Authorization: '.repeat(MB / 15), 'sk-'.repeat(MB / 3),
      'a1-'.repeat(MB / 3), `${'a'.repeat(23)} `.repeat(MB / 24), 'postgres://u:'.repeat(MB / 13), '?'.repeat(MB),
    ];
    for (const s of inputs) {
      const t = performance.now();
      scrubSecrets(s);
      expect(performance.now() - t, s.slice(0, 20)).toBeLessThan(1000);
    }
  });
});
