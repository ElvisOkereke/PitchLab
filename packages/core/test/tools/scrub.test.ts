import { describe, expect, it } from 'vitest';
import { errorMessage, scrubError, scrubSecrets } from '../../src/tools/scrub';

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

  it('strips userinfo from any scheme, up to the last @ before the path (D2-R2)', () => {
    expect(scrubSecrets('redis://:pw@cache:6379/0 down')).toBe('redis://cache:6379/0 down');
    expect(scrubSecrets('amqp://u:p@mq.test/vh?heartbeat=5')).toBe('amqp://mq.test/vh');
    expect(scrubSecrets('custom+x://a@b:c@host.test/p?q=1#f')).toBe('custom+x://host.test/p');
    expect(scrubSecrets('https://us@er:p@ss@host.test/x')).toBe('https://host.test/x');
    expect(scrubSecrets('ok https://host.test then')).toBe('ok https://host.test then');
    expect(scrubSecrets('weird://[bad/host')).toBe('weird://[bad/host'); // regex fallback when URL() rejects it, no userinfo
  });

  it('fails closed when URL() rejects a URL that holds an @ (D2-R3)', () => {
    for (const u of ['postgres://u:pa/ss@host:5433/db', 'postgres://u:p#w@host/db', 'postgres://u:p?w@host/db', 'weird://%zz@[bad/host']) {
      const out = scrubSecrets(`connect ${u} refused`);
      expect(out, u).toBe(`connect ${u.split('://')[0]}://[redacted] refused`);
    }
    expect(scrubSecrets('connect postgres://bcg:hunter2@127.0.0.1:5433/bcg refused')).toBe('connect postgres://127.0.0.1:5433/bcg refused');
  });

  it('errorMessage cuts the message to 16 KB before scrubbing (D2-R3)', () => {
    expect(errorMessage(new Error('x '.repeat(20_000))).length).toBeLessThanOrEqual(16_384);
    expect(scrubError('y '.repeat(20_000)).length).toBeLessThanOrEqual(16_384);
    expect(scrubError('token=abc')).toBe(`token=${R}`);
  });

  it('redacts the extended assignment keywords (D2-R2)', () => {
    for (const [input, out] of [
      ['cookie=abc123', `cookie=${R}`], ['Set-Cookie: sid=xyz; Path=/', `Set-Cookie: ${R}; Path=/`], ['session: s3ss', `session: ${R}`],
      ['auth=u:p', `auth=${R}`], ['credentials: "c"', `credentials: ${R}`], ['pwd=hunter2', `pwd=${R}`],
      ['private_key=-----BEGIN', `private_key=${R}`], ['signature=abc', `signature=${R}`], ['refresh-token: r1', `refresh-token: ${R}`],
      ['access_key=AK1', `access_key=${R}`], ['client_secret=cs', `client_secret=${R}`],
    ]) expect(scrubSecrets(input!), input).toBe(out);
  });

  it('redacts an unterminated quoted value to the end of the line (D2-R2)', () => {
    expect(scrubSecrets('password: "abc def\nnext line')).toBe(`password: ${R}\nnext line`);
    expect(scrubSecrets(`token='${'x'.repeat(600)}'`)).toBe(`token=${R}`); // closing quote beyond the cap
  });

  it('redacts JWTs (D2-R2)', () => {
    expect(scrubSecrets('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.sig_x-1 rejected')).toBe(`jwt ${R} rejected`);
    expect(scrubSecrets('eyJhbGciOiJub25lIn0.eyJzdWIiOiJvIn0.')).toBe(R);
  });

  it('errorMessage scrubs the message of anything thrown', () => {
    expect(errorMessage(new Error('bad api_key=zzz'))).toBe(`bad api_key=${R}`);
    expect(errorMessage('Bearer abc')).toBe(`Bearer ${R}`);
    expect(errorMessage(new Error('503 Service Unavailable at harvest'))).toBe('503 Service Unavailable at harvest');
  });

  it('is linear: 1MB hostile inputs finish well under a second', () => {
    const MB = 1_000_000;
    const inputs = [
      'a'.repeat(MB), 'a1'.repeat(MB / 2), 'http://'.repeat(MB / 7), 'https://x@'.repeat(MB / 10), 'token='.repeat(MB / 6),
      'token:"'.repeat(MB / 7), 'Bearer '.repeat(MB / 7), 'Authorization: '.repeat(MB / 15), 'sk-'.repeat(MB / 3),
      'a1-'.repeat(MB / 3), `${'a'.repeat(23)} `.repeat(MB / 24), 'postgres://u:'.repeat(MB / 13), '?'.repeat(MB),
      'a:'.repeat(MB / 2), 'ab+'.repeat(MB / 3), 'x://@'.repeat(MB / 5), 'password="'.repeat(MB / 10), `token='${'z'.repeat(MB)}`,
      'eyJ'.repeat(MB / 3), 'eyJa.'.repeat(MB / 5), 'eyJa '.repeat(MB / 5), 'cookie='.repeat(MB / 7), 'session: "'.repeat(MB / 10),
      'eyJ-'.repeat(MB / 4), 'x-eyJ'.repeat(MB / 5), '.eyJ-'.repeat(MB / 5), 'eyJa.a-'.repeat(MB / 7), 'eyJa.-eyJ'.repeat(MB / 9),
    ];
    for (const s of inputs) {
      const t = performance.now();
      scrubSecrets(s);
      expect(performance.now() - t, s.slice(0, 20)).toBeLessThan(1000);
    }
  });
});
