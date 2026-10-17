import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
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
    const { default: pg } = await import('pg');
    const { drizzle } = await import('drizzle-orm/node-postgres');
    return drizzle(new pg.Pool({ connectionString: url }), { schema }) as unknown as Db;
  }
  throw new Error(`Unsupported database URL scheme: ${url.split(':')[0]}`);
}
