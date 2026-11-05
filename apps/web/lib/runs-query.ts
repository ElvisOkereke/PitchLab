import { z } from 'zod';
import { pageParam } from './case-query';

/** Outcomes of "Resume" on a failed run (allow-listed; the query value is only a key). Every requeueRun reason has one. */
export const RUNS_NOTICES = {
  requeued: 'Run queued again. It resumes from the failed stage when npm run worker is running.',
  requeue_not_found: 'That run no longer exists.',
  requeue_not_failed: 'Only failed runs can be resumed, and that run is no longer failed. Refresh.',
  requeue_busy: '3 runs are already queued. Wait for the worker, then try again.',
} as const;
export type RunsNotice = keyof typeof RUNS_NOTICES;

const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
const NoticeSchema = z.preprocess(first, z.enum(Object.keys(RUNS_NOTICES) as [RunsNotice, ...RunsNotice[]]).optional()).catch(undefined);

const RunSchema = z.preprocess(first, z.uuid().optional()).catch(undefined);

/** `?page=&notice=&run=`: page clamped to ≥ 1, notice allow-listed, run a uuid (the page then shows the page that run is on). */
export function parseRunsQuery(sp: Record<string, string | string[] | undefined>): { page: number; notice?: RunsNotice; run?: string } {
  const page = pageParam(sp.page);
  const notice = NoticeSchema.parse(sp.notice);
  const run = RunSchema.parse(sp.run);
  return { page, ...(notice ? { notice } : {}), ...(run ? { run } : {}) };
}

/** Link to one run in the history: `?run=` picks the right page, the hash scrolls to its row. */
export function runLinkHref(runId: string): string {
  return `/runs?run=${encodeURIComponent(runId)}#run-${encodeURIComponent(runId)}`;
}

export function runsHref(page: number, notice?: RunsNotice): string {
  const p = new URLSearchParams();
  if (page > 1) p.set('page', String(page));
  if (notice) p.set('notice', notice);
  const s = p.toString();
  return s ? `/runs?${s}` : '/runs';
}
