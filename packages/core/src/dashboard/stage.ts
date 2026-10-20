import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { caseStage, cases, stageEvents, type CaseStage, type StageEventKind } from '../db/schema';

export type { CaseStage, StageEventKind };

export const MoveStageInputSchema = z.object({
  caseId: z.uuid(),
  from: z.enum(caseStage.enumValues),
  to: z.enum(caseStage.enumValues),
  note: z.string().trim().max(500).optional(),
});
export type MoveStageInput = z.infer<typeof MoveStageInputSchema>;

export type MoveStageResult =
  | { ok: true; kind: StageEventKind }
  | { ok: false; reason: 'not_found' | 'stale' | 'same_stage' | 'note_required' };

/** Any move out of Killed counts as an overturn, so the strong feedback signal is kept whichever control was used. */
export function stageEventKindOf(from: CaseStage, to: CaseStage): StageEventKind {
  if (to === 'killed') return 'kill';
  if (from === 'killed') return 'overturn';
  return 'move';
}

/**
 * Moves a case from `from` to `to` and logs one stage event, in one transaction. The update only applies while the
 * case is still at `from`, so a move made on a stale page changes nothing (`stale`). A kill needs a note, stored as
 * `cases.killReason`; an overturn clears it. "Overturn kill" is `{ from: 'killed', to: 'new' }`.
 */
export async function moveStage(db: Db, input: MoveStageInput): Promise<MoveStageResult> {
  const { caseId, from, to } = input;
  const note = input.note?.trim() || null;
  if (from === to) return { ok: false, reason: 'same_stage' };
  const kind = stageEventKindOf(from, to);
  if (kind === 'kill' && !note) return { ok: false, reason: 'note_required' };

  return db.transaction(async (tx) => {
    const killReason = kind === 'kill' ? note : kind === 'overturn' ? null : undefined;
    const updated = await tx.update(cases)
      .set({ stage: to, updatedAt: sql`now()`, ...(killReason !== undefined ? { killReason } : {}) })
      .where(and(eq(cases.id, caseId), eq(cases.stage, from)))
      .returning({ id: cases.id });
    if (updated.length === 0) {
      const [exists] = await tx.select({ id: cases.id }).from(cases).where(eq(cases.id, caseId));
      return { ok: false, reason: exists ? 'stale' : 'not_found' } as const;
    }
    await tx.insert(stageEvents).values({ caseId, fromStage: from, toStage: to, kind, note });
    return { ok: true, kind } as const;
  });
}
