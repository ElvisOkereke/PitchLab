import { z } from 'zod';
import { pageParam } from './case-query';

/** Outcomes of "Resume" on a failed run (allow-listed; the query value is only a key). Every requeueRun reason has one. */
export const RUNS_NOTICES = {
  requeued: 'Run queued again. It resumes from the failed stage when `npm run worker` is running.',
  requeue_not_found: 'That run no longer exists.',
  requeue_not_failed: 'Only failed runs can be resumed, and that run is no longer failed. Refresh.',
  requeue_busy: '3 runs are already queued. Wait for the worker, then try again.',
} as const;
export type RunsNotice = keyof typeof RUNS_NOTICES;

const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
const NoticeSchema = z.preprocess(first, z.enum(Object.keys(RUNS_NOTICES) as [RunsNotice, ...RunsNotice[]]).optional()).catch(undefined);

/** `?page=&notice=`: page clamped to ≥ 1, notice allow-listed. */
export function parseRunsQuery(sp: Record<string, string | string[] | undefined>): { page: number; notice?: RunsNotice } {
  const page = pageParam(sp.page);
  const notice = NoticeSchema.parse(sp.notice);
  return notice ? { page, notice } : { page };
}

export function runsHref(page: number, notice?: RunsNotice): string {
  const p = new URLSearchParams();
  if (page > 1) p.set('page', String(page));
  if (notice) p.set('notice', notice);
  const s = p.toString();
  return s ? `/runs?${s}` : '/runs';
}
