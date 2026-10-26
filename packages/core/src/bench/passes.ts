// Benchmark passes: baseline snapshots, queued bench passes, finalisation, listing and recompute. Web-safe: drizzle,
// db/schema, a type-only Db and other web-safe core modules. Snapshots are frozen; a recompute is a new row.
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { benchmarkPasses, cases, ideas, runStatus, runs, scores } from '../db/schema';
import { QUEUE_LOCK_KEY, QUEUE_MARKET_ID, type RunStatus } from '../dashboard/runs';
import { defaultRunConfig } from '../pipeline/types';
import { BENCHMARKS, CURRENT_BENCHMARK } from './definitions';
import { SCORECARD_RUNS_MAX, computeScorecard, type Scorecard } from './scorecard';

export type PassRow = {
  id: string;
  version: string;
  label: string;
  kind: 'baseline' | 'pass' | 'recompute';
  status: 'running' | 'complete' | 'incomplete';
  runIds: string[];
  metrics: Scorecard | null;
  sourcePassId: string | null;
  createdAt: Date;
  completedAt: Date | null;
};

export const BENCH_REFUSAL = {
  busy: 'Wait until the queue is empty before running the benchmark.',
  pass_running: 'A benchmark pass is already running.',
} as const;

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const toRow = (r: typeof benchmarkPasses.$inferSelect): PassRow => ({
  id: r.id, version: r.version, label: r.label, kind: r.kind, status: r.status, runIds: r.runIds, metrics: r.metrics,
  sourcePassId: r.sourcePassId, createdAt: r.createdAt, completedAt: r.completedAt,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const lock = (tx: Tx) => tx.execute(sql`select pg_advisory_xact_lock(${QUEUE_LOCK_KEY})`);

/** Scorecard over `runIds`, plus whether all runs succeeded. Failed runs add a note. */
async function scoreRuns(db: Db, runIds: string[], noteFailed = true): Promise<{ metrics: Scorecard; failed: number }> {
  const metrics = await computeScorecard(db, runIds);
  const rows = await db.select({ n: count() }).from(runs).where(and(inArray(runs.id, runIds), eq(runs.status, 'failed')));
  const failed = Number(rows[0]?.n ?? 0);
  if (noteFailed && failed > 0) metrics.notes.push(`${failed} of ${runIds.length} runs failed`);
  return { metrics, failed };
}

/** Freezes today's scorecard over every finished real run (newest 200). Never overwrites; `force` adds another. */
export async function saveBaseline(
  db: Db,
  opts: { force?: boolean } = {},
): Promise<{ ok: true; pass: PassRow } | { ok: false; reason: 'exists' }> {
  const finished = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.isExample, false), inArray(runs.status, ['succeeded', 'failed'])))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(SCORECARD_RUNS_MAX);
  const runIds = finished.map((r) => r.id);
  const metrics = await computeScorecard(db, runIds);
  return db.transaction(async (tx) => {
    await lock(tx);
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(benchmarkPasses).where(eq(benchmarkPasses.kind, 'baseline'));
    if (n > 0 && !opts.force) return { ok: false as const, reason: 'exists' as const };
    const [row] = await tx.insert(benchmarkPasses).values({
      version: 'baseline', label: `baseline-${n}`, kind: 'baseline', status: 'complete', runIds, metrics, completedAt: new Date(),
    }).returning();
    return { ok: true as const, pass: toRow(row!) };
  });
}

/** Queues one run per seed of `version` as a new running pass, only when the queue is empty and no pass is running. */
export async function queueBenchmarkPass(
  db: Db,
  version: keyof typeof BENCHMARKS = CURRENT_BENCHMARK,
): Promise<{ ok: true; pass: PassRow } | { ok: false; reason: 'busy' | 'pass_running' }> {
  const def = BENCHMARKS[version];
  return db.transaction(async (tx) => {
    await lock(tx);
    const [{ p } = { p: 0 }] = await tx.select({ p: count() }).from(benchmarkPasses).where(eq(benchmarkPasses.status, 'running'));
    if (p > 0) return { ok: false as const, reason: 'pass_running' as const };
    const [{ b } = { b: 0 }] = await tx.select({ b: count() }).from(runs).where(inArray(runs.status, ['queued', 'running']));
    if (b > 0) return { ok: false as const, reason: 'busy' as const };
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(benchmarkPasses)
      .where(and(eq(benchmarkPasses.kind, 'pass'), eq(benchmarkPasses.version, version)));
    const [pass] = await tx.insert(benchmarkPasses).values({
      version, label: `${version} #${n + 1}`, kind: 'pass', status: 'running', runIds: [],
    }).returning();
    const inserted = await tx.insert(runs).values(def.seeds.map((seed) => ({
      config: defaultRunConfig({ ...seed, marketId: QUEUE_MARKET_ID, ideaCount: def.ideaCount, advanceCount: def.advanceCount }),
      status: 'queued' as const,
      benchmarkPassId: pass!.id,
    }))).returning({ id: runs.id });
    const [done] = await tx.update(benchmarkPasses).set({ runIds: inserted.map((r) => r.id) })
      .where(eq(benchmarkPasses.id, pass!.id)).returning();
    return { ok: true as const, pass: toRow(done!) };
  });
}

/**
 * Freezes every running pass whose runs have all finished: metrics over all its runs, `complete` (or `incomplete`
 * when any run failed). Idempotent. Returns how many passes it froze.
 */
export async function finalizeBenchmarkPasses(db: Db): Promise<number> {
  const running = await db.select().from(benchmarkPasses).where(eq(benchmarkPasses.status, 'running'));
  let done = 0;
  for (const pass of running) {
    if (pass.runIds.length === 0) continue;
    const rows = await db.select({ status: runs.status }).from(runs).where(inArray(runs.id, pass.runIds));
    if (rows.length < pass.runIds.length || rows.some((r) => r.status === 'queued' || r.status === 'running')) continue;
    const { metrics, failed } = await scoreRuns(db, pass.runIds);
    const updated = await db.update(benchmarkPasses)
      .set({ metrics, status: failed > 0 ? 'incomplete' : 'complete', completedAt: new Date() })
      .where(and(eq(benchmarkPasses.id, pass.id), eq(benchmarkPasses.status, 'running')))
      .returning({ id: benchmarkPasses.id });
    done += updated.length;
  }
  return done;
}

/** A new `recompute` row over the same runs with today's data; the source row stays as it was. */
export async function recomputePass(
  db: Db,
  passId: string,
): Promise<{ ok: true; pass: PassRow } | { ok: false; reason: 'not_found' | 'running' }> {
  if (typeof passId !== 'string' || !UUID_RE.test(passId)) return { ok: false, reason: 'not_found' };
  const [src] = await db.select().from(benchmarkPasses).where(eq(benchmarkPasses.id, passId));
  if (!src) return { ok: false, reason: 'not_found' };
  if (src.status === 'running') return { ok: false, reason: 'running' };
  const { metrics, failed } = await scoreRuns(db, src.runIds, src.kind !== 'baseline');
  const [row] = await db.insert(benchmarkPasses).values({
    version: src.version,
    label: `${src.label} (recomputed ${new Date().toISOString().slice(0, 10)})`,
    kind: 'recompute',
    status: src.kind === 'baseline' ? src.status : failed > 0 ? 'incomplete' : 'complete',
    runIds: src.runIds,
    metrics,
    sourcePassId: src.id,
    completedAt: new Date(),
  }).returning();
  return { ok: true, pass: toRow(row!) };
}

/** Newest first. */
export async function listBenchmarkPasses(db: Db, limit = 50): Promise<PassRow[]> {
  const rows = await db.select().from(benchmarkPasses)
    .orderBy(desc(benchmarkPasses.createdAt), desc(benchmarkPasses.id))
    .limit(Math.min(Math.max(Math.trunc(limit) || 50, 1), 200));
  return rows.map(toRow);
}

/** How many of a pass's runs are in each status. */
export async function passProgress(db: Db, passId: string): Promise<Record<RunStatus, number>> {
  const zero = Object.fromEntries(runStatus.enumValues.map((s) => [s, 0])) as Record<RunStatus, number>;
  if (!UUID_RE.test(passId)) return zero;
  const rows = await db.select({ status: runs.status, n: count() }).from(runs)
    .where(and(eq(runs.benchmarkPassId, passId), eq(runs.isExample, false))).groupBy(runs.status);
  for (const r of rows) zero[r.status] = Number(r.n);
  return zero;
}

/** The cases of a pass's runs, each with the owner's latest gut score (null when unscored). */
export async function passCases(db: Db, passId: string): Promise<{ slug: string; title: string; gut: number | null }[]> {
  if (!UUID_RE.test(passId)) return [];
  const [pass] = await db.select({ runIds: benchmarkPasses.runIds }).from(benchmarkPasses).where(eq(benchmarkPasses.id, passId));
  if (!pass || pass.runIds.length === 0) return [];
  const rows = await db.select({ id: cases.id, slug: cases.slug, title: cases.title })
    .from(cases).innerJoin(ideas, eq(ideas.id, cases.ideaId))
    .where(and(inArray(ideas.runId, pass.runIds), eq(cases.isExample, false)))
    .orderBy(cases.createdAt, cases.id);
  if (rows.length === 0) return [];
  const gut = await db.selectDistinctOn([scores.caseId], { caseId: scores.caseId, value: scores.value })
    .from(scores)
    .where(and(inArray(scores.caseId, rows.map((r) => r.id)), eq(scores.by, 'owner'), eq(scores.criterion, 'gut')))
    .orderBy(scores.caseId, desc(scores.createdAt), desc(scores.id));
  const byCase = new Map(gut.map((g) => [g.caseId, g.value]));
  return rows.map((r) => ({ slug: r.slug, title: r.title, gut: byCase.get(r.id) ?? null }));
}
