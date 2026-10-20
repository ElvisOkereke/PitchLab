import { and, asc, eq, sql } from 'drizzle-orm';
import type { Env } from './config/env';
import { DEFAULT_MODELS, MODEL_STAGES, isModelStage, type ModelStage } from './config/models';
import type { Db } from './db/client';
import { runs } from './db/schema';
import { RunConfigSchema } from './dashboard/runs';
import type { WorkerStatus } from './dashboard/settings';
import { errorMessage, scrubSecrets } from './tools/scrub';

// A minimal executor for runs queued from the dashboard. No leases: a worker killed mid-run leaves the run `running`
// until `gen resume <id>` (leases come in Plan 4).

/**
 * Atomically takes the oldest queued run (one statement; FOR UPDATE SKIP LOCKED, so concurrent workers never take the
 * same run) and marks it running. Returns its id, or null when nothing is queued.
 */
export async function claimNextRun(db: Db): Promise<string | null> {
  const next = db.select({ id: runs.id }).from(runs)
    .where(eq(runs.status, 'queued'))
    .orderBy(asc(runs.createdAt), asc(runs.id))
    .limit(1)
    .for('update', { skipLocked: true });
  const [row] = await db.update(runs)
    .set({ status: 'running', startedAt: sql`coalesce(${runs.startedAt}, now())` })
    .where(and(eq(runs.status, 'queued'), eq(runs.id, sql`(${next})`)))
    .returning({ id: runs.id });
  return row?.id ?? null;
}

/** The model per stage the worker will use (defaults plus MODEL_OVERRIDES), as buildRouter resolves them. */
export function resolveModels(env: Env): Record<ModelStage, string> {
  const overrides = Object.fromEntries(Object.entries(env.MODEL_OVERRIDES).filter(([k]) => isModelStage(k)));
  return Object.fromEntries(MODEL_STAGES.map((s) => [s, overrides[s] ?? DEFAULT_MODELS[s]])) as Record<ModelStage, string>;
}

/** The heartbeat the dashboard shows: which keys are set (booleans, never values) and the resolved models. */
export function workerStatus(env: Env, models: Record<ModelStage, string>): WorkerStatus {
  return {
    at: new Date().toISOString(),
    providers: {
      llm: Boolean(env.LLM_API_KEY),
      github: Boolean(env.GITHUB_TOKEN),
      stackexchange: Boolean(env.STACKEXCHANGE_KEY),
      places: Boolean(env.GOOGLE_PLACES_API_KEY),
    },
    models: { ...models },
  };
}

export type WorkerOptions = {
  db: Db;
  intervalMs: number;
  signal: AbortSignal;
  execute: (runId: string) => Promise<'succeeded' | 'failed'>;
  heartbeat: () => Promise<void>;
  log: (m: string) => void;
  once?: boolean;
};

const ERROR_MAX = 1000;
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

async function failRun(db: Db, id: string, error: string): Promise<void> {
  await db.update(runs).set({ status: 'failed', error: scrubSecrets(error).slice(0, ERROR_MAX), finishedAt: new Date() }).where(eq(runs.id, id));
}

/**
 * Loop: heartbeat, then claim (the heartbeat also repeats every `intervalMs` while a run executes). A claimed run's
 * stored config is re-validated with RunConfigSchema; an invalid one is
 * failed (`invalid run config: …`) instead of executed. After a run the next one is claimed at once; when nothing is
 * queued the loop sleeps `intervalMs` (abortable). It exits when `signal` aborts (a running `execute` is always
 * finished first), or after one pass with `once`.
 */
export async function runWorker(o: WorkerOptions): Promise<void> {
  const beat = async () => {
    try {
      await o.heartbeat();
    } catch (err) {
      o.log(`heartbeat failed: ${messageOf(err)}`);
    }
  };
  while (!o.signal.aborted) {
    await beat();
    const id = await claimNextRun(o.db);
    if (id === null) {
      if (o.once) {
        o.log('no queued runs');
        return;
      }
      await sleep(o.intervalMs, o.signal);
      continue;
    }

    const [row] = await o.db.select({ config: runs.config }).from(runs).where(eq(runs.id, id));
    const parsed = RunConfigSchema.safeParse(row?.config);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; ');
      await failRun(o.db, id, `invalid run config: ${issues}`);
      o.log(`run ${id} failed: invalid run config`);
    } else {
      o.log(`run ${id} claimed`);
      // Runs take minutes: keep the heartbeat fresh while one executes, so the dashboard does not report the worker gone.
      const timer = setInterval(() => void beat(), o.intervalMs);
      try {
        const status = await o.execute(id);
        o.log(`run ${id} ${status}`);
      } catch (err) {
        // executeRun records stage failures itself; this catches setup errors (e.g. model config) so no run stays running.
        await failRun(o.db, id, errorMessage(err));
        o.log(`run ${id} failed: ${errorMessage(err)}`);
      } finally {
        clearInterval(timer);
      }
    }
    if (o.once) return;
  }
}
