import type { Db } from '@bcg/core/db/client';
import { cases } from '@bcg/core/db/schema';
import { ensureExample, exampleState } from '@bcg/core/example/example';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db';
import { RedirectError, request, resetRequest } from '../helpers/next-mocks';

const state = vi.hoisted(() => ({ db: undefined as unknown as Db }));

vi.mock('@/lib/db', () => ({ getDb: () => state.db }));
vi.mock('@/lib/auth/require-owner', () => ({ requireOwnerAction: async () => {}, requireOwner: async () => {} }));
vi.mock('next/cache', () => import('../helpers/next-mocks').then((m) => m.nextCacheMock));
vi.mock('next/navigation', () => import('../helpers/next-mocks').then((m) => m.nextNavigationMock));

const { hideExampleAction, resetExampleAction } = await import('@/actions/example');

const redirectOf = async (p: Promise<unknown>) => {
  const e = await p.catch((err: unknown) => err);
  expect(e).toBeInstanceOf(RedirectError);
  return (e as RedirectError).url;
};
const exampleRows = (db: Db) => db.select().from(cases).where(eq(cases.isExample, true));

beforeEach(async () => {
  state.db = await createTestDb();
  await ensureExample(state.db);
  resetRequest();
});

describe('example actions', () => {
  it('hideExampleAction hides the example, revalidates and redirects with the notice', async () => {
    expect(await redirectOf(hideExampleAction(new FormData()))).toBe('/settings?notice=example_hidden');
    expect(await exampleRows(state.db)).toHaveLength(0);
    expect((await exampleState(state.db)).hidden).toBe(true);
    expect(request.revalidated).toEqual(expect.arrayContaining(['/', '/leaderboard', '/settings']));
  });

  it('resetExampleAction restores one example and shows it again', async () => {
    await redirectOf(hideExampleAction(new FormData()));
    expect(await redirectOf(resetExampleAction(new FormData()))).toBe('/settings?notice=example_reset');
    await redirectOf(resetExampleAction(new FormData()));
    expect(await exampleRows(state.db)).toHaveLength(1);
    expect((await exampleState(state.db)).hidden).toBe(false);
    expect(request.revalidated).toEqual(expect.arrayContaining(['/', '/leaderboard', '/settings']));
  });
});
