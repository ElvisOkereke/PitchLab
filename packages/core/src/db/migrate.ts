import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function runMigrations(db: Db): Promise<void> {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  const client = (db as unknown as { $client: unknown }).$client as { waitReady?: unknown };
  if (client && 'waitReady' in client) {
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    await migrate(db as never, { migrationsFolder });
  } else {
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    await migrate(db as never, { migrationsFolder });
  }
}

// CLI: `npm run db:migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { seedDefaults } = await import('./seed');
  const { ensureExampleQuietly } = await import('../example/example');
  const db = await createDb(process.env.DATABASE_URL ?? 'pglite://.data/pglite');
  await runMigrations(db);
  await seedDefaults(db);
  await ensureExampleQuietly(db, (l) => console.error(l));
  console.log('migrations applied');
  process.exit(0);
}
