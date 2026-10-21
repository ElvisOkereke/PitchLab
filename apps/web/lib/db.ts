import 'server-only';
import type { Db } from '@bcg/core/db/client';
import { pgPoolConfig } from '@bcg/core/db/pg-config';
import * as schema from '@bcg/core/db/schema';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { webEnv } from './env';

// Cached on globalThis so dev hot reloads reuse one pool. Core's createDb is never imported here (only its type), so
// PGlite stays out of the web bundle; pg-config is web-safe.
const cache = globalThis as unknown as { __bcgDb?: Db };

/**
 * The shared Postgres connection with core's schema: a pg.Pool of at most DATABASE_POOL_MAX (default 5) clients,
 * TLS per DATABASE_SSL / DATABASE_SSL_CA (verified TLS for any non-local host).
 */
export function getDb(): Db {
  if (!cache.__bcgDb) {
    const env = webEnv();
    const pool = new pg.Pool(pgPoolConfig(env.DATABASE_URL, {
      ssl: env.DATABASE_SSL,
      sslCa: env.DATABASE_SSL_CA,
      poolMax: env.DATABASE_POOL_MAX,
      defaultMax: 5,
    }));
    // A broken idle client must not crash the server; the error text may hold connection details, so it is not logged.
    pool.on('error', () => console.error('database pool: idle client error'));
    cache.__bcgDb = drizzle(pool, { schema }) as unknown as Db;
  }
  return cache.__bcgDb;
}
