import type { Db } from '@bcg/core/db/client';
import { benchmarkPasses, runs } from '@bcg/core/db/schema';
import { BENCH_REFUSAL } from '@bcg/core/bench/passes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db';
import { request, resetRequest } from '../helpers/next-mocks';

const state = vi.hoisted(() => ({ db: undefined as unknown as Db }));

vi.mock('@/lib/db', () => ({ getDb: () => state.db }));
vi.mock('@/lib/auth/require-owner', () => ({ requireOwnerAction: async () => {}, requireOwner: async () => {} }));
vi.mock('next/cache', () => import('../helpers/next-mocks').then((m) => m.nextCacheMock));
vi.mock('next/navigation', () => import('../helpers/next-mocks').then((m) => m.nextNavigationMock));

const { runBenchmarkAction } = await import('@/actions/bench');

beforeEach(async () => {
  state.db = await createTestDb();
  resetRequest();
});

describe('runBenchmarkAction', () => {
  it('queues 4 runs as a running pass and revalidates the pages that show them', async () => {
    expect(await runBenchmarkAction({}, new FormData())).toEqual({ ok: true });
    expect(await state.db.select().from(runs)).toHaveLength(4);
    const [pass] = await state.db.select().from(benchmarkPasses);
    expect(pass!.status).toBe('running');
    expect(request.revalidated).toEqual(expect.arrayContaining(['/progress', '/runs', '/command']));
  });

  it('refuses a second press while a pass is running, and queues nothing more', async () => {
    await runBenchmarkAction({}, new FormData());
    expect(await runBenchmarkAction({}, new FormData())).toEqual({ error: BENCH_REFUSAL.pass_running });
    expect(await state.db.select().from(runs)).toHaveLength(4);
  });

  it('refuses while other runs are waiting', async () => {
    await state.db.insert(runs).values({ config: {} as never, status: 'queued' });
    expect(await runBenchmarkAction({}, new FormData())).toEqual({ error: BENCH_REFUSAL.busy });
    expect(await state.db.select().from(benchmarkPasses)).toHaveLength(0);
  });
});
