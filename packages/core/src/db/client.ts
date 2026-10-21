import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { pgPoolConfig } from './pg-config';
import * as schema from './schema';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export async function createDb(url: string): Promise<Db> {
  if (url.startsWith('pglite://')) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { vector } = await import('@electric-sql/pglite-pgvector');
    const { drizzle } = await import('drizzle-orm/pglite');
    const target = url.slice('pglite://'.length);
    let dataDir: string | undefined;
    if (target && target !== 'memory') {
      dataDir = resolve(target);
      mkdirSync(dirname(dataDir), { recursive: true });
    }
    const client = new PGlite({ dataDir, extensions: { vector } });
    await client.waitReady;
    return drizzle(client, { schema }) as unknown as Db;
  }
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    // Validated before pg loads, so a bad DATABASE_SSL / DATABASE_SSL_CA / DATABASE_POOL_MAX fails fast by name.
    const config = pgPoolConfig(url, {
      ssl: process.env.DATABASE_SSL,
      sslCa: process.env.DATABASE_SSL_CA,
      poolMax: process.env.DATABASE_POOL_MAX,
      defaultMax: 4,
    });
    const { default: pg } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const pool = new pg.Pool(config);
    // A dropped idle connection (pooler restart, maintenance) must not crash the worker; the error text may hold
    // connection details, so it is not logged. The next query gets a fresh connection.
    pool.on('error', () => console.error('database pool: idle client error'));
    return drizzle(pool, { schema }) as unknown as Db;
  }
  throw new Error(`Unsupported database URL scheme: ${url.split(':')[0]}`);
}
