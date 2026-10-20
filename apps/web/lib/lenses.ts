import 'server-only';
import type { Db } from '@bcg/core/db/client';
import { lenses } from '@bcg/core/db/schema';
import { asc, eq } from 'drizzle-orm';

const LENSES_MAX = 100;

/** Active lenses (id + name only) for the board's lens filter. */
export async function listActiveLenses(db: Db): Promise<{ id: string; name: string }[]> {
  return db.select({ id: lenses.id, name: lenses.name }).from(lenses).where(eq(lenses.active, true)).orderBy(asc(lenses.name)).limit(LENSES_MAX);
}
