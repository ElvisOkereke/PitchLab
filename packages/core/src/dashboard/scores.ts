import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { cases, scores } from '../db/schema';
import { OWNER_CRITERIA } from './criteria';

export const OwnerScoresInputSchema = z.object({
  caseId: z.uuid(),
  entries: z.array(z.object({
    criterion: z.enum(OWNER_CRITERIA),
    value: z.number().int().min(1).max(5),
    note: z.string().trim().max(1000).default(''),
  })).min(1, 'Score at least one criterion.').max(OWNER_CRITERIA.length),
}).refine((x) => new Set(x.entries.map((e) => e.criterion)).size === x.entries.length, {
  message: 'Each criterion can be scored once.',
  path: ['entries'],
});
export type OwnerScoresInput = z.infer<typeof OwnerScoresInputSchema>;

/**
 * Replaces the owner's scores for exactly the submitted criteria (delete + insert, one transaction). Criteria left out
 * keep their previous owner row; AI rows are never touched. This is the only path that writes `gut`.
 */
export async function saveOwnerScores(
  db: Db,
  input: OwnerScoresInput,
): Promise<{ ok: true; saved: number } | { ok: false; reason: 'not_found' }> {
  const [kase] = await db.select({ id: cases.id }).from(cases).where(eq(cases.id, input.caseId));
  if (!kase) return { ok: false, reason: 'not_found' };
  const criteria = input.entries.map((e) => e.criterion);
  await db.transaction(async (tx) => {
    await tx.delete(scores).where(and(eq(scores.caseId, input.caseId), eq(scores.by, 'owner'), inArray(scores.criterion, criteria)));
    await tx.insert(scores).values(input.entries.map((e) => ({
      caseId: input.caseId, criterion: e.criterion, value: e.value, note: e.note ?? '', by: 'owner' as const, model: null, promptVersion: null,
    })));
  });
  return { ok: true, saved: input.entries.length };
}
