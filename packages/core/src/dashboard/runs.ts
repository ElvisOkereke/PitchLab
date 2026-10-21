import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { cases, ideas, lenses, markets, runStages, runStatus, runs } from '../db/schema';
import { STAGES, defaultRunConfig, type RunConfig } from '../pipeline/types';
import { scrubError } from '../tools/scrub';

// ---- Run config ----------------------------------------------------------------------------------

const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** Zod mirror of RunConfig with hard bounds. The worker re-validates every stored config with it before executing. */
export const RunConfigSchema = z.object({
  seedType: z.enum(['open', 'sector', 'lens', 'idea']),
  sectors: z.array(z.string().max(100)).max(8).optional(),
  lensIds: z.array(z.string().max(100)).max(8).optional(),
  ideaText: z.string().max(20_000).optional(),
  marketId: z.string().min(1).max(50),
  ideaCount: int(1, 30),
  advanceCount: int(1, 10),
  maxSearchesPerCall: int(1, 10),
  researchSearchesPerSector: int(1, 6).optional(),
  minSignals: int(1, 10),
  dedupeThreshold: z.number().min(0.5).max(0.99),
  overturnOfIdeaId: z.uuid().optional(),
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
const QUEUE_LOCK_KEY = 0x6263_7131; // "bcq1"

export type QueueResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'too_many_queued' | 'unknown_lens' | 'unknown_sector'; detail?: string };

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
export type RunListRow = RunRow & { caseCount: number; stages: RunStageSummary[] };

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

/** Page ≥ 1 (anything else → 1). */
export const clampPage = (page: unknown) => Math.min(Math.max(intOr(page, 1), 1), PAGE_CEILING);

/** Newest runs first, with case counts and stage rows (never stage outputs); idea text cut to 200 chars. */
export async function listRuns(db: Db, o: { page?: number; pageSize?: number }): Promise<{ rows: RunListRow[]; total: number }> {
  const pageSize = Math.min(Math.max(intOr(o.pageSize, RUNS_PAGE_DEFAULT), 1), RUNS_PAGE_MAX);
  const page = clampPage(o.page);
  const [rows, [totalRow]] = await Promise.all([
    db.select().from(runs).where(eq(runs.isExample, false)).orderBy(desc(runs.createdAt), desc(runs.id)).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ n: count() }).from(runs).where(eq(runs.isExample, false)),
  ]);
  const ids = rows.map((r) => r.id);
  const [caseCounts, stageRows] = ids.length === 0 ? [[], []] : await Promise.all([
    db.select({ runId: ideas.runId, n: count(cases.id) }).from(cases)
      .innerJoin(ideas, eq(cases.ideaId, ideas.id))
      .where(inArray(ideas.runId, ids))
      .groupBy(ideas.runId),
    db.select({ runId: runStages.runId, stage: runStages.stage, status: runStages.status, startedAt: runStages.startedAt, finishedAt: runStages.finishedAt })
      .from(runStages)
      .where(inArray(runStages.runId, ids)),
  ]);
  return {
    total: totalRow?.n ?? 0,
    rows: rows.map((r) => ({
      ...r,
      // D2-R1: legacy rows may hold unscrubbed errors.
      error: r.error === null ? null : scrubError(r.error),
      config: r.config.ideaText !== undefined ? { ...r.config, ideaText: r.config.ideaText.slice(0, IDEA_TEXT_SHOWN) } : r.config,
      caseCount: caseCounts.find((c) => c.runId === r.id)?.n ?? 0,
      stages: stageRows.filter((s) => s.runId === r.id)
        .sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage))
        .map(({ stage, status, startedAt, finishedAt }) => ({ stage, status, startedAt, finishedAt })),
    })),
  };
}
