import { and, count, countDistinct, desc, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { caseStage, cases, gateVerdicts, ideas, outreachEvents, prospects, scores, type CaseStage } from '../db/schema';

/** Most cards shown per stage column (counts are not limited). */
export const BOARD_LIMIT = 200;
/** Most gate-killed ideas listed under the Killed column. */
export const GATE_KILLS_MAX = 200;

export type BoardCard = {
  id: string;
  slug: string;
  title: string;
  stage: CaseStage;
  aiScore: number | null;
  ownerScore: number | null;
  metric: string;
  updatedAt: Date;
};

export type BoardFilters = { lensId?: string; minAi?: number };

const STAGES = caseStage.enumValues;

/** `'12/50 emailed'` once the case has prospects, else the buyer ROI (`'ROI 1.07×'`), else `'ROI n/a'`. */
export function keyMetric(x: { roiMultiple: number | null; outreach?: { sent: number; prospects: number } }): string {
  if (x.outreach && x.outreach.prospects > 0) return `${x.outreach.sent}/${x.outreach.prospects} emailed`;
  if (x.roiMultiple !== null && Number.isFinite(x.roiMultiple)) return `ROI ${Math.round(x.roiMultiple * 100) / 100}×`;
  return 'ROI n/a';
}

/** Mean of the latest AI scores (7 criteria) and of the latest owner scores (gut included) per case, 1 dp. */
function scoreMeans(db: Db) {
  const latest = db.selectDistinctOn([scores.caseId, scores.by, scores.criterion], {
    caseId: scores.caseId, by: scores.by, criterion: scores.criterion, value: scores.value,
  })
    .from(scores)
    .orderBy(scores.caseId, scores.by, scores.criterion, desc(scores.createdAt))
    .as('latest');
  return db.select({
    caseId: latest.caseId,
    ai: sql<number | null>`round(avg(${latest.value}) filter (where ${latest.by} = 'ai' and ${latest.criterion} <> 'gut'), 1)::float8`.as('ai'),
    owner: sql<number | null>`round(avg(${latest.value}) filter (where ${latest.by} = 'owner'), 1)::float8`.as('owner'),
  })
    .from(latest)
    .groupBy(latest.caseId)
    .as('means');
}

/**
 * Cases grouped by stage (newest-updated first, at most BOARD_LIMIT per stage) with their scores and key metric.
 * `counts` honour the filters but not the limit. Ideas carry no sector, so the filters are lens and minimum AI score.
 * Only the ROI figure is read from `sections` (constant JSON path), never the full sections.
 */
export async function listBoard(db: Db, f: BoardFilters): Promise<{ columns: Record<CaseStage, BoardCard[]>; counts: Record<CaseStage, number> }> {
  const means = scoreMeans(db);
  const filters: (SQL | undefined)[] = [
    f.lensId ? eq(ideas.lensId, f.lensId) : undefined,
    f.minAi !== undefined && Number.isFinite(f.minAi) ? gte(means.ai, f.minAi) : undefined,
  ];
  const roi = sql<number | null>`(${cases.sections} #>> '{numbers,results,buyer,roiMultiple}')::float8`;

  const columnRows = await Promise.all(STAGES.map((stage) =>
    db.select({
      id: cases.id, slug: cases.slug, title: cases.title, stage: cases.stage, updatedAt: cases.updatedAt,
      aiScore: means.ai, ownerScore: means.owner, roi,
    })
      .from(cases)
      .innerJoin(ideas, eq(ideas.id, cases.ideaId))
      .leftJoin(means, eq(means.caseId, cases.id))
      .where(and(eq(cases.stage, stage), ...filters))
      .orderBy(desc(cases.updatedAt), cases.slug)
      .limit(BOARD_LIMIT)));

  const countRows = await db.select({ stage: cases.stage, n: count() })
    .from(cases)
    .innerJoin(ideas, eq(ideas.id, cases.ideaId))
    .leftJoin(means, eq(means.caseId, cases.id))
    .where(and(...filters))
    .groupBy(cases.stage);

  const ids = columnRows.flat().map((r) => r.id);
  const outreach = ids.length === 0 ? [] : await db.select({
    caseId: prospects.caseId,
    prospects: countDistinct(prospects.id),
    sent: countDistinct(sql`case when ${outreachEvents.type} = 'sent' then ${prospects.id} end`),
  })
    .from(prospects)
    .leftJoin(outreachEvents, eq(outreachEvents.prospectId, prospects.id))
    .where(inArray(prospects.caseId, ids))
    .groupBy(prospects.caseId);
  const outreachOf = new Map(outreach.map((o) => [o.caseId, { sent: o.sent, prospects: o.prospects }]));

  const columns = Object.fromEntries(STAGES.map((s, i) => [s, columnRows[i]!.map((r): BoardCard => ({
    id: r.id, slug: r.slug, title: r.title, stage: r.stage, updatedAt: r.updatedAt,
    aiScore: r.aiScore ?? null, ownerScore: r.ownerScore ?? null,
    metric: keyMetric({ roiMultiple: r.roi ?? null, outreach: outreachOf.get(r.id) }),
  }))])) as Record<CaseStage, BoardCard[]>;
  const counts = Object.fromEntries(STAGES.map((s) => [s, countRows.find((c) => c.stage === s)?.n ?? 0])) as Record<CaseStage, number>;
  return { columns, counts };
}

export type GateKill = {
  ideaId: string;
  title: string;
  oneLiner: string;
  createdAt: Date;
  failed: { check: (typeof gateVerdicts.$inferSelect)['check']; reasoning: string }[];
};

/**
 * Ideas the gate killed (status `gated_out`), newest first, each with its failed checks (the latest verdict per check).
 * Shown read-only under the Killed column (spec §5.4).
 */
export async function listGateKills(db: Db, limit = 50): Promise<GateKill[]> {
  const n = Math.min(Math.max(Math.trunc(limit) || 50, 1), GATE_KILLS_MAX);
  const rows = await db.select({ ideaId: ideas.id, title: ideas.title, oneLiner: ideas.oneLiner, createdAt: ideas.createdAt })
    .from(ideas)
    .where(eq(ideas.status, 'gated_out'))
    .orderBy(desc(ideas.createdAt))
    .limit(n);
  if (rows.length === 0) return [];
  const verdicts = await db.selectDistinctOn([gateVerdicts.ideaId, gateVerdicts.check], {
    ideaId: gateVerdicts.ideaId, check: gateVerdicts.check, pass: gateVerdicts.pass, reasoning: gateVerdicts.reasoning,
  })
    .from(gateVerdicts)
    .where(inArray(gateVerdicts.ideaId, rows.map((r) => r.ideaId)))
    .orderBy(gateVerdicts.ideaId, gateVerdicts.check, desc(gateVerdicts.createdAt));
  return rows.map((r) => ({
    ...r,
    failed: verdicts.filter((v) => v.ideaId === r.ideaId && !v.pass).map((v) => ({ check: v.check, reasoning: v.reasoning })),
  }));
}
