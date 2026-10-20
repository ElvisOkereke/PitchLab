import { describe, expect, it } from 'vitest';
import { parseWebEnv } from '@/lib/env';

const ok = {
  DATABASE_URL: 'postgres://bcg:pw-value-123@127.0.0.1:5433/bcg',
  OWNER_PASSWORD_HASH: 'scrypt:32768:8:1:c2FsdHNhbHRzYWx0c2FsdA:a2V5a2V5a2V5a2V5',
  SESSION_SECRET: 'x'.repeat(43),
};

function messageOf(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    return String(e);
  }
  throw new Error('expected a throw');
}

describe('parseWebEnv', () => {
  it('parses a valid env with defaults', () => {
    const env = parseWebEnv({ ...ok, NODE_ENV: 'development' });
    expect(env).toEqual({
      DATABASE_URL: ok.DATABASE_URL,
      OWNER_PASSWORD_HASH: ok.OWNER_PASSWORD_HASH,
      SESSION_SECRET: ok.SESSION_SECRET,
      TRUST_PROXY_HOPS: 0,
      ALLOWED_ORIGINS: [],
      COOKIE_SECURE: false,
    });
  });

  it('accepts postgresql:// and parses hops, origins and the cookie flag', () => {
    const env = parseWebEnv({
      ...ok, DATABASE_URL: 'postgresql://a@b/c', TRUST_PROXY_HOPS: '1', ALLOWED_ORIGINS: ' a.example.com , ,b.test:3000 ', COOKIE_SECURE: 'true',
    });
    expect(env.TRUST_PROXY_HOPS).toBe(1);
    expect(env.ALLOWED_ORIGINS).toEqual(['a.example.com', 'b.test:3000']);
    expect(env.COOKIE_SECURE).toBe(true);
    expect(env.DATABASE_URL).toBe('postgresql://a@b/c');
  });

  it('defaults COOKIE_SECURE to true in production and lets it be turned off', () => {
    expect(parseWebEnv({ ...ok, NODE_ENV: 'production' }).COOKIE_SECURE).toBe(true);
    expect(parseWebEnv({ ...ok, NODE_ENV: 'production', COOKIE_SECURE: 'false' }).COOKIE_SECURE).toBe(false);
  });

  it('rejects pglite URLs and short secrets, naming vars only', () => {
    expect(() => parseWebEnv({ ...ok, DATABASE_URL: 'pglite://.data/pglite' })).toThrow(/DATABASE_URL/);
    expect(() => parseWebEnv({ ...ok, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
    expect(messageOf(() => parseWebEnv({ ...ok, SESSION_SECRET: 'short' }))).not.toContain('short');
    expect(messageOf(() => parseWebEnv({ ...ok, DATABASE_URL: 'pglite://.data/secret-dir' }))).not.toContain('secret-dir');
  });

  it('rejects a $-style or malformed password hash without echoing it', () => {
    const bad = '$scrypt$N=32768$abc$def';
    expect(() => parseWebEnv({ ...ok, OWNER_PASSWORD_HASH: bad })).toThrow(/OWNER_PASSWORD_HASH/);
    expect(messageOf(() => parseWebEnv({ ...ok, OWNER_PASSWORD_HASH: bad }))).not.toContain('abc');
  });

  it('rejects missing variables and out-of-range hops', () => {
    expect(() => parseWebEnv({})).toThrow(/DATABASE_URL.*OWNER_PASSWORD_HASH.*SESSION_SECRET/s);
    for (const hops of ['4', '-1', '1.5', 'abc']) expect(() => parseWebEnv({ ...ok, TRUST_PROXY_HOPS: hops })).toThrow(/TRUST_PROXY_HOPS/);
  });

  it('never puts any value in the error message', () => {
    const msg = messageOf(() => parseWebEnv({ DATABASE_URL: 'mysql://u:hunter2@h/d', OWNER_PASSWORD_HASH: 'hunter2', SESSION_SECRET: 'hunter2' }));
    expect(msg).not.toContain('hunter2');
  });
});
