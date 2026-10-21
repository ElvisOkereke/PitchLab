// createDb with a postgres:// URL: the pg.Pool gets the shared pgPoolConfig settings. pg is mocked; nothing connects.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pools = vi.hoisted(() => [] as { config: Record<string, unknown>; handlers: Record<string, (err: Error) => void> }[]);

vi.mock('pg', () => {
  class Pool {
    handlers: Record<string, (err: Error) => void> = {};
    constructor(public config: Record<string, unknown>) {
      pools.push(this);
    }
    on(event: string, fn: (err: Error) => void) {
      this.handlers[event] = fn;
      return this;
    }
  }
  return { default: { Pool } };
});
vi.mock('drizzle-orm/node-postgres', () => ({ drizzle: (client: unknown) => ({ $client: client }) }));

const { createDb } = await import('../../src/db/client');

const PASSWORD = 'hunter2pw';
const REMOTE = `postgresql://postgres.abcdefgh:${PASSWORD}@aws-0-ca-central-1.pooler.supabase.com:5432/postgres`;

describe('createDb (postgres)', () => {
  beforeEach(() => {
    pools.length = 0;
    vi.stubEnv('DATABASE_SSL', '');
    vi.stubEnv('DATABASE_SSL_CA', '');
    vi.stubEnv('DATABASE_POOL_MAX', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('builds the pool from pgPoolConfig: verified TLS for a remote host, URL TLS params removed, max 4 by default', async () => {
    await createDb(`${REMOTE}?sslmode=no-verify`);
    expect(pools).toHaveLength(1);
    expect(pools[0]!.config).toEqual({
      connectionString: REMOTE,
      ssl: { rejectUnauthorized: true },
      max: 4,
      connectionTimeoutMillis: 15000,
      idleTimeoutMillis: 30000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
    });
  });

  it('reads DATABASE_SSL and DATABASE_POOL_MAX from the environment', async () => {
    vi.stubEnv('DATABASE_SSL', 'disable');
    vi.stubEnv('DATABASE_POOL_MAX', '2');
    await createDb(REMOTE);
    expect(pools[0]!.config).toMatchObject({ ssl: false, max: 2 });
  });

  it('rejects an invalid DATABASE_SSL before creating a pool, without the URL in the message', async () => {
    vi.stubEnv('DATABASE_SSL', 'require');
    const err = await createDb(REMOTE).then(() => null, (e: Error) => e);
    expect(err?.message).toBe('DATABASE_SSL must be one of auto, verify, disable');
    expect(pools).toHaveLength(0);
  });

  it('attaches an idle-client error listener that logs a fixed message and never throws', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await createDb(REMOTE);
    const onError = pools[0]!.handlers.error;
    expect(onError).toBeTypeOf('function');
    expect(() => onError!(new Error(`connection to ${REMOTE} terminated`))).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('database pool: idle client error');
    expect(JSON.stringify(log.mock.calls)).not.toContain(PASSWORD);
  });
});
