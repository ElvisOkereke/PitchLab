import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client';
import { benchmarkPasses, runs } from '../../src/db/schema';
import { listBoard } from '../../src/dashboard/board';
import { getCaseView } from '../../src/dashboard/case-view';
import { RUN_CASES_MAX, listRuns, runPageOf } from '../../src/dashboard/runs';
import { defaultRunConfig } from '../../src/pipeline/types';
import { EXAMPLE_SLUG, ensureExample } from '../../src/example/example';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';

let db: Db;
beforeEach(async () => {
  db = await testDb();
});

async function passRun() {
  const run = await insertRun(db, defaultRunConfig({ seedType: 'sector', sectors: ['HVAC'] }));
  const [pass] = await db.insert(benchmarkPasses).values({ version: 'bench-v3', label: 'bench-v3 #1', kind: 'pass', status: 'complete', runIds: [run.id] }).returning();
  await db.update(runs).set({ benchmarkPassId: pass!.id }).where(eq(runs.id, run.id));
  return run;
}

describe('listRuns: which cases and pass belong to a run', () => {
  it('returns the pass label, each case slug and title, and the case behind each idea', async () => {
    const run = await passRun();
    const plain = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const made = await insertIdea(db, run.id, { title: 'Made it', status: 'advanced' });
    await insertCase(db, made.id, { slug: 'made-it', title: 'Made it case' });
    await insertIdea(db, run.id, { title: 'Killed', status: 'gated_out' });
    await insertIdea(db, plain.id, { title: 'Other', status: 'duplicate' });

    const rows = (await listRuns(db, { page: 1, pageSize: 10 })).rows;
    const r = rows.find((x) => x.id === run.id)!;
    expect(r.passLabel).toBe('bench-v3 #1');
    expect(r.cases).toEqual([{ id: expect.any(String), slug: 'made-it', title: 'Made it case' }]);
    expect(r.caseCount).toBe(1);
    expect(r.ideas.find((i) => i.title === 'Made it')!.caseSlug).toBe('made-it');
    expect(r.ideas.find((i) => i.title === 'Killed')!.caseSlug).toBeNull();
    const p = rows.find((x) => x.id === plain.id)!;
    expect(p.passLabel).toBeNull();
    expect(p.cases).toEqual([]);
  });

  it('caps the cases listed per run but still counts them all', async () => {
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    for (let i = 0; i < RUN_CASES_MAX + 2; i++) {
      await insertCase(db, (await insertIdea(db, run.id, { title: `i${i}` })).id, { slug: `c-${i}`, title: `C ${i}` });
    }
    const r = (await listRuns(db, { page: 1, pageSize: 5 })).rows[0]!;
    expect(r.cases).toHaveLength(RUN_CASES_MAX);
    expect(r.caseCount).toBe(RUN_CASES_MAX + 2);
  });
});

describe('runPageOf', () => {
  it('finds the history page a run is on, and null for unknown or malformed ids', async () => {
    const a = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    await db.update(runs).set({ createdAt: new Date('2026-01-01T00:00:00Z') }).where(eq(runs.id, a.id));
    await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const ids = (await listRuns(db, { page: 1, pageSize: 10 })).rows.map((r) => r.id);
    expect(ids.at(-1)).toBe(a.id);
    expect(await runPageOf(db, a.id, 1)).toBe(3);
    expect(await runPageOf(db, a.id, 2)).toBe(2);
    expect(await runPageOf(db, ids[0]!, 1)).toBe(1);
    expect(await runPageOf(db, '00000000-0000-4000-8000-000000000000', 20)).toBeNull();
    expect(await runPageOf(db, 'x or 1=1', 20)).toBeNull();
  });
});

describe('case view and board origin', () => {
  it('the case view and board card carry the run, its seed and its pass label', async () => {
    const run = await passRun();
    await insertCase(db, (await insertIdea(db, run.id)).id, { slug: 'from-pass', title: 'From pass' });
    const view = (await getCaseView(db, 'from-pass'))!;
    expect(view.origin).toMatchObject({ runId: run.id, passLabel: 'bench-v3 #1', seed: { seedType: 'sector', sectors: ['HVAC'] } });
    expect(view.origin!.createdAt).toBeInstanceOf(Date);
    const card = (await listBoard(db, {})).columns.new.find((c) => c.slug === 'from-pass')!;
    expect(card.origin).toMatchObject({ runId: run.id, passLabel: 'bench-v3 #1', seed: { seedType: 'sector' } });
  });

  it('an owner idea case keeps its run; the idea text in the seed is cut to 200 characters', async () => {
    const run = await insertRun(db, defaultRunConfig({ seedType: 'idea', ideaText: 'y'.repeat(5000) }));
    await insertCase(db, (await insertIdea(db, run.id, { origin: 'owner' })).id, { slug: 'mine', title: 'Mine' });
    const view = (await getCaseView(db, 'mine'))!;
    expect(view.origin!.runId).toBe(run.id);
    expect(view.origin!.passLabel).toBeNull();
    expect(view.origin!.seed.ideaText!.length).toBe(200);
  });

  it('the built-in example has no origin (the Runs page hides example runs)', async () => {
    await ensureExample(db);
    expect((await getCaseView(db, EXAMPLE_SLUG))!.origin).toBeNull();
  });
});
