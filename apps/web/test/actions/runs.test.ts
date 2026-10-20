import type { Db } from '@bcg/core/db/client';
import { runs } from '@bcg/core/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedFailedRun, snapshotDb } from '../helpers/db';
import { RedirectError, request, resetRequest } from '../helpers/next-mocks';

const state = vi.hoisted(() => ({ db: undefined as unknown as Db }));

vi.mock('@/lib/db', () => ({ getDb: () => state.db }));
vi.mock('@/lib/auth/require-owner', () => ({ requireOwnerAction: async () => {}, requireOwner: async () => {} }));
vi.mock('next/cache', () => import('../helpers/next-mocks').then((m) => m.nextCacheMock));
vi.mock('next/navigation', () => import('../helpers/next-mocks').then((m) => m.nextNavigationMock));

const { queueRunAction, requeueRunAction } = await import('@/actions/runs');

function form(fields: Record<string, string | string[]>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) fd.append(k, x);
  return fd;
}

const redirectOf = async (p: Promise<unknown>) => {
  const e = await p.catch((err: unknown) => err);
  expect(e).toBeInstanceOf(RedirectError);
  return (e as RedirectError).url;
};

beforeEach(async () => {
  state.db = await createTestDb();
  resetRequest();
});

describe('queueRunAction', () => {
  it('queueRunAction inserts one queued run with the parsed config', async () => {
    const r = await queueRunAction({}, form({ seedType: 'sector', sectors: ['HVAC', 'plumbing'], lensIds: ['aggregator'], ideaText: 'ignored', ideaCount: '5', advanceCount: '2' }));
    expect(r).toEqual({ ok: true });
    const rows = await state.db.select().from(runs);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('queued');
    expect(rows[0]!.config).toMatchObject({ seedType: 'sector', sectors: ['HVAC', 'plumbing'], ideaCount: 5, advanceCount: 2, marketId: 'ca-us' });
    expect(rows[0]!.config).not.toHaveProperty('lensIds');
    expect(rows[0]!.config).not.toHaveProperty('ideaText');
    expect(request.revalidated).toEqual(expect.arrayContaining(['/runs', '/command']));
  });

  it('uses the defaults (12 ideas, advance 3) when the counts are left blank', async () => {
    expect(await queueRunAction({}, form({ seedType: 'open', ideaCount: '', advanceCount: '' }))).toEqual({ ok: true });
    expect((await state.db.select().from(runs))[0]!.config).toMatchObject({ seedType: 'open', ideaCount: 12, advanceCount: 3 });
  });

  it('queueRunAction rejects ideaCount 31, advance > ideas, an unknown lens and a 4th queued run, writing nothing', async () => {
    const before = await snapshotDb(state.db);
    const refused: [Record<string, string | string[]>, string][] = [
      [{ seedType: 'open', ideaCount: '31' }, 'Ideas must be at most 30.'],
      [{ seedType: 'open', ideaCount: '0' }, 'Ideas must be at least 1.'],
      [{ seedType: 'open', ideaCount: 'abc' }, 'Ideas must be a whole number from 1 to 30.'],
      [{ seedType: 'open', ideaCount: '1e9' }, 'Ideas must be a whole number from 1 to 30.'],
      [{ seedType: 'open', ideaCount: '2.5' }, 'Ideas must be a whole number from 1 to 30.'],
      [{ seedType: 'open', ideaCount: '5', advanceCount: '6' }, 'Advance cannot be more than the number of ideas.'],
      [{ seedType: 'lens', lensIds: ['no-such-lens'] }, 'One of the lenses is unknown or inactive. Refresh and try again.'],
      [{ seedType: 'lens' }, 'Pick at least one lens.'],
      [{ seedType: 'sector', sectors: ['Moon mining'] }, 'One of the sectors is not in the market. Refresh and try again.'],
      [{ seedType: 'sector', sectors: ['x'.repeat(101)] }, 'Pick sectors from the list.'],
      [{ seedType: 'idea', ideaText: 'too short' }, 'Describe the idea in at least 50 characters.'],
      [{ seedType: 'idea', ideaText: 'x'.repeat(20_001) }, 'The idea text is at most 20,000 characters.'],
      [{ seedType: 'everything' }, 'Pick how to seed the run.'],
      [{}, 'Pick how to seed the run.'],
    ];
    for (const [fields, error] of refused) expect(await queueRunAction({}, form(fields)), JSON.stringify(fields).slice(0, 80)).toEqual({ error });
    expect(await snapshotDb(state.db)).toEqual(before);

    for (let i = 0; i < 3; i++) expect(await queueRunAction({}, form({ seedType: 'open', ideaCount: '1', advanceCount: '1' }))).toEqual({ ok: true });
    expect(await queueRunAction({}, form({ seedType: 'open', ideaCount: '1', advanceCount: '1' }))).toEqual({ error: '3 runs are already queued. Wait for the worker.' });
    expect(await state.db.select().from(runs)).toHaveLength(3);
  });
});

describe('requeueRunAction', () => {
  it('requeueRunAction only requeues failed runs', async () => {
    const failed = await seedFailedRun(state.db);
    expect(await redirectOf(requeueRunAction(form({ runId: failed.id, page: '2' })))).toBe('/runs?page=2&notice=requeued');
    const [row] = await state.db.select().from(runs).where(eq(runs.id, failed.id));
    expect(row).toMatchObject({ status: 'queued', error: null });
    expect(request.revalidated).toEqual(expect.arrayContaining(['/runs', '/command']));

    // Now queued, not failed.
    expect(await redirectOf(requeueRunAction(form({ runId: failed.id })))).toBe('/runs?notice=requeue_not_failed');
    expect(await redirectOf(requeueRunAction(form({ runId: '00000000-0000-4000-8000-000000000000', page: 'abc' })))).toBe('/runs?notice=requeue_not_found');
  });

  it('maps too_many_queued to its notice and writes nothing', async () => {
    for (let i = 0; i < 3; i++) await queueRunAction({}, form({ seedType: 'open', ideaCount: '1', advanceCount: '1' }));
    const failed = await seedFailedRun(state.db);
    const before = await snapshotDb(state.db);
    expect(await redirectOf(requeueRunAction(form({ runId: failed.id })))).toBe('/runs?notice=requeue_busy');
    expect(await snapshotDb(state.db)).toEqual(before);
  });

  it('rejects a malformed id', async () => {
    const before = await snapshotDb(state.db);
    await expect(requeueRunAction(form({ runId: 'nope' }))).rejects.toThrow('Invalid request.');
    expect(await snapshotDb(state.db)).toEqual(before);
  });
});
