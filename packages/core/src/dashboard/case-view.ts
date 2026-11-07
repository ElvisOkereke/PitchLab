import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { benchmarkPasses, cases, claims, gateCheck, gateVerdicts, ideas, lenses, runs, scores, stageEvents } from '../db/schema';
import { runSeedSql, toRunOrigin, type RunOrigin } from './runs';
import {
  EdgeSchema, ScaleEstimateSchema, ScaleSchema, currentScale, priceIsFree, type Edge, type Scale, type ScaleEstimate, type ScaleResult,
} from '../pipeline/business-models';

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
  /** The idea's edge and scale (ideate.v12; model claims), or null for older ideas and invalid jsonb. Optional for older callers. */
  edge?: Edge | null;
  scale?: Scale | null;
  /** The idea's scale estimate (ideate.v13 or the scale estimator) and its result worked out in code; null when absent or invalid. */
  scaleEstimate?: ScaleEstimate | null;
  scaleResult?: ScaleResult | null;
  /** The idea's business model (ads and affiliate say "regular users") and whether its price hint is 0 (a free product). */
  businessModel?: string | null;
  priceIsFree?: boolean;
  /** The run and benchmark pass the case came from; null for the example (its run is hidden). Optional for older callers. */
  origin?: RunOrigin | null;
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
  const [row] = await db.select({ case: cases, lensName: lenses.name, edge: ideas.edge, scale: ideas.scale,
    scaleEstimate: ideas.scaleEstimate, scaleResult: ideas.scaleResult, priceHint: ideas.priceHint, businessModel: ideas.businessModel,
    runId: runs.id, runCreatedAt: runs.createdAt, runIsExample: runs.isExample, seed: runSeedSql, passLabel: benchmarkPasses.label })
    .from(cases)
    .innerJoin(ideas, eq(ideas.id, cases.ideaId))
    .leftJoin(lenses, eq(lenses.id, ideas.lensId))
    .leftJoin(runs, eq(runs.id, ideas.runId))
    .leftJoin(benchmarkPasses, eq(benchmarkPasses.id, runs.benchmarkPassId))
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
  const edge = EdgeSchema.safeParse(row.edge);
  const scale = ScaleSchema.safeParse(row.scale);
  const scaleEstimate = ScaleEstimateSchema.safeParse(row.scaleEstimate);
  // Recomputed from the stored estimate (the same result the screen and the gate use), so a result stored before a rule change never shows.
  const scaleResult = currentScale(row);
  return {
    case: kase, claims: claimRows, scores: scoreRows, gate, events, lensName: row.lensName ?? null,
    edge: edge.success ? edge.data : null, scale: scale.success ? scale.data : null,
    scaleEstimate: scaleEstimate.success ? scaleEstimate.data : null, scaleResult,
    businessModel: row.businessModel ?? null, priceIsFree: priceIsFree(row.priceHint),
    origin: toRunOrigin({ runId: row.runId, createdAt: row.runCreatedAt, seed: row.seed, passLabel: row.passLabel, isExample: row.runIsExample }),
  };
}
