import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '../../src/db/client';
import { benchmarkPasses, runs, scores } from '../../src/db/schema';
import { BENCHMARKS } from '../../src/bench/definitions';
import {
  BENCH_REFUSAL, finalizeBenchmarkPasses, listBenchmarkPasses, passCases, passProgress, queueBenchmarkPass, recomputePass, saveBaseline,
} from '../../src/bench/passes';
import { MAX_QUEUED, QUEUE_MARKET_ID } from '../../src/dashboard/runs';
import { defaultRunConfig } from '../../src/pipeline/types';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';

type Status = 'queued' | 'running' | 'succeeded' | 'failed';
const mk = async (db: Db, status: Status, isExample = false) => {
  const r = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
  await db.update(runs).set({ status, isExample }).where(eq(runs.id, r.id));
  return r.id;
};
const setStatus = (db: Db, ids: string[], status: Status) =>
  Promise.all(ids.map((id) => db.update(runs).set({ status }).where(eq(runs.id, id))));
const queued = async (db: Db) => {
  const q = await queueBenchmarkPass(db);
  if (!q.ok) throw new Error('queue failed');
  return q.pass;
};

describe('saveBaseline', () => {
  it('covers finished real runs only; second call is exists; force adds baseline-1', async () => {
    const db = await testDb();
    const a = await mk(db, 'succeeded');
    const b = await mk(db, 'failed');
    await mk(db, 'queued');
    await mk(db, 'running');
    await mk(db, 'succeeded', true);
    const first = await saveBaseline(db);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.pass).toMatchObject({ label: 'baseline-0', kind: 'baseline', status: 'complete', version: 'baseline' });
    expect([...first.pass.runIds].sort()).toEqual([a, b].sort());
    expect(first.pass.metrics?.extra.runs).toBe(2);
    expect(await saveBaseline(db)).toEqual({ ok: false, reason: 'exists' });
    const forced = await saveBaseline(db, { force: true });
    expect(forced.ok && forced.pass.label).toBe('baseline-1');
    expect((await listBenchmarkPasses(db)).length).toBe(2);
  });
});

describe('queueBenchmarkPass', () => {
  it('inserts the bench-v1 runs even when MAX_QUEUED would block', async () => {
    const db = await testDb();
    const q = await queueBenchmarkPass(db);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(MAX_QUEUED).toBeLessThan(4);
    expect(q.pass).toMatchObject({ status: 'running', kind: 'pass', label: 'bench-v1 #1', version: 'bench-v1', metrics: null });
    const rows = await db.select().from(runs).where(eq(runs.benchmarkPassId, q.pass.id));
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.id).sort()).toEqual([...q.pass.runIds].sort());
    for (const r of rows) expect(r.status).toBe('queued');
    const expected = BENCHMARKS['bench-v1'].seeds.map((s) => defaultRunConfig({ ...s, marketId: QUEUE_MARKET_ID, ideaCount: 12, advanceCount: 3 }));
    expect(rows.map((r) => r.config)).toEqual(expect.arrayContaining(expected));
  });

  it('busy inserts nothing when a run is queued or running', async () => {
    const db = await testDb();
    await mk(db, 'queued');
    expect(await queueBenchmarkPass(db)).toEqual({ ok: false, reason: 'busy' });
    expect(await db.select().from(benchmarkPasses)).toHaveLength(0);
    expect(await db.select().from(runs)).toHaveLength(1);
    const db2 = await testDb();
    await mk(db2, 'running');
    expect(await queueBenchmarkPass(db2)).toEqual({ ok: false, reason: 'busy' });
  });

  it('pass_running on a second call; refusal copy', async () => {
    const db = await testDb();
    await queued(db);
    expect(await queueBenchmarkPass(db)).toEqual({ ok: false, reason: 'pass_running' });
    expect(await db.select().from(runs)).toHaveLength(4);
    expect(BENCH_REFUSAL).toEqual({
      busy: 'Wait until the queue is empty before running the benchmark.',
      pass_running: 'A benchmark pass is already running.',
    });
  });

  it('numbers labels per version', async () => {
    const db = await testDb();
    const p = await queued(db);
    await setStatus(db, p.runIds, 'succeeded');
    await finalizeBenchmarkPasses(db);
    expect((await queued(db)).label).toBe('bench-v1 #2');
  });
});

describe('finalizeBenchmarkPasses', () => {
  it('waits while any run is queued or running', async () => {
    const db = await testDb();
    const p = await queued(db);
    await setStatus(db, p.runIds.slice(0, 3), 'succeeded');
    expect(await finalizeBenchmarkPasses(db)).toBe(0);
    await setStatus(db, p.runIds.slice(3), 'running');
    expect(await finalizeBenchmarkPasses(db)).toBe(0);
    const [row] = await db.select().from(benchmarkPasses);
    expect(row!.status).toBe('running');
  });

  it('completes with metrics; second call finalises 0', async () => {
    const db = await testDb();
    const p = await queued(db);
    await setStatus(db, p.runIds, 'succeeded');
    expect(await finalizeBenchmarkPasses(db)).toBe(1);
    const [row] = await listBenchmarkPasses(db);
    expect(row).toMatchObject({ status: 'complete' });
    expect(row!.metrics?.extra.runs).toBe(4);
    expect(row!.completedAt).toBeInstanceOf(Date);
    expect(await finalizeBenchmarkPasses(db)).toBe(0);
  });

  it('one failed run makes it incomplete with a note', async () => {
    const db = await testDb();
    const p = await queued(db);
    await setStatus(db, p.runIds.slice(1), 'succeeded');
    await setStatus(db, p.runIds.slice(0, 1), 'failed');
    expect(await finalizeBenchmarkPasses(db)).toBe(1);
    const [row] = await listBenchmarkPasses(db);
    expect(row!.status).toBe('incomplete');
    expect(row!.metrics?.notes).toContain('1 of 4 runs failed');
    expect(row!.metrics?.extra.runs).toBe(4);
  });
});

describe('frozen passes and recompute', () => {
  it('a gut change leaves metrics unchanged; recompute makes a new row reflecting it', async () => {
    const db = await testDb();
    const p = await queued(db);
    const idea = await insertIdea(db, p.runIds[0]!);
    const c = await insertCase(db, idea.id);
    await setStatus(db, p.runIds, 'succeeded');
    await finalizeBenchmarkPasses(db);
    const [frozen] = await listBenchmarkPasses(db);
    expect(frozen!.metrics?.extra.scoredCases).toBe(0);
    await db.insert(scores).values({ caseId: c.id, criterion: 'gut', value: 4, note: '', by: 'owner' });
    const [again] = await listBenchmarkPasses(db);
    expect(again!.metrics).toEqual(frozen!.metrics);

    const re = await recomputePass(db, p.id);
    expect(re.ok).toBe(true);
    if (!re.ok) return;
    expect(re.pass).toMatchObject({ kind: 'recompute', sourcePassId: p.id, status: 'complete' });
    expect(re.pass.label).toMatch(/^bench-v1 #1 \(recomputed \d{4}-\d\d-\d\d\)$/);
    expect([...re.pass.runIds].sort()).toEqual([...p.runIds].sort());
    expect(re.pass.metrics?.extra.scoredCases).toBe(1);
    expect(await listBenchmarkPasses(db)).toHaveLength(2);
    expect(await passCases(db, p.id)).toEqual([{ slug: expect.any(String), title: 'Case', gut: 4 }]);
  });

  it('recompute refuses unknown and running passes', async () => {
    const db = await testDb();
    expect(await recomputePass(db, '00000000-0000-4000-8000-000000000000')).toEqual({ ok: false, reason: 'not_found' });
    expect(await recomputePass(db, 'nope')).toEqual({ ok: false, reason: 'not_found' });
    const p = await queued(db);
    expect(await recomputePass(db, p.id)).toEqual({ ok: false, reason: 'running' });
  });
});

describe('listing and progress', () => {
  it('lists newest first, bounded; passProgress counts statuses', async () => {
    const db = await testDb();
    const p = await queued(db);
    await setStatus(db, p.runIds.slice(0, 1), 'succeeded');
    await setStatus(db, p.runIds.slice(1, 2), 'failed');
    expect(await passProgress(db, p.id)).toEqual({ queued: 2, running: 0, succeeded: 1, failed: 1 });
    await setStatus(db, p.runIds, 'succeeded');
    await finalizeBenchmarkPasses(db);
    await saveBaseline(db);
    await saveBaseline(db, { force: true });
    const all = await listBenchmarkPasses(db);
    expect(all.map((r) => r.label)).toEqual(['baseline-1', 'baseline-0', 'bench-v1 #1']);
    expect(await listBenchmarkPasses(db, 2)).toHaveLength(2);
  });
});
