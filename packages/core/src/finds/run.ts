import type { Db } from '../db/client';
import type { ModelRouter } from '../llm/types';
import type { OpenedCapture } from './capture';
import { hasQueuedFinds, runFindsJob } from './worker';

/**
 * Running queued finds with the capture service (worker-side): opens capture (the guarded proxy) for one call, waits
 * without touching the queue when the tools are not installed, and always closes the proxy, also on a throw.
 */

export type RunFindsDeps = {
  db: Db;
  router: ModelRouter;
  log: (m: string) => void;
  open: () => Promise<OpenedCapture | null>;
  notify?: (text: string) => Promise<void>;
  limit?: number;
};

export const FINDS_WAITING_TOOLS = 'Finds are waiting: run npm run capture:setup';
export const FINDS_WAITING_CAPTURE = 'Finds are waiting: the capture service could not start.';

/** `no_tools`: yt-dlp or ffmpeg missing (finds stay queued); `unavailable`: the capture package or proxy did not start. */
export async function runQueuedFinds(deps: RunFindsDeps): Promise<{ captured: number; failed: number } | 'no_tools' | 'unavailable'> {
  const capture = await deps.open();
  if (!capture) return 'unavailable';
  try {
    if (!capture.toolsPresent) return 'no_tools';
    return await runFindsJob({
      db: deps.db, router: deps.router, log: deps.log, capture: capture.capture, scrubHandles: capture.scrubHandles, notify: deps.notify, limit: deps.limit,
    });
  } finally {
    await capture.close();
  }
}

/**
 * The worker's finds step: nothing (and nothing opened) when no find is waiting; otherwise one find per call. A missing
 * tool or capture service is logged once per executor (once per worker start), and the finds stay queued.
 */
export function createFindsExecutor(deps: Omit<RunFindsDeps, 'limit'>): () => Promise<boolean> {
  const warned = new Set<string>();
  const warnOnce = (m: string) => {
    if (warned.has(m)) return;
    warned.add(m);
    deps.log(m);
  };
  return async () => {
    if (!(await hasQueuedFinds(deps.db))) return false;
    const r = await runQueuedFinds({ ...deps, limit: 1 });
    if (r === 'no_tools') {
      warnOnce(FINDS_WAITING_TOOLS);
      return false;
    }
    if (r === 'unavailable') {
      warnOnce(FINDS_WAITING_CAPTURE);
      return false;
    }
    return r.captured + r.failed > 0;
  };
}
