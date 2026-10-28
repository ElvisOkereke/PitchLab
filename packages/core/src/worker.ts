import { and, asc, eq, lt, sql } from 'drizzle-orm';
import type { Env } from './config/env';
import { DEFAULT_MODELS, MODEL_STAGES, isModelStage, type ModelStage } from './config/models';
import type { Db } from './db/client';
import { maybeQueueBackgroundMission, STALE_MISSION_MS } from './dashboard/missions';
import { researchMissions, runs, validationJobs } from './db/schema';
import { RunConfigSchema } from './dashboard/runs';
import type { WorkerStatus } from './dashboard/settings';
import { spendSql } from './research/mission';
import { runMaintenance } from './maintenance';
import { getSetting, setSetting } from './validation/settings';
import { errorMessage, scrubError } from './tools/scrub';

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

/** Same as claimNextRun, for the oldest queued validation job (FOR UPDATE SKIP LOCKED). */
export async function claimNextValidationJob(db: Db): Promise<string | null> {
  const next = db.select({ id: validationJobs.id }).from(validationJobs)
    .where(eq(validationJobs.status, 'queued'))
    .orderBy(asc(validationJobs.createdAt), asc(validationJobs.id))
    .limit(1)
    .for('update', { skipLocked: true });
  const [row] = await db.update(validationJobs)
    .set({ status: 'running', startedAt: sql`now()` })
    .where(and(eq(validationJobs.status, 'queued'), eq(validationJobs.id, sql`(${next})`)))
    .returning({ id: validationJobs.id });
  return row?.id ?? null;
}

/** Same as claimNextRun, for the oldest queued research mission (FOR UPDATE SKIP LOCKED). */
export async function claimNextMission(db: Db): Promise<string | null> {
  // A mission left running by a stopped worker would otherwise stay running forever.
  await db.update(researchMissions)
    .set({ status: 'failed', error: 'worker stopped mid-mission', finishedAt: new Date(), costUsd: spendSql(researchMissions.id) })
    .where(and(eq(researchMissions.status, 'running'), lt(researchMissions.startedAt, new Date(Date.now() - STALE_MISSION_MS))));
  const next = db.select({ id: researchMissions.id }).from(researchMissions)
    .where(eq(researchMissions.status, 'queued'))
    .orderBy(asc(researchMissions.createdAt), asc(researchMissions.id))
    .limit(1)
    .for('update', { skipLocked: true });
  const [row] = await db.update(researchMissions)
    .set({ status: 'running', startedAt: sql`now()` })
    .where(and(eq(researchMissions.status, 'queued'), eq(researchMissions.id, sql`(${next})`)))
    .returning({ id: researchMissions.id });
  return row?.id ?? null;
}

/** The model per stage the worker will use (defaults plus MODEL_OVERRIDES), as buildRouter resolves them. */
export function resolveModels(env: Env): Record<ModelStage, string> {
  const overrides = Object.fromEntries(Object.entries(env.MODEL_OVERRIDES).filter(([k]) => isModelStage(k)));
  return Object.fromEntries(MODEL_STAGES.map((s) => [s, overrides[s] ?? DEFAULT_MODELS[s]])) as Record<ModelStage, string>;
}

/** The heartbeat the dashboard shows: which keys are set (booleans, never values) and the resolved models. */
export function workerStatus(env: Env, models: Record<ModelStage, string>, extra: { browser?: boolean } = {}): WorkerStatus {
  return {
    at: new Date().toISOString(),
    providers: {
      llm: Boolean(env.LLM_API_KEY),
      github: Boolean(env.GITHUB_TOKEN),
      stackexchange: Boolean(env.STACKEXCHANGE_KEY),
      places: Boolean(env.GOOGLE_PLACES_API_KEY),
      producthunt: Boolean(env.PRODUCTHUNT_TOKEN),
      youtube: Boolean(env.YOUTUBE_API_KEY),
      browser: Boolean(extra.browser),
    },
    models: { ...models },
  };
}

export type WorkerOptions = {
  db: Db;
  intervalMs: number;
  signal: AbortSignal;
  execute: (runId: string) => Promise<'succeeded' | 'failed'>;
  executeValidation: (jobId: string) => Promise<'succeeded' | 'failed'>;
  /** Research missions, taken after runs and validation jobs. When absent, missions stay queued. */
  executeMission?: (missionId: string) => Promise<'succeeded' | 'failed'>;
  heartbeat: () => Promise<void>;
  log: (m: string) => void;
  once?: boolean;
  /** Called after every run outcome (success, execute throw, invalid config); a throw is logged and ignored. */
  finalize?: () => Promise<void>;
};

const ERROR_MAX = 1000;
export const MAINTENANCE_KEY = 'maintenance.lastRun';
const MAINTENANCE_EVERY_MS = 24 * 3_600_000;

const MAINTENANCE_RETRY_MS = 3_600_000;
const MAINTENANCE_ATTEMPT_KEY = 'maintenance.lastAttempt';
const parseTime = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) : NaN);

/**
 * Returns a function that runs maintenance when due (never run, or last run 24 hours old; after a failed attempt, retry
 * after 1 hour). The next-due time is cached in memory after the first settings read. Never throws.
 */
function maintenanceScheduler(db: Db, log: (m: string) => void): () => Promise<void> {
  let nextDue: number | null = null;
  return async () => {
    try {
      if (nextDue === null) {
        const last = parseTime(await getSetting(db, MAINTENANCE_KEY));
        const attempt = parseTime(await getSetting(db, MAINTENANCE_ATTEMPT_KEY));
        nextDue = Number.isFinite(last) ? last + MAINTENANCE_EVERY_MS : 0;
        if (Number.isFinite(attempt) && (!Number.isFinite(last) || attempt > last)) nextDue = Math.max(nextDue, attempt + MAINTENANCE_RETRY_MS);
      }
      if (Date.now() < nextDue) return;
      const m = await runMaintenance(db);
      const total = m.prunedFetches + m.expiredSources + m.deletedItems + m.redactedSignals + m.redactedClaims + m.redactedCases + m.prunedQuotaRows;
      if (total > 0) log(`maintenance: ${total} old records cleaned up`);
      const now = new Date();
      if (m.errors.length) {
        for (const e of m.errors) log(`maintenance step failed: ${e}`);
        await setSetting(db, MAINTENANCE_ATTEMPT_KEY, now.toISOString());
        nextDue = now.getTime() + MAINTENANCE_RETRY_MS;
      } else {
        await setSetting(db, MAINTENANCE_KEY, now.toISOString());
        nextDue = now.getTime() + MAINTENANCE_EVERY_MS;
      }
    } catch (err) {
      log(`maintenance failed: ${err instanceof Error ? err.message : String(err)}`);
      nextDue = Date.now() + MAINTENANCE_RETRY_MS;
    }
  };
}
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
  await db.update(runs).set({ status: 'failed', error: scrubError(error).slice(0, ERROR_MAX), finishedAt: new Date() }).where(eq(runs.id, id));
}

/**
 * Loop: heartbeat, then claim a run; runs go first, and only when none is queued is a validation job claimed (the
 * heartbeat also repeats every `intervalMs` while either executes). A claimed run's
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
  const finish = async () => {
    try {
      await o.finalize?.();
    } catch (err) {
      o.log(`finalize failed: ${messageOf(err)}`);
    }
  };
  const maintain = maintenanceScheduler(o.db, o.log);
  while (!o.signal.aborted) {
    await maintain();
    await beat();
    // D2-R3: a stop requested while the heartbeat was in flight must not start a run.
    if (o.signal.aborted) return;
    const id = await claimNextRun(o.db);
    if (id === null) {
      const jobId = await claimNextValidationJob(o.db);
      if (jobId !== null) {
        o.log(`validation job ${jobId} claimed`);
        const timer = setInterval(() => void beat(), o.intervalMs);
        try {
          const status = await o.executeValidation(jobId);
          o.log(`validation job ${jobId} ${status}`);
        } catch (err) {
          await o.db.update(validationJobs)
            .set({ status: 'failed', error: scrubError(errorMessage(err)).slice(0, ERROR_MAX), finishedAt: new Date() })
            .where(eq(validationJobs.id, jobId));
          o.log(`validation job ${jobId} failed: ${errorMessage(err)}`);
        } finally {
          clearInterval(timer);
        }
        if (o.once) return;
        continue;
      }
      if (o.executeMission) {
        const missionId = await claimNextMission(o.db);
        if (missionId !== null) {
          o.log(`mission ${missionId} claimed`);
          const timer = setInterval(() => void beat(), o.intervalMs);
          try {
            const status = await o.executeMission(missionId);
            o.log(`mission ${missionId} ${status}`);
          } catch (err) {
            await o.db.update(researchMissions)
              .set({ status: 'failed', error: scrubError(errorMessage(err)).slice(0, ERROR_MAX), finishedAt: new Date() })
              .where(eq(researchMissions.id, missionId));
            o.log(`mission ${missionId} failed: ${errorMessage(err)}`);
          } finally {
            clearInterval(timer);
          }
          if (o.once) return;
          continue;
        }
        // Idle: top up the background queue (a failure here must never stop the worker). Not with --once: it would queue a mission that never runs.
        if (!o.once) try {
          const queued = await maybeQueueBackgroundMission(o.db, new Date());
          if (queued === 'queued') o.log('background research mission queued');
        } catch (err) {
          o.log(`background research check failed: ${messageOf(err)}`);
        }
      }
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
      await finish();
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
      await finish();
    }
    if (o.once) return;
  }
}
