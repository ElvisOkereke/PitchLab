'use server';

import { TourStateSchema, saveTourState } from '@bcg/core/dashboard/tour';
import { requireOwnerAction } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';

/**
 * Saves the guided tour's progress. Called from the tour with a plain object (not a form). An invalid payload writes
 * nothing and returns `{ ok: false }`.
 */
export async function saveTourStateAction(state: unknown): Promise<{ ok: boolean }> {
  await requireOwnerAction();
  const parsed = TourStateSchema.safeParse(state);
  if (!parsed.success) return { ok: false };
  await saveTourState(getDb(), parsed.data);
  return { ok: true };
}
