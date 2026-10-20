import type { CaseStage } from '@bcg/core/db/schema';
import { z } from 'zod';
import { STAGES } from './stages';

export const BOARD_NOTICES = {
  rerun_queued: 'Queued a run for that idea. It starts when npm run worker is running.',
  rerun_busy: '3 runs are already queued. Wait for the worker, then try again.',
  rerun_refused: 'That idea can no longer be re-run.',
  overturn_refused: 'That case is no longer killed, so there was nothing to overturn.',
} as const;
export type BoardNotice = keyof typeof BOARD_NOTICES;

const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);

/** `?stage=&lens=&minAi=&notice=`; anything invalid falls back to "not set". */
const BoardQuerySchema = z.object({
  stage: z.preprocess(first, z.enum(STAGES).optional()).catch(undefined),
  lens: z.preprocess(first, z.string().regex(/^[a-z0-9-]{1,100}$/).optional()).catch(undefined),
  minAi: z.preprocess(first, z.coerce.number().min(1).max(5).optional()).catch(undefined),
  notice: z.preprocess(first, z.enum(Object.keys(BOARD_NOTICES) as [BoardNotice, ...BoardNotice[]]).optional()).catch(undefined),
});
export type BoardQuery = z.infer<typeof BoardQuerySchema>;

export function parseBoardQuery(sp: Record<string, string | string[] | undefined>): BoardQuery {
  return BoardQuerySchema.parse(sp);
}

/** The column shown on phones: the requested stage, else the first non-empty one, else New. */
export function selectedStage(requested: CaseStage | undefined, counts: Record<CaseStage, number>): CaseStage {
  return requested ?? STAGES.find((s) => counts[s] > 0) ?? 'new';
}

/** A board URL keeping the filters (never the one-off notice). */
export function boardHref(q: { stage?: CaseStage; lens?: string; minAi?: number }): string {
  const p = new URLSearchParams();
  if (q.stage) p.set('stage', q.stage);
  if (q.lens) p.set('lens', q.lens);
  if (q.minAi !== undefined) p.set('minAi', String(q.minAi));
  const s = p.toString();
  return s ? `/?${s}` : '/';
}
