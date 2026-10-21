import { TOUR_CHAPTERS, TOUR_VERSION } from '@bcg/core/dashboard/tour';
import type { TourChapterId, TourState } from '@bcg/core/dashboard/tour';
import { describe, expect, it } from 'vitest';
import type { Chapters, TourStep } from '@/lib/tour/machine';
import { back, chapterAfter, hasNewSteps, next, resolve, samePlace, shouldAutoStart } from '@/lib/tour/machine';

const step = (o: Partial<TourStep> = {}): TourStep => ({ id: 's', route: '/', title: 'T', body: 'B', kind: 'info', ...o });
const chapters = Object.fromEntries(TOUR_CHAPTERS.map((id) => [id, { title: id, steps: [step({ id: `${id}-0` }), step({ id: `${id}-1` })] }])) as Chapters;
const STATE: TourState = { version: TOUR_VERSION, completed: [], current: null, dismissed: false };

describe('tour machine: next / back', () => {
  it('next moves within a chapter, and past its last step reports the chapter done', () => {
    expect(next({ chapter: 'board', step: 0 }, chapters)).toEqual({ chapter: 'board', step: 1 });
    expect(next({ chapter: 'board', step: 1 }, chapters)).toEqual({ done: 'board' });
  });

  it('next on a step index beyond the chapter (stale saved state) reports the chapter done', () => {
    expect(next({ chapter: 'board', step: 9 }, chapters)).toEqual({ done: 'board' });
  });

  it('back moves one step back and stays put at step 0', () => {
    expect(back({ chapter: 'score', step: 1 }, chapters)).toEqual({ chapter: 'score', step: 0 });
    expect(back({ chapter: 'score', step: 0 }, chapters)).toEqual({ chapter: 'score', step: 0 });
  });

  it('chapterAfter follows TOUR_CHAPTERS and ends after the last', () => {
    expect(chapterAfter('setup')).toBe('generate');
    expect(chapterAfter('outreach')).toBe('decide');
    expect(chapterAfter('decide' as TourChapterId)).toBeNull();
  });
});

describe('tour machine: resolve', () => {
  const ctx = { caseSlug: 'acme' };

  it('route resolving to null → centred (the body explains)', () => {
    expect(resolve(step({ route: () => null, target: 'x' }), { caseSlug: null }, '/', true)).toEqual({ show: 'centred' });
  });

  it('route elsewhere → go-there with the href', () => {
    expect(resolve(step({ route: '/runs', target: 'x' }), ctx, '/', true)).toEqual({ show: 'go-there', href: '/runs' });
    const caseStep = step({ route: (c) => (c.caseSlug ? `/cases/${c.caseSlug}?tab=score` : null), target: 'x' });
    expect(resolve(caseStep, ctx, '/cases/acme?tab=evidence', true)).toEqual({ show: 'go-there', href: '/cases/acme?tab=score' });
  });

  it('right route but the target is missing → centred', () => {
    expect(resolve(step({ route: '/', target: 'board-columns' }), ctx, '/', false)).toEqual({ show: 'centred' });
    expect(resolve(step({ route: '/' }), ctx, '/', false)).toEqual({ show: 'centred' });
  });

  it('right route and the target is present → highlight', () => {
    expect(resolve(step({ route: '/', target: 'board-columns' }), ctx, '/', true)).toEqual({ show: 'highlight' });
    const caseStep = step({ route: (c) => `/cases/${c.caseSlug}?tab=score`, target: 'x' });
    expect(resolve(caseStep, ctx, '/cases/acme?page=2&tab=score', true)).toEqual({ show: 'highlight' });
  });

  it('samePlace compares the path and requires every query param the route names', () => {
    expect(samePlace('/runs', '/runs?x=1')).toBe(true);
    expect(samePlace('/runs/', '/runs')).toBe(true);
    expect(samePlace('/cases/a?tab=score', '/cases/a')).toBe(false);
    expect(samePlace('/cases/a', '/cases/b')).toBe(false);
  });
});

describe('tour machine: auto-start and new steps', () => {
  it('auto-starts only when there is no saved state', () => {
    expect(shouldAutoStart(null)).toBe(true);
    expect(shouldAutoStart(STATE)).toBe(false);
    expect(shouldAutoStart({ ...STATE, dismissed: true })).toBe(false);
  });

  it('hasNewSteps is true for an older version unless the tour was dismissed', () => {
    expect(hasNewSteps({ ...STATE, version: TOUR_VERSION })).toBe(false);
    // Simulate a bump: a state saved by version 1 when the app is on version 2.
    expect(hasNewSteps({ ...STATE, version: 1 }, 2)).toBe(true);
    expect(hasNewSteps({ ...STATE, version: 1, dismissed: true }, 2)).toBe(false);
    expect(hasNewSteps(null)).toBe(false);
  });
});
