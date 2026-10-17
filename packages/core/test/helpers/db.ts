import { createDb, type Db } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { seedDefaults } from '../../src/db/seed';

/** Fresh in-memory PGlite database, migrated and seeded. */
export async function testDb(): Promise<Db> {
  const db = await createDb('pglite://memory');
  await runMigrations(db);
  await seedDefaults(db);
  return db;
}
