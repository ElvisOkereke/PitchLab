import { desc, inArray } from 'drizzle-orm';
import { CRITERIA } from '../case/schema';
import type { Db } from '../db/client';
import { criterion, scores } from '../db/schema';

/** The 7 AI criteria plus the owner-only `gut` (spec §6.4). */
export const OWNER_CRITERIA = criterion.enumValues;
export type OwnerCriterion = (typeof OWNER_CRITERIA)[number];

export const CRITERION_LABEL: Record<OwnerCriterion, string> = {
  pain: 'Pain severity',
  roi: 'Buyer ROI clarity',
  evidence: 'Evidence strength',
  speed: 'Speed to market',
  autonomy: 'Autonomy',
  novelty: 'Novelty/non-generic',
  reach: 'Reachability',
  gut: 'Your gut',
};

type ScoreRow = typeof scores.$inferSelect;
export type ScoreLike = Pick<ScoreRow, 'criterion' | 'value' | 'note' | 'by' | 'createdAt'>;
type Entry = { value: number; note: string };
export type ScoreSummary = {
  ai: number | null;
  owner: number | null;
  latest: Partial<Record<OwnerCriterion, { ai?: Entry; owner?: Entry }>>;
};

const AI_CRITERIA = new Set<string>(CRITERIA);
export const round1 = (x: number) => Math.round(x * 10) / 10;
const mean = (xs: number[]) => (xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

/**
 * The latest row per (by, criterion), with `ai` = mean of the AI criteria present (gut excluded) and `owner` = mean of
 * the owner criteria present (gut included), both rounded to 1 dp; null when there are none.
 */
export function scoreSummary(rows: ScoreLike[]): ScoreSummary {
  const newest = new Map<string, ScoreLike>();
  for (const r of rows) {
    const key = `${r.by}:${r.criterion}`;
    const prev = newest.get(key);
    if (!prev || r.createdAt.getTime() >= prev.createdAt.getTime()) newest.set(key, r);
  }
  const latest: ScoreSummary['latest'] = {};
  const ai: number[] = [];
  const owner: number[] = [];
  for (const r of newest.values()) {
    const slot = (latest[r.criterion] ??= {});
    slot[r.by] = { value: r.value, note: r.note };
    if (r.by === 'owner') owner.push(r.value);
    else if (AI_CRITERIA.has(r.criterion)) ai.push(r.value);
  }
  return { ai: mean(ai), owner: mean(owner), latest };
}

/**
 * Latest score row per (case, by, criterion) for the given cases (DISTINCT ON, so at most 16 rows per case).
 * Callers bound `caseIds`.
 */
export async function latestScoreRows(db: Db, caseIds: string[]): Promise<(ScoreLike & { caseId: string })[]> {
  if (caseIds.length === 0) return [];
  return db.selectDistinctOn([scores.caseId, scores.by, scores.criterion], {
    caseId: scores.caseId, criterion: scores.criterion, value: scores.value, note: scores.note, by: scores.by, createdAt: scores.createdAt,
  })
    .from(scores)
    .where(inArray(scores.caseId, caseIds))
    .orderBy(scores.caseId, scores.by, scores.criterion, desc(scores.createdAt));
}
