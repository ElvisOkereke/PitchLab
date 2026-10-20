import { createDb, type Db } from './client';
import { runMigrations } from './migrate';
import { seedDefaults } from './seed';

/** Fresh in-memory PGlite database, migrated and seeded (core tests and the web app's tests share it). */
export async function createTestDb(): Promise<Db> {
  const db = await createDb('pglite://memory');
  await runMigrations(db);
  await seedDefaults(db);
  return db;
}
