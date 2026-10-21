import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pgPoolConfig } from '../../src/db/pg-config';

const PASSWORD = 'hunter2pw';
const REMOTE = `postgresql://postgres.abcdefgh:${PASSWORD}@aws-0-ca-central-1.pooler.supabase.com:5432/postgres`;
const LOCAL = `postgres://bcg:${PASSWORD}@127.0.0.1:5433/bcg`;
const CA_PATH = '/secret-dir/supabase-ca.pem';
const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';
const readFile = (p: string) => {
  if (p === CA_PATH) return PEM;
  throw new Error(`ENOENT: no such file, open '${p}'`);
};
const base = { defaultMax: 4, readFile };

function messageOf(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    return String(e instanceof Error ? e.message : e);
  }
  throw new Error('expected a throw');
}

describe('pgPoolConfig: URL hygiene', () => {
  it('strips every TLS query parameter and keeps the others in order', () => {
    const url = `${REMOTE}?sslmode=no-verify&application_name=bcg&ssl=0&sslrootcert=/x/ca.pem&options=-c%20search_path%3Dpublic`
      + '&sslcert=/x/c.pem&sslkey=/x/k.pem&sslpassword=pw&uselibpqcompat=true&SSLMODE=disable';
    expect(pgPoolConfig(url, base).connectionString).toBe(`${REMOTE}?application_name=bcg&options=-c%20search_path%3Dpublic`);
  });

  it('drops the ? when only TLS parameters were present, and leaves a URL without a query untouched', () => {
    expect(pgPoolConfig(`${REMOTE}?sslmode=require`, base).connectionString).toBe(REMOTE);
    expect(pgPoolConfig(REMOTE, base).connectionString).toBe(REMOTE);
    expect(pgPoolConfig(`${LOCAL}?connect_timeout=5`, base).connectionString).toBe(`${LOCAL}?connect_timeout=5`);
  });

  it('real pg: URL sslmode can no longer override the env-derived ssl setting', () => {
    const require = createRequire(import.meta.url);
    const ConnectionParameters = require('pg/lib/connection-parameters') as new (c: object) => { ssl: unknown; host: string; password: string };
    const verified = new ConnectionParameters(pgPoolConfig(`${REMOTE}?sslmode=no-verify`, base));
    expect(verified.ssl).toEqual({ rejectUnauthorized: true });
    expect(verified.host).toBe('aws-0-ca-central-1.pooler.supabase.com');
    expect(verified.password).toBe(PASSWORD);
    const plain = new ConnectionParameters(pgPoolConfig(`${LOCAL}?sslmode=verify-full`, base));
    expect(plain.ssl).toBe(false);
  });
});

describe('pgPoolConfig: DATABASE_SSL', () => {
  it('auto (the default) uses plain TCP for each local host form', () => {
    for (const url of [
      'postgres://u:p@localhost:5432/d',
      'postgres://u:p@LOCALHOST/d',
      'postgres://u:p@127.0.0.1:5433/d',
      'postgres://u:p@[::1]:5432/d',
      'postgresql://u:p@postgres.railway.internal:5432/railway',
    ]) {
      expect(pgPoolConfig(url, base).ssl, url).toBe(false);
      expect(pgPoolConfig(url, { ...base, ssl: 'auto' }).ssl, url).toBe(false);
      expect(pgPoolConfig(url, { ...base, ssl: '  ' }).ssl, url).toBe(false);
    }
  });

  it('auto uses verified TLS for a remote host (Supabase pooler)', () => {
    expect(pgPoolConfig(REMOTE, base).ssl).toEqual({ rejectUnauthorized: true });
    expect(pgPoolConfig(REMOTE, { ...base, ssl: 'auto' }).ssl).toEqual({ rejectUnauthorized: true });
  });

  it('auto follows a host query parameter, which pg prefers over the URL host', () => {
    expect(pgPoolConfig('postgres://u:p@localhost/d?host=db.example.com', base).ssl).toEqual({ rejectUnauthorized: true });
    expect(pgPoolConfig('postgres://u:p@db.example.com/d?host=localhost', base).ssl).toBe(false);
  });

  it('auto treats a look-alike host as remote', () => {
    expect(pgPoolConfig('postgres://u:p@localhost.example.com/d', base).ssl).toEqual({ rejectUnauthorized: true });
    expect(pgPoolConfig('postgres://u:p@railway.internal.evil.com/d', base).ssl).toEqual({ rejectUnauthorized: true });
  });

  it('auto adds the CA for a remote host and ignores it for a local host', () => {
    expect(pgPoolConfig(REMOTE, { ...base, sslCa: CA_PATH }).ssl).toEqual({ rejectUnauthorized: true, ca: PEM });
    expect(pgPoolConfig(LOCAL, { ...base, sslCa: CA_PATH }).ssl).toBe(false);
  });

  it('verify forces verified TLS, even on a local host, and adds the CA when given', () => {
    expect(pgPoolConfig(LOCAL, { ...base, ssl: 'verify' }).ssl).toEqual({ rejectUnauthorized: true });
    expect(pgPoolConfig(REMOTE, { ...base, ssl: 'verify', sslCa: CA_PATH }).ssl).toEqual({ rejectUnauthorized: true, ca: PEM });
  });

  it('disable uses plain TCP, even for a remote host, and ignores the CA', () => {
    expect(pgPoolConfig(REMOTE, { ...base, ssl: 'disable' }).ssl).toBe(false);
    expect(pgPoolConfig(REMOTE, { ...base, ssl: 'disable', sslCa: CA_PATH }).ssl).toBe(false);
  });

  it('has no mode that encrypts without verifying: require, no-verify and other values throw', () => {
    for (const bad of ['require', 'no-verify', 'prefer', 'true', 'VERIFY', 'off']) {
      expect(() => pgPoolConfig(REMOTE, { ...base, ssl: bad }), bad).toThrow('DATABASE_SSL must be one of auto, verify, disable');
    }
  });

  it('error messages never contain the URL, password or the bad value', () => {
    const msg = messageOf(() => pgPoolConfig(REMOTE, { ...base, ssl: 'hunter2-mode' }));
    expect(msg).toBe('DATABASE_SSL must be one of auto, verify, disable');
    expect(msg).not.toContain(PASSWORD);
    expect(msg).not.toContain('hunter2-mode');
    expect(msg).not.toContain('supabase');
  });
});

describe('pgPoolConfig: DATABASE_SSL_CA', () => {
  it('rejects a relative path without echoing it or the URL', () => {
    const msg = messageOf(() => pgPoolConfig(REMOTE, { ...base, sslCa: 'secret-dir/ca.pem' }));
    expect(msg).toBe('DATABASE_SSL_CA must be an absolute path');
    expect(msg).not.toContain('secret-dir');
    expect(msg).not.toContain(PASSWORD);
  });

  it('reports an unreadable file without the path or the URL', () => {
    const msg = messageOf(() => pgPoolConfig(REMOTE, { ...base, sslCa: '/secret-dir/missing.pem' }));
    expect(msg).toBe('DATABASE_SSL_CA could not be read');
    expect(msg).not.toContain('secret-dir');
    expect(msg).not.toContain('missing.pem');
    expect(msg).not.toContain(PASSWORD);
  });

  it('does not read the file when TLS is off', () => {
    const reads: string[] = [];
    const spy = (p: string) => { reads.push(p); return PEM; };
    pgPoolConfig(LOCAL, { ...base, sslCa: CA_PATH, readFile: spy });
    pgPoolConfig(REMOTE, { ...base, ssl: 'disable', sslCa: CA_PATH, readFile: spy });
    expect(reads).toEqual([]);
    pgPoolConfig(REMOTE, { ...base, sslCa: CA_PATH, readFile: spy });
    expect(reads).toEqual([CA_PATH]);
  });

  it('treats a blank value as unset', () => {
    expect(pgPoolConfig(REMOTE, { ...base, sslCa: '' }).ssl).toEqual({ rejectUnauthorized: true });
  });
});

describe('pgPoolConfig: DATABASE_POOL_MAX and timeouts', () => {
  it('defaults to defaultMax, also for a blank value', () => {
    expect(pgPoolConfig(LOCAL, base).max).toBe(4);
    expect(pgPoolConfig(LOCAL, { ...base, defaultMax: 5, poolMax: '' }).max).toBe(5);
  });

  it('accepts an integer from 1 to 20', () => {
    expect(pgPoolConfig(LOCAL, { ...base, poolMax: '1' }).max).toBe(1);
    expect(pgPoolConfig(LOCAL, { ...base, poolMax: ' 3 ' }).max).toBe(3);
    expect(pgPoolConfig(LOCAL, { ...base, poolMax: '20' }).max).toBe(20);
  });

  it('rejects anything else with a message naming the variable, not the value', () => {
    for (const bad of ['0', '21', '-1', '2.5', 'abc', '1e1', '0x5', '99999']) {
      const msg = messageOf(() => pgPoolConfig(REMOTE, { ...base, poolMax: bad }));
      expect(msg, bad).toBe('DATABASE_POOL_MAX must be an integer from 1 to 20');
      expect(msg).not.toContain(PASSWORD);
    }
  });

  it('sets the connection and idle timeouts and TCP keep-alive', () => {
    expect(pgPoolConfig(REMOTE, base)).toMatchObject({ connectionTimeoutMillis: 15000, idleTimeoutMillis: 30000, keepAlive: true });
  });
});

describe('no TLS mode disables certificate verification', () => {
  const repo = fileURLToPath(new URL('../../../../', import.meta.url));
  const SKIP = new Set(['node_modules', '.next']);

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return SKIP.has(e.name) ? [] : sources(full);
      return /\.(ts|tsx|js|mjs|cjs)$/.test(e.name) ? [full] : [];
    });
  }

  it('rejectUnauthorized is never set to false in packages/core/src or apps/web', () => {
    const files = [...sources(join(repo, 'packages', 'core', 'src')), ...sources(join(repo, 'apps', 'web'))];
    expect(files.length).toBeGreaterThan(50);
    const pattern = new RegExp(['reject', 'Unauthorized', String.raw`['"]?\s*[:=]\s*false`].join(''));
    const hits = files.filter((f) => pattern.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
