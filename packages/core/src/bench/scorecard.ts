// Idea-quality scorecard over a set of runs, computed from stored rows only (no model calls). Web-safe: drizzle,
// db/schema and a type-only Db. Example runs and cases are always left out; every query is bounded.
import { and, count, countDistinct, desc, eq, inArray, isNotNull, ne, notInArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client';
import { cases, dataCalls, gateVerdicts, ideas, llmCalls, runs, scores, signals } from '../db/schema';
import { METRIC_DEFS, type MetricId } from './definitions';

/**
 * One scorecard row. Share metrics (near-duplicates, real need, customer return, margin, wasted entrants) hold a
 * fraction 0–1 in `value`; `display` is the human text. `meets` is null when there is no value or no target.
 */
export type MetricResult = {
  id: MetricId;
  value: number | null;
  display: string;
  meets: boolean | null;
  status: 'measured' | 'not_measured' | 'no_data';
  note?: string;
};

export type Scorecard = {
  metrics: MetricResult[];
  extra: { runs: number; ideas: number; cases: number; scoredCases: number; medianRoi: number | null; newVsHistory: number | null };
  notes: string[];
};

/** Most runs in one scorecard (newest kept). */
export const SCORECARD_RUNS_MAX = 200;
/** Most ideas on each side of a similarity computation (newest kept). */
export const SIMILARITY_IDEAS_MAX = 3000;
/** Overrides for the bounds above (tests). */
export type ScorecardLimits = { runsMax?: number; similarityIdeasMax?: number };

const REPETITION_TARGET = 0.55;
const NEAR_DUPLICATE_SIM = 0.8;
const NEAR_DUPLICATES_TARGET = 0.1;
const BUYER_VARIETY_TARGET = 8;
const REAL_NEED_TARGET = 0.5;
const ROI_BAR = 3;
const MARGIN_BAR = 60;
const WASTED_TARGET = 0.3;
const OWNER_VERDICT_TARGET = 3.5;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Omit<MetricResult, 'id'>;

const measured = (value: number, display: string, meets: boolean | null): Row => ({ value, display, meets, status: 'measured' });
const noData = (note: string, display = 'no data'): Row => ({ value: null, display, meets: null, status: 'no_data', note });
const pct = (v: number) => `${Math.round(v * 100)}%`;
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Buyer-type normalisation: lowercase, trim, collapse spaces, strip one trailing "s". */
export function normaliseBuyerType(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ').replace(/s$/, '');
}

/** A number at a constant JSON path of `cases.sections`, or null when missing or not a number. */
function sectionNumber(path: SQL) {
  return sql<number | null>`case when jsonb_typeof(${cases.sections} #> ${path}) = 'number' then (${cases.sections} #>> ${path})::float8 end`;
}

/** For each idea in `from`, its highest cosine similarity to another idea in `to` (zero vectors skipped). */
async function nearestSims(db: Db, from: string[], to: string[]): Promise<number[]> {
  if (from.length === 0 || to.length === 0) return [];
  const a = alias(ideas, 'a');
  const b = alias(ideas, 'b');
  const sim = sql<number>`1 - (${a.embedding} <=> ${b.embedding})`;
  const rows = await db
    .select({ sim: sql<number>`max(${sim})::float8` })
    .from(a)
    .innerJoin(b, and(inArray(b.id, to), ne(b.id, a.id)))
    .where(and(inArray(a.id, from), sql`${sim} <> 'NaN'::float8`))
    .groupBy(a.id);
  return rows.map((r) => Number(r.sim)).filter(Number.isFinite);
}

/** Newest ids matching `where` (at most `max`), plus the full count. */
async function newestIdeaIds(db: Db, where: SQL | undefined, max: number, joinRuns = false): Promise<{ ids: string[]; total: number }> {
  const countQ = db.select({ n: count() }).from(ideas).$dynamic();
  const idsQ = db.select({ id: ideas.id }).from(ideas).$dynamic();
  if (joinRuns) {
    countQ.innerJoin(runs, eq(runs.id, ideas.runId));
    idsQ.innerJoin(runs, eq(runs.id, ideas.runId));
  }
  const [[c], rows] = await Promise.all([
    countQ.where(where),
    idsQ.where(where).orderBy(desc(ideas.createdAt), desc(ideas.id)).limit(max),
  ]);
  return { ids: rows.map((r) => r.id), total: Number(c?.n ?? 0) };
}

/** The scorecard for `runIds` (example runs/cases and unknown ids ignored; at most the newest 200 runs). */
export async function computeScorecard(db: Db, runIds: string[], limits: ScorecardLimits = {}): Promise<Scorecard> {
  const runsMax = limits.runsMax ?? SCORECARD_RUNS_MAX;
  const simMax = limits.similarityIdeasMax ?? SIMILARITY_IDEAS_MAX;
  const notes: string[] = [];

  const wanted = [...new Set(runIds.filter((id) => UUID_RE.test(id)))];
  const realRuns = wanted.length === 0 ? [] : await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(inArray(runs.id, wanted), eq(runs.isExample, false)))
    .orderBy(desc(runs.createdAt), desc(runs.id));
  if (realRuns.length > runsMax) notes.push(`Used the newest ${runsMax} of ${realRuns.length} runs.`);
  const set = realRuns.slice(0, runsMax).map((r) => r.id);

  const data = set.length === 0 ? emptyData() : await gather(db, set, simMax, notes);
  return { metrics: buildMetrics(data), extra: extraOf(data, set.length), notes };
}

/** Raw figures gathered for one run set. */
type Data = {
  ideaCount: number;
  within: number[];
  history: number[];
  buyerCounts: number[];
  cited: { total: number; yes: number };
  caseRows: { roi: number | null; gm: number | null }[];
  gut: number[];
  entrants: { total: number; wasted: number };
  cost: number;
};

const emptyData = (): Data => ({
  ideaCount: 0, within: [], history: [], buyerCounts: [], cited: { total: 0, yes: 0 }, caseRows: [], gut: [], entrants: { total: 0, wasted: 0 }, cost: 0,
});

function extraOf(d: Data, runCount: number): Scorecard['extra'] {
  return {
    runs: runCount,
    ideas: d.ideaCount,
    cases: d.caseRows.length,
    scoredCases: d.gut.length,
    medianRoi: median(d.caseRows.flatMap((c) => (c.roi === null ? [] : [c.roi]))),
    newVsHistory: d.history.length ? mean(d.history) : null,
  };
}

/** One query per metric family over the (non-empty) run set. */
async function gather(db: Db, set: string[], simMax: number, notes: string[]): Promise<Data> {
  const generated = and(inArray(ideas.runId, set), eq(ideas.origin, 'generated'));

  // Similarity: within the set, and against generated ideas of real runs outside it.
  const [embedded, historyIds] = await Promise.all([
    newestIdeaIds(db, and(generated, isNotNull(ideas.embedding)), simMax),
    newestIdeaIds(db, and(notInArray(ideas.runId, set), eq(runs.isExample, false), eq(ideas.origin, 'generated'), isNotNull(ideas.embedding)), simMax, true),
  ]);
  if (embedded.total > simMax) notes.push(`Similarity used the newest ${simMax} of ${embedded.total} ideas with embeddings.`);
  if (historyIds.total > simMax) notes.push(`New versus history used the newest ${simMax} of ${historyIds.total} earlier ideas.`);
  const within = await nearestSims(db, embedded.ids, embedded.ids);
  const history = await nearestSims(db, embedded.ids, historyIds.ids);

  const [[ideaCountRow], buyerRows, [citedRow], caseRows, [entrantRow], [llm], [dat]] = await Promise.all([
    db.select({ n: count() }).from(ideas).where(generated),
    db.select({ runId: ideas.runId, buyerType: ideas.buyerType }).from(ideas).where(and(generated, isNotNull(ideas.buyerType))),
    (() => {
      const cited = db.selectDistinct({ sid: sql<string>`unnest(${ideas.signalIds})`.as('sid') }).from(ideas).where(generated).as('cited');
      return db.select({
        total: sql<number>`count(*)::int`,
        yes: sql<number>`(count(*) filter (where ${inArray(signals.voice, ['operator', 'neutral'])}))::int`,
      }).from(cited).leftJoin(signals, sql`${signals.id} = ${cited.sid}`);
    })(),
    db.select({
      id: cases.id,
      roi: sectionNumber(sql`'{numbers,results,buyer,roiMultiple}'`),
      gm: sectionNumber(sql`'{numbers,results,unit,grossMarginPct}'`),
    })
      .from(cases)
      .innerJoin(ideas, eq(ideas.id, cases.ideaId))
      .where(and(inArray(ideas.runId, set), eq(cases.isExample, false))),
    db.select({
      total: countDistinct(ideas.id),
      wasted: sql<number>`(count(distinct ${ideas.id}) filter (where ${and(
        eq(ideas.status, 'gated_out'), eq(gateVerdicts.pass, false), inArray(gateVerdicts.check, ['generic', 'autonomy']),
      )}))::int`,
    }).from(ideas).innerJoin(gateVerdicts, eq(gateVerdicts.ideaId, ideas.id)).where(generated),
    db.select({ sum: sql<string>`coalesce(sum(${llmCalls.costUsd}), 0)` }).from(llmCalls).where(inArray(llmCalls.runId, set)),
    db.select({ sum: sql<string>`coalesce(sum(${dataCalls.costUsd}), 0)` }).from(dataCalls).where(inArray(dataCalls.runId, set)),
  ]);

  const caseIds = caseRows.map((c) => c.id);
  const gutRows = caseIds.length === 0 ? [] : await db
    .selectDistinctOn([scores.caseId], { caseId: scores.caseId, value: scores.value })
    .from(scores)
    .where(and(inArray(scores.caseId, caseIds), eq(scores.by, 'owner'), eq(scores.criterion, 'gut')))
    .orderBy(scores.caseId, desc(scores.createdAt));

  const perRun = new Map<string, Set<string>>();
  for (const r of buyerRows) {
    const norm = normaliseBuyerType(r.buyerType ?? '');
    if (!norm) continue;
    const s = perRun.get(r.runId) ?? new Set<string>();
    s.add(norm);
    perRun.set(r.runId, s);
  }

  const num = (x: unknown) => (x === null || x === undefined ? null : Number.isFinite(Number(x)) ? Number(x) : null);
  return {
    ideaCount: Number(ideaCountRow?.n ?? 0),
    within,
    history,
    buyerCounts: [...perRun.values()].map((s) => s.size),
    cited: { total: Number(citedRow?.total ?? 0), yes: Number(citedRow?.yes ?? 0) },
    caseRows: caseRows.map((c) => ({ roi: num(c.roi), gm: num(c.gm) })),
    gut: gutRows.map((g) => g.value),
    entrants: { total: Number(entrantRow?.total ?? 0), wasted: Number(entrantRow?.wasted ?? 0) },
    cost: Number(llm?.sum ?? 0) + Number(dat?.sum ?? 0),
  };
}

function buildMetrics(d: Data): MetricResult[] {
  const NEED_EMBEDDINGS = 'Needs at least 2 generated ideas with embeddings.';
  const NO_CASES = 'No cases in this set.';
  const share = (k: number, n: number, meets: (v: number) => boolean, suffix = ''): Row =>
    measured(k / n, `${pct(k / n)} (${k} of ${n})${suffix}`, meets(k / n));
  const nCases = d.caseRows.length;
  const rois = d.caseRows.flatMap((c) => (c.roi === null ? [] : [c.roi]));
  const medianRoi = median(rois);

  const rows: Partial<Record<MetricId, Row>> = {
    repetition: d.within.length === 0 ? noData(NEED_EMBEDDINGS) : (() => {
      const v = mean(d.within);
      return measured(v, v.toFixed(2), v < REPETITION_TARGET);
    })(),
    nearDuplicates: d.within.length === 0 ? noData(NEED_EMBEDDINGS)
      : share(d.within.filter((s) => s >= NEAR_DUPLICATE_SIM).length, d.within.length, (v) => v < NEAR_DUPLICATES_TARGET),
    buyerVariety: d.buyerCounts.length === 0 ? noData('No run in this set has buyer types.') : (() => {
      const v = mean(d.buyerCounts);
      return measured(v, `${v.toFixed(1)} per run`, v >= BUYER_VARIETY_TARGET);
    })(),
    realNeed: d.cited.total === 0 ? noData('No generated idea in this set cites a signal.')
      : share(d.cited.yes, d.cited.total, (v) => v >= REAL_NEED_TARGET),
    customerReturn: nCases === 0 ? noData(NO_CASES)
      : share(d.caseRows.filter((c) => c.roi !== null && c.roi >= ROI_BAR).length, nCases, (v) => v === 1,
        medianRoi === null ? ', no median' : `, median ${medianRoi.toFixed(2)}×`),
    margin: nCases === 0 ? noData(NO_CASES)
      : share(d.caseRows.filter((c) => c.gm !== null && c.gm >= MARGIN_BAR).length, nCases, (v) => v === 1),
    wastedEntrants: d.entrants.total === 0 ? noData('No generated idea in this set reached the gate.')
      : share(d.entrants.wasted, d.entrants.total, (v) => v < WASTED_TARGET),
    ownerVerdict: d.gut.length === 0
      ? noData(nCases === 0 ? NO_CASES : 'Give each case a gut score to fill this in.', 'no scores yet')
      : (() => {
        const v = mean(d.gut);
        return measured(v, `${v.toFixed(1)} (${d.gut.length} of ${nCases} scored)`, v >= OWNER_VERDICT_TARGET && d.gut.length === nCases);
      })(),
    costPerCase: nCases === 0 ? noData(NO_CASES) : (() => {
      const v = d.cost / nCases;
      return measured(v, `$${v.toFixed(2)}`, null);
    })(),
  };

  return METRIC_DEFS.map((def) => {
    if (def.phase) return { id: def.id, value: null, display: `not measured yet (Phase ${def.phase})`, meets: null, status: 'not_measured' as const };
    const row = rows[def.id];
    if (!row) throw new Error(`scorecard: no rule for metric ${def.id}`);
    return { id: def.id, ...row };
  });
}
