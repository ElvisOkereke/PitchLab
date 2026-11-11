import { and, count, desc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { benchmarkPasses, cases, ideas, lenses, markets, runStages, runStatus, runs, sketches } from '../db/schema';
import { TOP_SKETCHES } from '../pipeline/engine/kinds';
import { STAGES, defaultRunConfig, type RunConfig } from '../pipeline/types';
import { scrubError } from '../tools/scrub';
import { FINDS_SEED_MAX, resolveFindsSeed } from '../finds/store';

// ---- Run config ----------------------------------------------------------------------------------

const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** Zod mirror of RunConfig with hard bounds. The worker re-validates every stored config with it before executing. */
export const RunConfigSchema = z.object({
  seedType: z.enum(['open', 'sector', 'lens', 'idea', 'finds']),
  sectors: z.array(z.string().max(100)).max(8).optional(),
  lensIds: z.array(z.string().max(100)).max(8).optional(),
  ideaText: z.string().max(20_000).optional(),
  findIds: z.array(z.uuid()).max(FINDS_SEED_MAX).optional(),
  marketId: z.string().min(1).max(50),
  ideaCount: int(1, 30),
  advanceCount: int(1, 10),
  maxSearchesPerCall: int(1, 10),
  researchSearchesPerSector: int(1, 6).optional(),
  minSignals: int(1, 10),
  dedupeThreshold: z.number().min(0.5).max(0.99),
  overturnOfIdeaId: z.uuid().optional(),
  /** Absent on runs stored before engine v2: they stay v1 (usesEngineV2). */
  engine: z.enum(['v1', 'v2']).optional(),
}).refine((c) => c.seedType !== 'finds' || (c.findIds?.length ?? 0) > 0, {
  // Queueing (dashboard, CLI) always fixes a finds run to its finds, so a resumed run uses the same ones (R20).
  message: 'A finds run needs its finds.', path: ['findIds'],
});

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _configMatches: Same<z.infer<typeof RunConfigSchema>, RunConfig> = true;
void _configMatches;

// ---- Queue input ---------------------------------------------------------------------------------

const counts = {
  ideaCount: z.number({ error: 'Ideas must be a whole number from 1 to 30.' }).int('Ideas must be a whole number from 1 to 30.')
    .min(1, 'Ideas must be at least 1.').max(30, 'Ideas must be at most 30.').default(12),
  advanceCount: z.number({ error: 'Advance must be a whole number from 1 to 10.' }).int('Advance must be a whole number from 1 to 10.')
    .min(1, 'Advance must be at least 1.').max(10, 'Advance must be at most 10.').default(3),
};

/**
 * What the dashboard may queue. Out-of-range values are rejected with a message, never clamped. Sectors are checked
 * against the market and lenses against the active lenses in queueRun. Keys outside the variant are dropped.
 */
export const QueueRunInputSchema = z.discriminatedUnion('seedType', [
  z.object({ seedType: z.literal('open'), ...counts }),
  z.object({
    seedType: z.literal('sector'),
    sectors: z.array(z.string().trim().min(1).max(100)).min(1, 'Pick at least one sector.').max(8, 'Pick at most 8 sectors.'),
    ...counts,
  }),
  z.object({
    seedType: z.literal('lens'),
    lensIds: z.array(z.string().trim().min(1).max(100)).min(1, 'Pick at least one lens.').max(8, 'Pick at most 8 lenses.'),
    ...counts,
  }),
  z.object({
    seedType: z.literal('finds'),
    /** Optional: with none, queueRun uses the most recent captured finds. Each must be a captured find (checked in queueRun). */
    findIds: z.array(z.string().trim().min(1).max(100)).max(FINDS_SEED_MAX, `Pick at most ${FINDS_SEED_MAX} finds.`).optional(),
    ...counts,
  }),
  z.object({
    seedType: z.literal('idea'),
    ideaText: z.string().trim().min(50, 'Describe the idea in at least 50 characters.').max(20_000, 'The idea text is at most 20,000 characters.'),
    ...counts,
  }),
], { error: 'Pick how to seed the run.' }).refine((x) => x.advanceCount <= x.ideaCount, {
  message: 'Advance cannot be more than the number of ideas.',
  path: ['advanceCount'],
});
export type QueueRunInput = z.infer<typeof QueueRunInputSchema>;

/** Most runs that may wait in the queue at once. */
export const MAX_QUEUED = 3;
/** The market every dashboard-queued run uses. */
export const QUEUE_MARKET_ID = 'ca-us';
const MARKET_ID = QUEUE_MARKET_ID;
/** Serialises queue inserts so two submits cannot both pass the MAX_QUEUED check (transaction-scoped lock). */
export const QUEUE_LOCK_KEY = 0x6263_7131; // "bcq1"

export type QueueResult =
  /** `findIds`: for a finds seed, the finds the run was fixed to. */
  | { ok: true; id: string; findIds?: string[] }
  | { ok: false; reason: 'too_many_queued' | 'unknown_lens' | 'unknown_sector' | 'unknown_find' | 'no_finds' | 'too_many_finds'; detail?: string };

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function insertQueued(tx: Tx, config: RunConfig): Promise<QueueResult> {
  await tx.execute(sql`select pg_advisory_xact_lock(${QUEUE_LOCK_KEY})`);
  const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(runs).where(eq(runs.status, 'queued'));
  if (n >= MAX_QUEUED) return { ok: false, reason: 'too_many_queued' };
  const [row] = await tx.insert(runs).values({ config: RunConfigSchema.parse(config), status: 'queued' }).returning({ id: runs.id });
  return { ok: true, id: row!.id };
}

/** Queues a run for `gen worker` with the same config shape as `gen run` (defaultRunConfig, market ca-us). */
export async function queueRun(db: Db, raw: QueueRunInput): Promise<QueueResult> {
  const input = QueueRunInputSchema.parse(raw);
  if (input.seedType === 'sector') {
    const [market] = await db.select({ sectors: markets.sectors }).from(markets).where(eq(markets.id, MARKET_ID));
    const unknown = input.sectors.filter((s) => !market?.sectors.includes(s));
    if (unknown.length) return { ok: false, reason: 'unknown_sector', detail: unknown.join(', ') };
  }
  if (input.seedType === 'lens') {
    const found = await db.select({ id: lenses.id }).from(lenses).where(and(inArray(lenses.id, input.lensIds), eq(lenses.active, true)));
    const unknown = input.lensIds.filter((l) => !found.some((f) => f.id === l));
    if (unknown.length) return { ok: false, reason: 'unknown_lens', detail: unknown.join(', ') };
  }
  if (input.seedType === 'finds') {
    // The finds are fixed when the run is queued, so the run always works from the same finds (R20).
    const seed = await resolveFindsSeed(db, input.findIds);
    if (!seed.ok) return seed.detail ? { ok: false, reason: seed.reason, detail: seed.detail } : { ok: false, reason: seed.reason };
    const config = defaultRunConfig({ marketId: MARKET_ID, ...input, findIds: seed.findIds });
    const res = await db.transaction((tx) => insertQueued(tx, config));
    return res.ok ? { ...res, findIds: seed.findIds } : res;
  }
  const config = defaultRunConfig({ marketId: MARKET_ID, ...input });
  return db.transaction((tx) => insertQueued(tx, config));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `failed → queued` only, within MAX_QUEUED (same lock as queueRun); the worker's executeRun then resumes from the
 * failed stage.
 */
export async function requeueRun(
  db: Db,
  runId: string,
): Promise<{ ok: boolean; reason?: 'not_found' | 'not_failed' | 'too_many_queued' }> {
  if (typeof runId !== 'string' || !UUID.test(runId)) return { ok: false, reason: 'not_found' };
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${QUEUE_LOCK_KEY})`);
    const [row] = await tx.select({ status: runs.status }).from(runs).where(eq(runs.id, runId));
    if (!row) return { ok: false, reason: 'not_found' as const };
    if (row.status !== 'failed') return { ok: false, reason: 'not_failed' as const };
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(runs).where(eq(runs.status, 'queued'));
    if (n >= MAX_QUEUED) return { ok: false, reason: 'too_many_queued' as const };
    const updated = await tx.update(runs)
      .set({ status: 'queued', error: null, finishedAt: null })
      .where(and(eq(runs.id, runId), eq(runs.status, 'failed')))
      .returning({ id: runs.id });
    return updated.length ? { ok: true } : { ok: false, reason: 'not_failed' as const };
  });
}

/**
 * Queues a gate-killed idea again as an owner idea (seed `idea`, text built from the idea's fields) with
 * `overturnOfIdeaId` set. Owner ideas keep the advisory gate and bypass dedupe/screen. Idempotent while a rerun of
 * the same idea is still queued or running.
 */
export async function queueGateKillRerun(
  db: Db,
  ideaId: string,
): Promise<QueueResult | { ok: false; reason: 'not_found' | 'not_gated_out' }> {
  if (typeof ideaId !== 'string' || !UUID.test(ideaId)) return { ok: false, reason: 'not_found' };
  const [idea] = await db.select().from(ideas).where(eq(ideas.id, ideaId));
  if (!idea) return { ok: false, reason: 'not_found' };
  if (idea.status !== 'gated_out') return { ok: false, reason: 'not_gated_out' };
  const ideaText = [
    `Title: ${idea.title}`,
    `One-liner: ${idea.oneLiner}`,
    `Buyer: ${idea.buyer}`,
    `Problem: ${idea.problem}`,
    `Solution: ${idea.solution}`,
    ...(idea.functionalGap ? [`Functional gap: ${idea.functionalGap}`] : []),
  ].join('\n').slice(0, 20_000);
  const config = defaultRunConfig({ seedType: 'idea', marketId: MARKET_ID, ideaText, overturnOfIdeaId: ideaId });
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${QUEUE_LOCK_KEY})`);
    const [existing] = await tx.select({ id: runs.id }).from(runs).where(and(
      inArray(runs.status, ['queued', 'running']),
      eq(sql`${runs.config} ->> 'overturnOfIdeaId'`, ideaId),
    ));
    if (existing) return { ok: true, id: existing.id } as const;
    return insertQueued(tx, config);
  });
}

// ---- History -------------------------------------------------------------------------------------

/** Most runs per page of the run history. */
export const RUNS_PAGE_MAX = 50;
const RUNS_PAGE_DEFAULT = 20;
const PAGE_CEILING = 1_000_000;
const IDEA_TEXT_SHOWN = 200;

export type RunRow = typeof runs.$inferSelect;
export type RunStageSummary = { stage: string; status: (typeof runStages.$inferSelect)['status']; startedAt: Date | null; finishedAt: Date | null };
/** One idea of a run, as the Runs page lists it: no body text, only what the owner needs to recognise and rate it. */
export type RunIdeaRow = {
  id: string; origin: (typeof ideas.$inferSelect)['origin']; title: string; oneLiner: string; status: (typeof ideas.$inferSelect)['status'];
  ownerRating: number | null; ownerTags: string[] | null;
  /** Slug of the case this idea became, or null. */
  caseSlug: string | null;
};
/** A case a run produced, as the Runs page links it. */
export type RunCaseLink = { id: string; slug: string; title: string };
/** One of the sketches that went on (evolve output, else tournament output), as the Runs page lists it. `parent` is set for an evolved variant. */
export type TournamentSketch = {
  id: string; title: string; elo: number | null; cell: string | null; operator: string | null;
  parent: { id: string; title: string } | null;
  /** Evolved variants of this sketch (kept ones). */
  variants: { id: string; title: string; operator: string | null; elo: number | null }[];
};
/** A v2 run's tournament: the sketches that went on, how many were dropped as repeats, and the archive's figures. Null for runs without sketches. */
export type RunTournament = {
  top: TournamentSketch[]; dropped: number; total: number;
  uniqueShare: number | null; cells: number | null; fallback: string | null;
};

export type RunListRow = RunRow & {
  /** The v2 engine's tournament, or null for a v1 run (no sketches). */
  tournament: RunTournament | null;
  /** All cases of the run (the count is not capped). */
  caseCount: number;
  /** Benchmark pass label when the run belongs to one. */
  passLabel: string | null;
  /** At most RUN_CASES_MAX cases of the run, oldest first. */
  cases: RunCaseLink[];
  stages: RunStageSummary[]; ideas: RunIdeaRow[];
};

/** Most sketch rows read for one page of runs (50 runs of about 60 sketches, with room for variants). */
const SKETCHES_PER_PAGE_MAX = 5_000;

/**
 * Builds one run's tournament view from its sketch rows and the archive/ideate stage figures. The top list is the list
 * that went on (`wentOn`: the evolve output's sketch ids, else the tournament's, in their order); only a run that has
 * not finished its tournament falls back to the kept sketches by Elo.
 */
function tournamentOf(
  rows: { id: string; title: string; elo: number | null; cell: string | null; operator: string | null; parentSketchId: string | null; status: string }[],
  figures: { uniqueShare: number | null; cells: number | null; fallback: string | null },
  wentOn: string[] | null,
): RunTournament | null {
  if (rows.length === 0) return null;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ranked = wentOn
    ? wentOn.flatMap((id) => byId.get(id) ?? []).slice(0, TOP_SKETCHES)
    : rows.filter((r) => r.status === 'kept' && r.elo !== null).sort((a, b) => b.elo! - a.elo! || (a.id < b.id ? -1 : 1)).slice(0, TOP_SKETCHES);
  const top = ranked.map((r) => {
    const parent = r.parentSketchId ? byId.get(r.parentSketchId) : undefined;
    return {
      id: r.id, title: r.title, elo: r.elo, cell: r.cell, operator: r.operator,
      parent: parent ? { id: parent.id, title: parent.title } : null,
      variants: rows.filter((v) => v.parentSketchId === r.id && v.status === 'kept').map((v) => ({ id: v.id, title: v.title, operator: v.operator, elo: v.elo })),
    };
  });
  return { top, dropped: rows.filter((r) => r.status === 'duplicate' || r.status === 'near_killed').length, total: rows.length, ...figures };
}

const wentOnOf = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null);

/** Most cases listed per run on the Runs page. */
export const RUN_CASES_MAX = 50;
/** Most cases read for one page of runs. */
const CASES_PER_PAGE_MAX = RUN_CASES_MAX * RUNS_PAGE_MAX;

/** Where a case came from: its run, how the run was seeded (idea text cut to 200 chars) and the benchmark pass, if any. */
export type RunOrigin = { runId: string; createdAt: Date; seed: Partial<RunConfig>; passLabel: string | null };

/** SQL for a case's origin: the seed keys only, so a long owner idea text is cut in the database, not shipped whole. */
export const runSeedSql = sql<Partial<RunConfig>>`jsonb_build_object('seedType', ${runs.config} -> 'seedType', 'sectors', ${runs.config} -> 'sectors', 'lensIds', ${runs.config} -> 'lensIds', 'ideaText', left(${runs.config} ->> 'ideaText', ${IDEA_TEXT_SHOWN}))`;

/** Maps a joined origin row (run left-joined from the idea) to a RunOrigin; null when there is no visible run (example runs are hidden). */
export function toRunOrigin(r: { runId: string | null; createdAt: Date | null; seed: Partial<RunConfig> | null; passLabel: string | null; isExample: boolean | null }): RunOrigin | null {
  if (!r.runId || !r.createdAt || r.isExample !== false) return null;
  return { runId: r.runId, createdAt: r.createdAt, seed: r.seed ?? {}, passLabel: r.passLabel ?? null };
}

/** The 1-based history page a run is on at `pageSize`, or null for a malformed, unknown or example run. */
export async function runPageOf(db: Db, runId: string, pageSize: number): Promise<number | null> {
  if (typeof runId !== 'string' || !UUID.test(runId)) return null;
  const size = Math.min(Math.max(intOr(pageSize, RUNS_PAGE_DEFAULT), 1), RUNS_PAGE_MAX);
  const [run] = await db.select({ createdAt: runs.createdAt }).from(runs).where(and(eq(runs.id, runId), eq(runs.isExample, false)));
  if (!run) return null;
  const [newer] = await db.select({ n: count() }).from(runs).where(and(
    eq(runs.isExample, false),
    or(gt(runs.createdAt, run.createdAt), and(eq(runs.createdAt, run.createdAt), gt(runs.id, runId))),
  ));
  return clampPage(Math.floor((newer?.n ?? 0) / size) + 1);
}
/** Most ideas read for one page of runs (50 runs of up to 30 ideas, with room for owner reruns). */
const IDEAS_PER_PAGE_MAX = 2_000;

const intOr = (v: unknown, d: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? Math.trunc(n) : d;
};
const stageOrder = (s: string) => {
  const i = (STAGES as readonly string[]).indexOf(s);
  return i === -1 ? STAGES.length : i;
};

export type RunStatus = (typeof runStatus.enumValues)[number];

/** How many runs are in each status (command center, and the Runs page's auto-refresh while work is pending). */
export async function countRunsByStatus(db: Db): Promise<Record<RunStatus, number>> {
  const rows = await db.select({ status: runs.status, n: count() }).from(runs).where(eq(runs.isExample, false)).groupBy(runs.status);
  return Object.fromEntries(runStatus.enumValues.map((s) => [s, rows.find((r) => r.status === s)?.n ?? 0])) as Record<RunStatus, number>;
}

/** True while a run waits in the queue (the feeds job yields to it). One indexed row read. */
export async function hasQueuedRun(db: Db): Promise<boolean> {
  return (await db.select({ id: runs.id }).from(runs).where(eq(runs.status, 'queued')).limit(1)).length > 0;
}

/** Page ≥ 1 (anything else → 1). */
export const clampPage = (page: unknown) => Math.min(Math.max(intOr(page, 1), 1), PAGE_CEILING);

/** Newest runs first, with case counts and stage rows (never stage outputs); idea text cut to 200 chars. */
export async function listRuns(db: Db, o: { page?: number; pageSize?: number }): Promise<{ rows: RunListRow[]; total: number }> {
  const pageSize = Math.min(Math.max(intOr(o.pageSize, RUNS_PAGE_DEFAULT), 1), RUNS_PAGE_MAX);
  const page = clampPage(o.page);
  const [runRows, [totalRow]] = await Promise.all([
    db.select({ run: runs, passLabel: benchmarkPasses.label }).from(runs)
      .leftJoin(benchmarkPasses, eq(benchmarkPasses.id, runs.benchmarkPassId))
      .where(eq(runs.isExample, false)).orderBy(desc(runs.createdAt), desc(runs.id)).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ n: count() }).from(runs).where(eq(runs.isExample, false)),
  ]);
  const rows = runRows.map((r) => ({ ...r.run, passLabel: r.passLabel ?? null }));
  const ids = rows.map((r) => r.id);
  const [caseCounts, caseRows, stageRows, ideaRows, sketchRows, figureRows] = ids.length === 0 ? [[], [], [], [], [], []] : await Promise.all([
    db.select({ runId: ideas.runId, n: count(cases.id) }).from(cases)
      .innerJoin(ideas, eq(cases.ideaId, ideas.id))
      .where(inArray(ideas.runId, ids))
      .groupBy(ideas.runId),
    db.select({ runId: ideas.runId, id: cases.id, slug: cases.slug, title: cases.title }).from(cases)
      .innerJoin(ideas, eq(cases.ideaId, ideas.id))
      .where(inArray(ideas.runId, ids))
      .orderBy(cases.createdAt, cases.id).limit(CASES_PER_PAGE_MAX),
    db.select({ runId: runStages.runId, stage: runStages.stage, status: runStages.status, startedAt: runStages.startedAt, finishedAt: runStages.finishedAt })
      .from(runStages)
      .where(inArray(runStages.runId, ids)),
    db.select({
      id: ideas.id, runId: ideas.runId, origin: ideas.origin, title: ideas.title, oneLiner: ideas.oneLiner, status: ideas.status,
      ownerRating: ideas.ownerRating, ownerTags: ideas.ownerTags, caseSlug: cases.slug,
    }).from(ideas).leftJoin(cases, eq(cases.ideaId, ideas.id)).where(inArray(ideas.runId, ids)).orderBy(ideas.createdAt, ideas.id).limit(IDEAS_PER_PAGE_MAX),
    // Light columns only (never the embedding).
    db.select({
      runId: sketches.runId, id: sketches.id, title: sketches.title, elo: sketches.elo, cell: sketches.cell, operator: sketches.operator,
      parentSketchId: sketches.parentSketchId, status: sketches.status,
    }).from(sketches).where(inArray(sketches.runId, ids)).orderBy(sketches.createdAt, sketches.id).limit(SKETCHES_PER_PAGE_MAX),
    // Only three figures of the stage outputs, read in the database (outputs spread forward and can be large).
    db.select({
      runId: runStages.runId, stage: runStages.stage,
      uniqueShare: sql<number | null>`case when jsonb_typeof(${runStages.output} -> 'uniqueShare') = 'number' then (${runStages.output} ->> 'uniqueShare')::float8 end`,
      cells: sql<number | null>`case when jsonb_typeof(${runStages.output} -> 'cells') = 'number' then (${runStages.output} ->> 'cells')::float8 end`,
      fallback: sql<string | null>`case when jsonb_typeof(${runStages.output} -> 'fallback') = 'string' then left(${runStages.output} ->> 'fallback', 20) end`,
      // The list that went on (tournament and evolve only; bounded, they hold at most TOP_SKETCHES).
      wentOn: sql<string[] | null>`case when ${runStages.stage} in ('tournament', 'evolve') and jsonb_typeof(${runStages.output} -> 'sketchIds') = 'array'
        then jsonb_path_query_array(${runStages.output}, '$.sketchIds[0 to 49]') end`,
    }).from(runStages).where(and(inArray(runStages.runId, ids), inArray(runStages.stage, ['archive', 'ideate', 'tournament', 'evolve']))),
  ]);
  return {
    total: totalRow?.n ?? 0,
    rows: rows.map((r) => ({
      ...r,
      // D2-R1: legacy rows may hold unscrubbed errors.
      error: r.error === null ? null : scrubError(r.error),
      config: r.config.ideaText !== undefined ? { ...r.config, ideaText: r.config.ideaText.slice(0, IDEA_TEXT_SHOWN) } : r.config,
      tournament: tournamentOf(sketchRows.filter((k) => k.runId === r.id), {
        uniqueShare: figureRows.find((f) => f.runId === r.id && f.stage === 'archive')?.uniqueShare ?? null,
        cells: figureRows.find((f) => f.runId === r.id && f.stage === 'archive')?.cells ?? null,
        fallback: figureRows.find((f) => f.runId === r.id && f.stage === 'ideate')?.fallback ?? null,
      }, wentOnOf(figureRows.find((f) => f.runId === r.id && f.stage === 'evolve')?.wentOn
        ?? figureRows.find((f) => f.runId === r.id && f.stage === 'tournament')?.wentOn)),
      caseCount: caseCounts.find((c) => c.runId === r.id)?.n ?? 0,
      cases: caseRows.filter((c) => c.runId === r.id).slice(0, RUN_CASES_MAX).map(({ id, slug, title }) => ({ id, slug, title })),
      ideas: ideaRows.filter((i) => i.runId === r.id).map(({ runId: _runId, ...i }) => ({ ...i, caseSlug: i.caseSlug ?? null })),
      stages: stageRows.filter((s) => s.runId === r.id)
        .sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage))
        .map(({ stage, status, startedAt, finishedAt }) => ({ stage, status, startedAt, finishedAt })),
    })),
  };
}
