import 'server-only';
import type { Db } from '@bcg/core/db/client';
import * as schema from '@bcg/core/db/schema';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { webEnv } from './env';

// Cached on globalThis so dev hot reloads reuse one pool. Core's createDb is never imported here (only its type), so
// PGlite stays out of the web bundle.
const cache = globalThis as unknown as { __bcgDb?: Db };

/** The shared Postgres connection (a pg.Pool of at most 5 clients) with core's schema. */
export function getDb(): Db {
  if (!cache.__bcgDb) {
    const pool = new pg.Pool({ connectionString: webEnv().DATABASE_URL, max: 5 });
    // A broken idle client must not crash the server; the error text may hold connection details, so it is not logged.
    pool.on('error', () => console.error('database pool: idle client error'));
    cache.__bcgDb = drizzle(pool, { schema }) as unknown as Db;
  }
  return cache.__bcgDb;
}
