import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client';
import {
  TOUR_CHAPTERS, TOUR_STATE_KEY, TOUR_VERSION, TourStateSchema, getTourState, saveTourState, tourCaseSlug,
} from '../../src/dashboard/tour';
import type { TourState } from '../../src/dashboard/tour';
import { EXAMPLE_SLUG, ensureExample } from '../../src/example/example';
import { defaultRunConfig } from '../../src/pipeline/types';
import { getSetting, setSetting } from '../../src/validation/settings';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';

const STATE: TourState = { version: TOUR_VERSION, completed: ['setup'], current: { chapter: 'generate', step: 2 }, dismissed: false };

async function addCase(db: Db, slug: string, o: { stage?: 'new' | 'killed'; createdAt?: Date } = {}) {
  const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
  const idea = await insertIdea(db, run.id);
  return insertCase(db, idea.id, { slug, stage: o.stage ?? 'new', ...(o.createdAt ? { createdAt: o.createdAt } : {}) });
}

describe('tour state', () => {
  it('has eight fixed chapters, version 1 and the tour.state key', () => {
    expect(TOUR_CHAPTERS).toEqual(['setup', 'generate', 'board', 'read', 'score', 'validate', 'outreach', 'decide']);
    expect(TOUR_VERSION).toBe(1);
    expect(TOUR_STATE_KEY).toBe('tour.state');
  });

  it('round-trips through the settings table', async () => {
    const db = await testDb();
    expect(await getTourState(db)).toBeNull();
    await saveTourState(db, STATE);
    expect(await getSetting(db, TOUR_STATE_KEY)).toEqual(STATE);
    expect(await getTourState(db)).toEqual(STATE);
    await saveTourState(db, { ...STATE, current: null, dismissed: true });
    expect(await getTourState(db)).toEqual({ ...STATE, current: null, dismissed: true });
  });

  it('reads a corrupt or foreign value as no state', async () => {
    const db = await testDb();
    for (const bad of [{ bad: 1 }, 'x', 7, [], { ...STATE, completed: ['nope'] }, { ...STATE, current: { chapter: 'setup', step: 99 } }, { ...STATE, version: 0 }]) {
      await setSetting(db, TOUR_STATE_KEY, bad);
      expect(await getTourState(db), JSON.stringify(bad)).toBeNull();
    }
  });

  it('the schema accepts only known chapters and bounded steps', () => {
    expect(TourStateSchema.safeParse(STATE).success).toBe(true);
    expect(TourStateSchema.safeParse({ ...STATE, completed: [...TOUR_CHAPTERS, 'setup'] }).success).toBe(false);
    expect(TourStateSchema.safeParse({ ...STATE, current: { chapter: 'generate', step: -1 } }).success).toBe(false);
    expect(TourStateSchema.safeParse({ ...STATE, current: { chapter: 'generate', step: 1.5 } }).success).toBe(false);
  });

  it('saveTourState refuses an invalid state', async () => {
    const db = await testDb();
    await expect(saveTourState(db, { ...STATE, completed: ['x'] } as unknown as TourState)).rejects.toThrow();
    expect(await getSetting(db, TOUR_STATE_KEY)).toBeNull();
  });
});

describe('tourCaseSlug', () => {
  it('is null with no cases at all', async () => {
    expect(await tourCaseSlug(await testDb())).toBeNull();
  });

  it('falls back to the example when there is no real case', async () => {
    const db = await testDb();
    await ensureExample(db);
    expect(await tourCaseSlug(db)).toBe(EXAMPLE_SLUG);
  });

  it('prefers the newest real case over the example and skips killed cases', async () => {
    const db = await testDb();
    await ensureExample(db);
    await addCase(db, 'older-real', { createdAt: new Date('2026-10-01T00:00:00Z') });
    await addCase(db, 'newer-real', { createdAt: new Date('2026-10-02T00:00:00Z') });
    await addCase(db, 'newest-killed', { stage: 'killed', createdAt: new Date('2026-10-03T00:00:00Z') });
    expect(await tourCaseSlug(db)).toBe('newer-real');
  });

  it('uses the example when every real case is killed', async () => {
    const db = await testDb();
    await ensureExample(db);
    await addCase(db, 'dead', { stage: 'killed' });
    expect(await tourCaseSlug(db)).toBe(EXAMPLE_SLUG);
  });
});
