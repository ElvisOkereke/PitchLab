import type { Db } from '@bcg/core/db/client';
import { TOUR_STATE_KEY, TOUR_VERSION } from '@bcg/core/dashboard/tour';
import { getSetting } from '@bcg/core/validation/settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '../helpers/db';

const state = vi.hoisted(() => ({ db: undefined as unknown as Db, authorised: 0 }));

vi.mock('@/lib/db', () => ({ getDb: () => state.db }));
vi.mock('@/lib/auth/require-owner', () => ({
  requireOwnerAction: async () => {
    state.authorised += 1;
  },
  requireOwner: async () => {},
}));

const { saveTourStateAction } = await import('@/actions/tour');

const GOOD = { version: TOUR_VERSION, completed: ['setup'], current: { chapter: 'generate', step: 1 }, dismissed: false };

beforeEach(async () => {
  state.db = await createTestDb();
  state.authorised = 0;
});

describe('saveTourStateAction', () => {
  it('checks the owner first, then saves a valid state', async () => {
    expect(await saveTourStateAction(GOOD)).toEqual({ ok: true });
    expect(state.authorised).toBe(1);
    expect(await getSetting(state.db, TOUR_STATE_KEY)).toEqual(GOOD);
  });

  it('a bad payload returns { ok: false } and writes nothing', async () => {
    const bad: unknown[] = [
      null, 'x', new FormData(), { ...GOOD, completed: ['nope'] }, { ...GOOD, current: { chapter: 'setup', step: 51 } },
      { ...GOOD, dismissed: 'yes' }, { ...GOOD, version: 0 },
    ];
    for (const b of bad) expect(await saveTourStateAction(b)).toEqual({ ok: false });
    expect(state.authorised).toBe(bad.length);
    expect(await getSetting(state.db, TOUR_STATE_KEY)).toBeNull();
  });

  it('drops unknown keys rather than storing them', async () => {
    expect(await saveTourStateAction({ ...GOOD, extra: '<b>x</b>' })).toEqual({ ok: true });
    expect(await getSetting(state.db, TOUR_STATE_KEY)).toEqual(GOOD);
  });
});
