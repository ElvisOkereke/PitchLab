import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client';
import { cases, ideas, runStages, runs } from '../../src/db/schema';
import {
  MAX_QUEUED, QUEUE_MARKET_ID, QueueRunInputSchema, RunConfigSchema, countRunsByStatus, hasQueuedRun, listRuns, queueGateKillRerun, queueRun, requeueRun,
} from '../../src/dashboard/runs';
import { BENCHMARKS } from '../../src/bench/definitions';
import { defaultRunConfig } from '../../src/pipeline/types';
import { EXAMPLE_SLUG, ensureExample } from '../../src/example/example';
import { insertCase, insertIdea, insertRun, testDb, unit } from '../helpers/db';
import { seedFind } from '../helpers/finds';
import { resolveFindsSeed } from '../../src/finds/store';

let db: Db;
beforeEach(async () => {
  db = await testDb();
});

const queued = () => db.select().from(runs).where(eq(runs.status, 'queued'));

describe('run config schemas', () => {
  it('every bench-v1 seed config built the way queueBenchmarkPass builds it passes RunConfigSchema', () => {
    const def = BENCHMARKS['bench-v1'];
    for (const seed of def.seeds) {
      const cfg = defaultRunConfig({ ...seed, marketId: QUEUE_MARKET_ID, ideaCount: def.ideaCount, advanceCount: def.advanceCount });
      expect(RunConfigSchema.safeParse(cfg).success).toBe(true);
    }
  });

  it('RunConfigSchema accepts the CLI defaults and rejects absurd values', () => {
    expect(RunConfigSchema.safeParse(defaultRunConfig({ seedType: 'open' })).success).toBe(true);
    // A finds run is always fixed to its finds when queued (R20).
    expect(RunConfigSchema.safeParse(defaultRunConfig({ seedType: 'finds', findIds: ['11111111-1111-4111-8111-111111111111'] })).success).toBe(true);
    for (const patch of [
      { ideaCount: 1e9 }, { ideaCount: 0 }, { advanceCount: 11 }, { maxSearchesPerCall: 11 }, { researchSearchesPerSector: 7 },
      { minSignals: 0 }, { dedupeThreshold: 0.3 }, { dedupeThreshold: 1 }, { sectors: Array(9).fill('x') }, { sectors: ['x'.repeat(101)] },
      { lensIds: Array(9).fill('x') }, { ideaText: 'x'.repeat(20_001) }, { marketId: 'x'.repeat(51) }, { overturnOfIdeaId: 'nope' },
      { seedType: 'chaos' },
      { seedType: 'finds' }, { seedType: 'finds', findIds: [] },
    ]) {
      expect(RunConfigSchema.safeParse({ ...defaultRunConfig({ seedType: 'open' }), ...patch }).success).toBe(false);
    }
  });

  it('QueueRunInputSchema bounds', () => {
    for (const ideaCount of [0, 31, 1e9, 'abc', 2.5]) expect(QueueRunInputSchema.safeParse({ seedType: 'open', ideaCount }).success).toBe(false);
    for (const advanceCount of [0, 11]) expect(QueueRunInputSchema.safeParse({ seedType: 'open', advanceCount }).success).toBe(false);
    const over = QueueRunInputSchema.safeParse({ seedType: 'open', ideaCount: 5, advanceCount: 6 });
    expect(over.success).toBe(false);
    expect(over.error!.issues[0]!.message).toMatch(/advance/i);
    expect(QueueRunInputSchema.safeParse({ seedType: 'idea', ideaText: 'x'.repeat(20_001) }).success).toBe(false);
    expect(QueueRunInputSchema.safeParse({ seedType: 'idea', ideaText: 'too short' }).success).toBe(false);
    expect(QueueRunInputSchema.safeParse({ seedType: 'sector', sectors: [] }).success).toBe(false);
    expect(QueueRunInputSchema.safeParse({ seedType: 'sector', sectors: Array(9).fill('HVAC') }).success).toBe(false);
    expect(QueueRunInputSchema.safeParse({ seedType: 'lens', lensIds: Array(9).fill('aggregator') }).success).toBe(false);
    expect(QueueRunInputSchema.safeParse({ seedType: 'chaos' }).success).toBe(false);
    expect(QueueRunInputSchema.parse({ seedType: 'open' })).toEqual({ seedType: 'open', ideaCount: 12, advanceCount: 3 });
    // Keys that do not belong to the variant are dropped.
    expect(QueueRunInputSchema.parse({ seedType: 'open', sectors: ['HVAC'], marketId: 'evil' })).toEqual({ seedType: 'open', ideaCount: 12, advanceCount: 3 });
  });
});

describe('queueRun', () => {
  it('queueRun inserts a queued run with defaultRunConfig, refuses a 4th queued run and unknown lens/sector', async () => {
    const r = await queueRun(db, QueueRunInputSchema.parse({ seedType: 'sector', sectors: ['HVAC', 'plumbing'], ideaCount: 4, advanceCount: 2 }));
    expect(r.ok).toBe(true);
    const [row] = await db.select().from(runs).where(eq(runs.id, (r as { id: string }).id));
    expect(row!.status).toBe('queued');
    expect(row!.config).toEqual(defaultRunConfig({ seedType: 'sector', marketId: 'ca-us', sectors: ['HVAC', 'plumbing'], ideaCount: 4, advanceCount: 2 }));

    expect(await queueRun(db, QueueRunInputSchema.parse({ seedType: 'sector', sectors: ['HVAC', 'underwater basket weaving'] })))
      .toEqual({ ok: false, reason: 'unknown_sector', detail: 'underwater basket weaving' });
    expect(await queueRun(db, QueueRunInputSchema.parse({ seedType: 'lens', lensIds: ['aggregator', 'nope'] })))
      .toEqual({ ok: false, reason: 'unknown_lens', detail: 'nope' });

    expect((await queueRun(db, QueueRunInputSchema.parse({ seedType: 'lens', lensIds: ['aggregator'] }))).ok).toBe(true);
    expect((await queueRun(db, QueueRunInputSchema.parse({ seedType: 'idea', ideaText: 'An idea that is long enough to pass the fifty character minimum.' }))).ok).toBe(true);
    expect(MAX_QUEUED).toBe(3);
    expect(await queueRun(db, QueueRunInputSchema.parse({ seedType: 'open' }))).toEqual({ ok: false, reason: 'too_many_queued' });
    expect(await queued()).toHaveLength(3);
  });

  it('an inactive lens counts as unknown', async () => {
    const { lenses } = await import('../../src/db/schema');
    await db.update(lenses).set({ active: false }).where(eq(lenses.id, 'aggregator'));
    expect(await queueRun(db, QueueRunInputSchema.parse({ seedType: 'lens', lensIds: ['aggregator'] })))
      .toEqual({ ok: false, reason: 'unknown_lens', detail: 'aggregator' });
  });

  it('requeueRun only moves failed → queued', async () => {
    const failed = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    await db.update(runs).set({ status: 'failed', error: 'boom', finishedAt: new Date() }).where(eq(runs.id, failed.id));
    const ok = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    await db.update(runs).set({ status: 'succeeded' }).where(eq(runs.id, ok.id));

    expect(await requeueRun(db, failed.id)).toEqual({ ok: true });
    const [row] = await db.select().from(runs).where(eq(runs.id, failed.id));
    expect(row).toMatchObject({ status: 'queued', error: null, finishedAt: null });
    expect(await requeueRun(db, failed.id)).toEqual({ ok: false, reason: 'not_failed' });
    expect(await requeueRun(db, ok.id)).toEqual({ ok: false, reason: 'not_failed' });
    expect(await requeueRun(db, randomUUID())).toEqual({ ok: false, reason: 'not_found' });
    expect(await requeueRun(db, 'not-a-uuid')).toEqual({ ok: false, reason: 'not_found' });
  });

  it('requeueRun respects MAX_QUEUED (D2-R3)', async () => {
    const failed = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    await db.update(runs).set({ status: 'failed', error: 'boom' }).where(eq(runs.id, failed.id));
    for (let i = 0; i < MAX_QUEUED; i++) await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    expect(await requeueRun(db, failed.id)).toEqual({ ok: false, reason: 'too_many_queued' });
    expect((await db.select().from(runs).where(eq(runs.id, failed.id)))[0]!.status).toBe('failed');
    expect(await queued()).toHaveLength(MAX_QUEUED);
  });

  it('queueGateKillRerun queues an idea run with overturnOfIdeaId and rejects non-gated_out ideas', async () => {
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    await db.update(runs).set({ status: 'succeeded' }).where(eq(runs.id, run.id));
    const killed = await insertIdea(db, run.id, {
      title: 'Rent notice engine', oneLiner: 'Track notice deadlines', buyer: 'property managers', problem: 'missed notices',
      solution: 'a deadline engine', functionalGap: 'no deadline tracking', status: 'gated_out',
    });
    const advanced = await insertIdea(db, run.id, { status: 'advanced' });

    const r = await queueGateKillRerun(db, killed.id);
    expect(r.ok).toBe(true);
    const [row] = await db.select().from(runs).where(eq(runs.id, (r as { id: string }).id));
    expect(row!.status).toBe('queued');
    expect(row!.config).toMatchObject({ seedType: 'idea', marketId: 'ca-us', overturnOfIdeaId: killed.id, ideaCount: 12, advanceCount: 3 });
    for (const part of ['Rent notice engine', 'Track notice deadlines', 'property managers', 'missed notices', 'a deadline engine', 'no deadline tracking']) {
      expect(row!.config.ideaText).toContain(part);
    }
    expect(RunConfigSchema.safeParse(row!.config).success).toBe(true);

    // Idempotent while the rerun is still queued.
    expect(await queueGateKillRerun(db, killed.id)).toEqual(r);
    expect(await queued()).toHaveLength(1);

    expect(await queueGateKillRerun(db, advanced.id)).toEqual({ ok: false, reason: 'not_gated_out' });
    expect(await queueGateKillRerun(db, randomUUID())).toEqual({ ok: false, reason: 'not_found' });
    expect(await queueGateKillRerun(db, 'x')).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('listRuns', () => {
  it('pages newest first with case counts, stage rows and a cut idea text', async () => {
    const a = await insertRun(db, defaultRunConfig({ seedType: 'idea', ideaText: 'y'.repeat(500) }));
    const b = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    await db.update(runs).set({ createdAt: new Date('2026-10-01T00:00:00Z') }).where(eq(runs.id, a.id));
    const idea = await insertIdea(db, a.id);
    await insertCase(db, idea.id);
    await db.insert(runStages).values([
      { runId: a.id, stage: 'harvest', status: 'done', output: { big: 'x' }, startedAt: new Date(), finishedAt: new Date() },
      { runId: a.id, stage: 'ideate', status: 'failed', startedAt: new Date() },
    ]);
    const page1 = await listRuns(db, { page: 1, pageSize: 1 });
    expect(page1.total).toBe(2);
    expect(page1.rows.map((r) => r.id)).toEqual([b.id]);
    const page2 = await listRuns(db, { page: 2, pageSize: 1 });
    const ra = page2.rows[0]!;
    expect(ra.id).toBe(a.id);
    expect(ra.caseCount).toBe(1);
    expect(ra.config.ideaText).toHaveLength(200);
    expect(ra.stages.map((s) => [s.stage, s.status])).toEqual([['harvest', 'done'], ['ideate', 'failed']]);
    expect(ra.stages[0]).not.toHaveProperty('output');
    void cases; void ideas;
  });

  it('lists each run\'s ideas (both origins) with the owner rating and tags, not the idea body', async () => {
    const a = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const g = await insertIdea(db, a.id, { title: 'Gen idea', ownerRating: 1, ownerTags: ['love it'] });
    const o = await insertIdea(db, a.id, { title: 'Mine', origin: 'owner' });
    const b = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const res = await listRuns(db, {});
    expect(res.rows.find((r) => r.id === b.id)!.ideas).toEqual([]);
    const ra = res.rows.find((r) => r.id === a.id)!;
    expect(ra.ideas.map((i) => i.id).sort()).toEqual([g.id, o.id].sort());
    const gen = ra.ideas.find((i) => i.id === g.id)!;
    expect(gen).toMatchObject({ origin: 'generated', title: 'Gen idea', ownerRating: 1, ownerTags: ['love it'] });
    expect(ra.ideas.find((i) => i.id === o.id)).toMatchObject({ origin: 'owner', ownerRating: null, ownerTags: null });
    expect(gen).not.toHaveProperty('solution');
  });
});

describe('hasQueuedRun', () => {
  it('is true only while a run is queued', async () => {
    const db = await testDb();
    expect(await hasQueuedRun(db)).toBe(false);
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    await db.update(runs).set({ status: 'running' }).where(eq(runs.id, run.id));
    expect(await hasQueuedRun(db)).toBe(false);
    await db.update(runs).set({ status: 'queued' }).where(eq(runs.id, run.id));
    expect(await hasQueuedRun(db)).toBe(true);
  });
});

describe('countRunsByStatus', () => {
  it('counts every run status, zero when absent', async () => {
    expect(await countRunsByStatus(db)).toEqual({ queued: 0, running: 0, succeeded: 0, failed: 0 });
    const cfg = defaultRunConfig({ seedType: 'open' });
    await insertRun(db, cfg);
    await insertRun(db, cfg);
    await db.insert(runs).values([{ config: cfg, status: 'running' }, { config: cfg, status: 'failed', error: 'x' }]);
    expect(await countRunsByStatus(db)).toEqual({ queued: 2, running: 1, succeeded: 0, failed: 1 });
  });
});

describe('example run is hidden', () => {
  it('listRuns and countRunsByStatus exclude the example run', async () => {
    await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const before = await listRuns(db, {});
    await ensureExample(db);
    const after = await listRuns(db, {});
    expect(after.total).toBe(before.total);
    expect(after.rows.every((r) => !r.isExample)).toBe(true);
    expect((await countRunsByStatus(db)).succeeded).toBe(0);
  });
});

describe('finds seed (sources expansion §C)', () => {
  const v = (dim: number) => { const x = unit(0).map(() => 0); x[0] = 0.5; x[dim] = Math.sqrt(0.75); return x; };

  it('schemas accept a finds seed with 1 to 20 find ids (the stored config always has them; the queue input may omit them)', () => {
    const id = randomUUID();
    expect(RunConfigSchema.safeParse(defaultRunConfig({ seedType: 'finds', findIds: [id] })).success).toBe(true);
    expect(RunConfigSchema.safeParse(defaultRunConfig({ seedType: 'finds' })).success).toBe(false);
    expect(RunConfigSchema.safeParse(defaultRunConfig({ seedType: 'finds', findIds: Array.from({ length: 21 }, () => randomUUID()) })).success).toBe(false);
    expect(RunConfigSchema.safeParse(defaultRunConfig({ seedType: 'finds', findIds: ['nope'] })).success).toBe(false);
    expect(QueueRunInputSchema.safeParse({ seedType: 'finds' }).success).toBe(true);
    expect(QueueRunInputSchema.safeParse({ seedType: 'finds', findIds: [id] }).success).toBe(true);
    expect(QueueRunInputSchema.safeParse({ seedType: 'finds', findIds: Array.from({ length: 21 }, () => randomUUID()) }).success).toBe(false);
  });

  it('defaults to the 10 most recent captured finds, stored in the run config', async () => {
    const made: string[] = [];
    for (let i = 0; i < 12; i++) {
      made.push((await seedFind(db, { what: `F${i}`, vec: v(i + 1), createdAt: new Date(Date.UTC(2026, 10, 1 + i)) })).findId);
    }
    await seedFind(db, { what: 'Queued', vec: v(30), status: 'queued', createdAt: new Date(Date.UTC(2026, 10, 25)) });
    await seedFind(db, { what: 'Failed', vec: v(31), status: 'failed', createdAt: new Date(Date.UTC(2026, 10, 26)) });
    const r = await queueRun(db, { seedType: 'finds', ideaCount: 12, advanceCount: 3 });
    expect(r.ok).toBe(true);
    const [row] = await queued();
    expect(row!.config).toMatchObject({ seedType: 'finds', marketId: QUEUE_MARKET_ID });
    expect(row!.config.findIds).toEqual(made.slice(2).reverse());
  });

  it('checks given find ids exist and are captured, keeps their order, and refuses when there are no finds', async () => {
    expect(await queueRun(db, { seedType: 'finds', ideaCount: 12, advanceCount: 3 })).toEqual({ ok: false, reason: 'no_finds' });
    const a = await seedFind(db, { what: 'A', vec: v(1) });
    const b = await seedFind(db, { what: 'B', vec: v(2) });
    const q = await seedFind(db, { what: 'Q', vec: v(3), status: 'queued', noItem: true });
    const missing = randomUUID();
    expect(await queueRun(db, { seedType: 'finds', findIds: [a.findId, q.findId, missing], ideaCount: 12, advanceCount: 3 }))
      .toEqual({ ok: false, reason: 'unknown_find', detail: `${q.findId}, ${missing}` });
    expect(await queueRun(db, { seedType: 'finds', findIds: ['not-a-uuid'], ideaCount: 12, advanceCount: 3 }))
      .toEqual({ ok: false, reason: 'unknown_find', detail: 'not-a-uuid' });
    expect(await queued()).toHaveLength(0);
    expect((await queueRun(db, { seedType: 'finds', findIds: [b.findId, a.findId, b.findId], ideaCount: 12, advanceCount: 3 })).ok).toBe(true);
    expect((await queued())[0]!.config.findIds).toEqual([b.findId, a.findId]);
  });

  it('resolveFindsSeed: the same rules for the CLI', async () => {
    expect(await resolveFindsSeed(db, undefined)).toEqual({ ok: false, reason: 'no_finds' });
    const a = await seedFind(db, { what: 'A', vec: v(1) });
    expect(await resolveFindsSeed(db, [])).toEqual({ ok: true, findIds: [a.findId] });
    expect(await resolveFindsSeed(db, [a.findId])).toEqual({ ok: true, findIds: [a.findId] });
    expect(await resolveFindsSeed(db, Array.from({ length: 21 }, () => a.findId))).toEqual({ ok: true, findIds: [a.findId] });
    const many = Array.from({ length: 21 }, () => randomUUID());
    expect(await resolveFindsSeed(db, many)).toMatchObject({ ok: false, reason: 'too_many_finds' });
  });
});
