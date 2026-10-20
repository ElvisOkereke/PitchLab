import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { lenses } from '../db/schema';

/** Most lenses listed (the seed has 8; editing lenses is out of scope for the dashboard). */
export const LENSES_MAX = 100;

/** Active lenses (id + name only), by name: the board's lens filter, the run queue's lens seeds and Settings. */
export async function listActiveLenses(db: Db): Promise<{ id: string; name: string }[]> {
  return db.select({ id: lenses.id, name: lenses.name }).from(lenses).where(eq(lenses.active, true)).orderBy(asc(lenses.name)).limit(LENSES_MAX);
}
