// The tour's step machine: pure functions, no DOM, no React. The provider (components/tour/tour-provider.tsx)
// feeds it the current position, the URL and whether the step's target is on the page.
// Runtime constants come from the browser-safe tour-ids module (dashboard/tour pulls in drizzle).
import { TOUR_CHAPTERS, TOUR_VERSION } from '@bcg/core/dashboard/tour-ids';
import type { TourChapterId, TourState } from '@bcg/core/dashboard/tour';

export type TourCtx = { caseSlug: string | null };

/**
 * One popover. `title` and `body` are rendered by driver.js with innerHTML, so they must be string literals in
 * lib/tour/chapters.ts, never data. `route` is where the step lives (a function for case pages; null when there is
 * nothing to show, and the body then explains). `target` is a `data-tour` id. `action` steps also advance when the user
 * does the real thing: clicks the target, reaches a path (tested against path + query), or an element appears.
 * `wait` adds "I'll come back later" for steps that wait on something slow.
 */
export type TourStep = {
  id: string;
  route: string | ((ctx: TourCtx) => string | null);
  target?: string;
  title: string;
  body: string;
  kind: 'info' | 'action';
  advanceOn?: { click?: true; path?: RegExp; appears?: string };
  wait?: true;
};

export type TourChapter = { title: string; steps: TourStep[] };
export type Chapters = Record<TourChapterId, TourChapter>;
export type Position = { chapter: TourChapterId; step: number };
export type Resolved = { show: 'highlight' | 'centred' | 'go-there'; href?: string };

/** The next step in the chapter, or `{ done }` past its last step. */
export function next(pos: Position, chapters: Chapters): Position | { done: TourChapterId } {
  const steps = chapters[pos.chapter].steps;
  return pos.step + 1 < steps.length ? { chapter: pos.chapter, step: pos.step + 1 } : { done: pos.chapter };
}

/** One step back (clamped to the chapter's last step); step 0 stays put. */
export function back(pos: Position, chapters: Chapters): Position {
  if (pos.step <= 0) return pos;
  return { chapter: pos.chapter, step: Math.max(0, Math.min(pos.step - 1, chapters[pos.chapter].steps.length - 1)) };
}

/** The chapter after `id` in the whole tour, or null after the last. */
export function chapterAfter(id: TourChapterId): TourChapterId | null {
  return TOUR_CHAPTERS[TOUR_CHAPTERS.indexOf(id) + 1] ?? null;
}

function split(url: string): { path: string; query: URLSearchParams } {
  const u = new URL(url, 'http://tour.invalid');
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
  return { path, query: u.searchParams };
}

/** True when `location` (path + optional query) is on `route`: same path, and every query param the route names matches. */
export function samePlace(route: string, location: string): boolean {
  const r = split(route);
  const l = split(location);
  if (r.path !== l.path) return false;
  for (const [k, v] of r.query) if (l.query.get(k) !== v) return false;
  return true;
}

/** The step's route for this context (null: nothing to show yet). */
export function routeOf(step: TourStep, ctx: TourCtx): string | null {
  return typeof step.route === 'function' ? step.route(ctx) : step.route;
}

/**
 * How to show a step. No route → centred (the body explains). Another page → go-there with the href. Target
 * missing (or no target) → centred. Otherwise → highlight. Never throws, so a step can never dead-end.
 */
export function resolve(step: TourStep, ctx: TourCtx, pathname: string, targetPresent: boolean): Resolved {
  const href = routeOf(step, ctx);
  if (href === null) return { show: 'centred' };
  if (!samePlace(href, pathname)) return { show: 'go-there', href };
  if (!step.target || !targetPresent) return { show: 'centred' };
  return { show: 'highlight' };
}

/** The tour starts by itself only when nothing was ever saved. */
export function shouldAutoStart(state: TourState | null): boolean {
  return state === null;
}

/** The "new steps" hint: saved by an older tour version, and the user did not dismiss the tour. */
export function hasNewSteps(state: TourState | null, version: number = TOUR_VERSION): boolean {
  return state !== null && state.version < version && !state.dismissed;
}
