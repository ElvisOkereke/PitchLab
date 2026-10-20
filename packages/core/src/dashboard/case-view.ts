import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { cases, claims, gateCheck, gateVerdicts, ideas, lenses, scores, stageEvents } from '../db/schema';

export type CaseRow = typeof cases.$inferSelect;
export type ClaimRow = typeof claims.$inferSelect;
export type ScoreRow = typeof scores.$inferSelect;
export type GateVerdictRow = typeof gateVerdicts.$inferSelect;
export type StageEventRow = typeof stageEvents.$inferSelect;

export type CaseView = {
  case: CaseRow;
  claims: ClaimRow[];
  scores: ScoreRow[];
  /** The latest verdict per check, failed first, then in check order. */
  gate: GateVerdictRow[];
  /** The latest stage events, newest first. */
  events: StageEventRow[];
  lensName: string | null;
};

export const CASE_SLUG = /^[a-z0-9-]{1,120}$/;
export const CASE_EVENTS_MAX = 20;
/** Safety bounds (deep-case caps claims well below these). */
const CLAIMS_MAX = 1000;
const SCORES_MAX = 500;

const CHECK_ORDER = new Map<string, number>(gateCheck.enumValues.map((c, i) => [c, i]));

/** Everything the case page shows, or null for a malformed or unknown slug. */
export async function getCaseView(db: Db, slug: string): Promise<CaseView | null> {
  if (typeof slug !== 'string' || !CASE_SLUG.test(slug)) return null;
  const [row] = await db.select({ case: cases, lensName: lenses.name })
    .from(cases)
    .innerJoin(ideas, eq(ideas.id, cases.ideaId))
    .leftJoin(lenses, eq(lenses.id, ideas.lensId))
    .where(eq(cases.slug, slug));
  if (!row) return null;
  const kase = row.case;

  const [claimRows, scoreRows, verdicts, events] = await Promise.all([
    db.select().from(claims).where(eq(claims.caseId, kase.id)).orderBy(claims.createdAt, claims.id).limit(CLAIMS_MAX),
    db.select().from(scores).where(eq(scores.caseId, kase.id)).orderBy(scores.createdAt, scores.id).limit(SCORES_MAX),
    db.selectDistinctOn([gateVerdicts.check]).from(gateVerdicts)
      .where(eq(gateVerdicts.ideaId, kase.ideaId))
      .orderBy(gateVerdicts.check, desc(gateVerdicts.createdAt)),
    db.select().from(stageEvents).where(eq(stageEvents.caseId, kase.id)).orderBy(desc(stageEvents.at), desc(stageEvents.id)).limit(CASE_EVENTS_MAX),
  ]);
  const gate = [...verdicts].sort((a, b) =>
    Number(a.pass) - Number(b.pass) || (CHECK_ORDER.get(a.check)! - CHECK_ORDER.get(b.check)!));
  return { case: kase, claims: claimRows, scores: scoreRows, gate, events, lensName: row.lensName ?? null };
}
