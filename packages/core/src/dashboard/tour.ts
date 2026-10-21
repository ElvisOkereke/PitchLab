import { and, desc, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { cases } from '../db/schema';
import { getSetting, setSetting } from '../validation/settings';
import { TOUR_CHAPTERS, TOUR_STATE_KEY } from './tour-ids';

export { TOUR_CHAPTERS, TOUR_STATE_KEY, TOUR_VERSION } from './tour-ids';
export type { TourChapterId } from './tour-ids';

/** The saved tour progress. `current` is where the tour is (or was paused); `dismissed` means the user closed it. */
export const TourStateSchema = z.object({
  version: z.number().int().min(1),
  completed: z.array(z.enum(TOUR_CHAPTERS)).max(8),
  current: z.object({ chapter: z.enum(TOUR_CHAPTERS), step: z.number().int().min(0).max(50) }).nullable(),
  dismissed: z.boolean(),
});
export type TourState = z.infer<typeof TourStateSchema>;

/** The saved tour state, or null when unset or not a valid state (corrupt data never breaks the page). */
export async function getTourState(db: Db): Promise<TourState | null> {
  const parsed = TourStateSchema.safeParse(await getSetting(db, TOUR_STATE_KEY));
  return parsed.success ? parsed.data : null;
}

/** Validates, then inserts or replaces the saved tour state. Throws on an invalid state. */
export async function saveTourState(db: Db, s: TourState): Promise<void> {
  await setSetting(db, TOUR_STATE_KEY, TourStateSchema.parse(s));
}

/** The case the tour shows: the newest real case that is not killed, else the built-in example, else null. */
export async function tourCaseSlug(db: Db): Promise<string | null> {
  const [real] = await db.select({ slug: cases.slug }).from(cases)
    .where(and(eq(cases.isExample, false), ne(cases.stage, 'killed')))
    .orderBy(desc(cases.createdAt), desc(cases.id))
    .limit(1);
  if (real) return real.slug;
  const [example] = await db.select({ slug: cases.slug }).from(cases).where(eq(cases.isExample, true)).limit(1);
  return example?.slug ?? null;
}
