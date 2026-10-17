import { createDb, type Db } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { seedDefaults } from '../../src/db/seed';
import { runs } from '../../src/db/schema';
import type { RunConfig } from '../../src/pipeline/types';

/** Fresh in-memory PGlite database, migrated and seeded. */
export async function testDb(): Promise<Db> {
  const db = await createDb('pglite://memory');
  await runMigrations(db);
  await seedDefaults(db);
  return db;
}

/** Inserts a queued run row and returns its id + config. */
export async function insertRun(db: Db, config: RunConfig): Promise<{ id: string; config: RunConfig }> {
  const [row] = await db.insert(runs).values({ config, status: 'queued' }).returning({ id: runs.id });
  return { id: row!.id, config };
}
