import type { Db } from '@bcg/core/db/client';
import { benchmarkPasses, runs } from '@bcg/core/db/schema';
import { BENCH_REFUSAL, finalizeBenchmarkPasses } from '@bcg/core/bench/passes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db';
import { request, resetRequest } from '../helpers/next-mocks';

const state = vi.hoisted(() => ({ db: undefined as unknown as Db }));

vi.mock('@/lib/db', () => ({ getDb: () => state.db }));
vi.mock('@/lib/auth/require-owner', () => ({ requireOwnerAction: async () => {}, requireOwner: async () => {} }));
vi.mock('next/cache', () => import('../helpers/next-mocks').then((m) => m.nextCacheMock));
vi.mock('next/navigation', () => import('../helpers/next-mocks').then((m) => m.nextNavigationMock));

const { runBenchmarkAction, recomputePassAction } = await import('@/actions/bench');

beforeEach(async () => {
  state.db = await createTestDb();
  resetRequest();
});

describe('runBenchmarkAction', () => {
  it('queues 5 runs as a running pass and revalidates the pages that show them', async () => {
    expect(await runBenchmarkAction({}, new FormData())).toEqual({ ok: true });
    expect(await state.db.select().from(runs)).toHaveLength(5);
    const [pass] = await state.db.select().from(benchmarkPasses);
    expect(pass!.status).toBe('running');
    expect(request.revalidated).toEqual(expect.arrayContaining(['/progress', '/runs', '/command']));
  });

  it('refuses a second press while a pass is running, and queues nothing more', async () => {
    await runBenchmarkAction({}, new FormData());
    expect(await runBenchmarkAction({}, new FormData())).toEqual({ error: BENCH_REFUSAL.pass_running });
    expect(await state.db.select().from(runs)).toHaveLength(5);
  });

  it('refuses while other runs are waiting', async () => {
    await state.db.insert(runs).values({ config: {} as never, status: 'queued' });
    expect(await runBenchmarkAction({}, new FormData())).toEqual({ error: BENCH_REFUSAL.busy });
    expect(await state.db.select().from(benchmarkPasses)).toHaveLength(0);
  });
});

describe('recomputePassAction', () => {
  const fd = (passId: string) => {
    const f = new FormData();
    f.set('passId', passId);
    return f;
  };
  const finishedPass = async () => {
    await runBenchmarkAction({}, new FormData());
    await state.db.update(runs).set({ status: 'succeeded' });
    await finalizeBenchmarkPasses(state.db);
    const [p] = await state.db.select().from(benchmarkPasses);
    return p!;
  };

  it('adds a recompute row for a finished pass and revalidates /progress', async () => {
    const p = await finishedPass();
    expect(await recomputePassAction({}, fd(p.id))).toEqual({ ok: true });
    const rows = await state.db.select().from(benchmarkPasses);
    expect(rows.map((r) => r.kind).sort()).toEqual(['pass', 'recompute']);
    expect(request.revalidated).toContain('/progress');
  });

  it('says so for a missing pass, a bad id, and a pass still running', async () => {
    expect(await recomputePassAction({}, fd('00000000-0000-4000-8000-000000000000'))).toEqual({ error: 'That pass no longer exists.' });
    expect(await recomputePassAction({}, fd('nope'))).toEqual({ error: 'Invalid request. Refresh and try again.' });
    await runBenchmarkAction({}, new FormData());
    const [p] = await state.db.select().from(benchmarkPasses);
    expect(await recomputePassAction({}, fd(p!.id))).toEqual({ error: 'Wait until the pass finishes.' });
    expect(await state.db.select().from(benchmarkPasses)).toHaveLength(1);
  });
});
