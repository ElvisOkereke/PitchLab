// getDb builds its pg.Pool from core's pgPoolConfig and the web env. pg is mocked; nothing connects.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pools = vi.hoisted(() => [] as { config: Record<string, unknown>; handlers: Record<string, () => void> }[]);

vi.mock('pg', () => {
  class Pool {
    handlers: Record<string, () => void> = {};
    constructor(public config: Record<string, unknown>) {
      pools.push(this);
    }
    on(event: string, fn: () => void) {
      this.handlers[event] = fn;
      return this;
    }
  }
  return { default: { Pool } };
});
vi.mock('drizzle-orm/node-postgres', () => ({ drizzle: (client: unknown) => ({ $client: client }) }));

const REMOTE = 'postgresql://postgres.abcdefgh:hunter2pw@aws-0-ca-central-1.pooler.supabase.com:5432/postgres';
const cache = globalThis as unknown as { __bcgDb?: unknown };

async function freshGetDb() {
  vi.resetModules();
  delete cache.__bcgDb;
  return (await import('@/lib/db')).getDb;
}

describe('getDb', () => {
  beforeEach(() => {
    pools.length = 0;
    vi.stubEnv('DATABASE_URL', `${REMOTE}?sslmode=require`);
    vi.stubEnv('OWNER_PASSWORD_HASH', 'scrypt:32768:8:1:c2FsdHNhbHRzYWx0c2FsdA:a2V5a2V5a2V5a2V5');
    vi.stubEnv('SESSION_SECRET', 'x'.repeat(43));
    vi.stubEnv('DATABASE_SSL', '');
    vi.stubEnv('DATABASE_SSL_CA', '');
    vi.stubEnv('DATABASE_POOL_MAX', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    delete cache.__bcgDb;
  });

  it('builds the pool with verified TLS for a remote host, URL TLS params removed, max 5 by default', async () => {
    const getDb = await freshGetDb();
    getDb();
    expect(pools).toHaveLength(1);
    expect(pools[0]!.config).toEqual({
      connectionString: REMOTE,
      ssl: { rejectUnauthorized: true },
      max: 5,
      connectionTimeoutMillis: 15000,
      idleTimeoutMillis: 30000,
      keepAlive: true,
    });
  });

  it('passes DATABASE_SSL and DATABASE_POOL_MAX through, and reuses one pool', async () => {
    vi.stubEnv('DATABASE_SSL', 'disable');
    vi.stubEnv('DATABASE_POOL_MAX', '3');
    const getDb = await freshGetDb();
    expect(getDb()).toBe(getDb());
    expect(pools).toHaveLength(1);
    expect(pools[0]!.config).toMatchObject({ ssl: false, max: 3 });
  });

  it('keeps the idle-client error listener (fixed message, no throw)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const getDb = await freshGetDb();
    getDb();
    expect(() => pools[0]!.handlers.error!()).not.toThrow();
    expect(log).toHaveBeenCalledWith('database pool: idle client error');
  });
});
