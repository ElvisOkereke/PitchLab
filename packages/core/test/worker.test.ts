import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../src/config/env';
import { DEFAULT_MODELS } from '../src/config/models';
import { createDb, type Db } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { runs, validationJobs } from '../src/db/schema';
import { ValidationJobOptionsSchema } from '../src/dashboard/validation-jobs';
import { WORKER_STATUS_KEY, readWorkerStatus } from '../src/dashboard/settings';
import { createRun } from '../src/pipeline/run';
import { defaultRunConfig, type RunConfig } from '../src/pipeline/types';
import { setSetting } from '../src/validation/settings';
import { claimNextRun, claimNextValidationJob, resolveModels, runWorker, workerStatus } from '../src/worker';
import { insertCase, insertIdea, insertRun, testDb } from './helpers/db';

const cfg = defaultRunConfig({ seedType: 'open', ideaCount: 1, advanceCount: 1 });
const statusOf = async (db: Db, id: string) => (await db.select().from(runs).where(eq(runs.id, id)))[0]!;

async function insertAt(db: Db, config: RunConfig, createdAt: Date): Promise<string> {
  const [row] = await db.insert(runs).values({ config, status: 'queued', createdAt }).returning({ id: runs.id });
  return row!.id;
}

const never = new AbortController().signal;
const noValidation = async () => 'succeeded' as const;
async function insertJob(db: Db): Promise<string> {
  const idea = await insertIdea(db, (await insertRun(db, cfg)).id);
  const kase = await insertCase(db, idea.id);
  const [row] = await db.insert(validationJobs).values({ caseId: kase.id, options: ValidationJobOptionsSchema.parse({}) }).returning({ id: validationJobs.id });
  return row!.id;
}
const quietLog = () => {};

describe('claimNextRun', () => {
  it('two concurrent claims never take the same run', async () => {
    const db = await testDb();
    await insertRun(db, cfg);
    const [a, b] = await Promise.all([claimNextRun(db), claimNextRun(db)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const claimed = await statusOf(db, (a ?? b)!);
    expect(claimed.status).toBe('running');
    expect(claimed.startedAt).toBeInstanceOf(Date);
    expect(await claimNextRun(db)).toBeNull();
  });

  it('claims the oldest queued run and ignores runs in other states (e.g. created by gen run)', async () => {
    const db = await testDb();
    const cli = await createRun(db, cfg, { status: 'running' });
    expect((await statusOf(db, cli.id)).status).toBe('running');
    const newer = await insertAt(db, cfg, new Date('2026-10-19T10:00:00Z'));
    const older = await insertAt(db, cfg, new Date('2026-10-19T09:00:00Z'));
    expect(await claimNextRun(db)).toBe(older);
    expect(await claimNextRun(db)).toBe(newer);
    expect(await claimNextRun(db)).toBeNull();
  });
});

// TEST_DATABASE_URL must point at a THROWAWAY database: the test migrates it, inserts runs, claims them (including
// any queued runs already there) and deletes the runs it created. Never point it at the dashboard's database.
describe.runIf(process.env.TEST_DATABASE_URL)('on real Postgres', () => {
  it('10 parallel claims over 3 queued runs return 3 distinct ids', async () => {
    const db = await createDb(process.env.TEST_DATABASE_URL!);
    await runMigrations(db);
    const ids: string[] = [];
    try {
      for (let i = 0; i < 3; i++) ids.push((await insertRun(db, cfg)).id);
      // Separate pool connections: the pool hands each concurrent query its own client.
      const claimed = (await Promise.all(Array.from({ length: 10 }, () => claimNextRun(db)))).filter((x): x is string => x !== null);
      expect(claimed.filter((id) => ids.includes(id)).sort()).toEqual([...ids].sort());
      expect(new Set(claimed).size).toBe(claimed.length);
    } finally {
      if (ids.length) await db.delete(runs).where(inArray(runs.id, ids));
      await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
    }
  });
});

describe('claimNextValidationJob', () => {
  it('two concurrent claims never take the same job', async () => {
    const db = await testDb();
    await insertJob(db);
    const [a, b] = await Promise.all([claimNextValidationJob(db), claimNextValidationJob(db)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const [row] = await db.select().from(validationJobs).where(eq(validationJobs.id, (a ?? b)!));
    expect(row!.status).toBe('running');
    expect(row!.startedAt).toBeInstanceOf(Date);
    expect(await claimNextValidationJob(db)).toBeNull();
  });
});

describe('runWorker with validation jobs', () => {
  it('runs a queued run before a queued job', async () => {
    const db = await testDb();
    const runId = (await insertRun(db, cfg)).id;
    await insertJob(db);
    const execute = vi.fn(async () => 'succeeded' as const);
    const executeValidation = vi.fn(async () => 'succeeded' as const);
    await runWorker({ db, intervalMs: 10, signal: never, once: true, log: quietLog, heartbeat: async () => {}, execute, executeValidation });
    expect(execute).toHaveBeenCalledWith(runId);
    expect(executeValidation).not.toHaveBeenCalled();
  });

  it('executes a job when no run is queued', async () => {
    const db = await testDb();
    const jobId = await insertJob(db);
    // insertJob created a queued run too (its idea needs one): clear it so only the job is pending.
    await db.update(runs).set({ status: 'succeeded' });
    const execute = vi.fn(async () => 'succeeded' as const);
    const executeValidation = vi.fn(async () => 'succeeded' as const);
    await runWorker({ db, intervalMs: 10, signal: never, once: true, log: quietLog, heartbeat: async () => {}, execute, executeValidation });
    expect(execute).not.toHaveBeenCalled();
    expect(executeValidation).toHaveBeenCalledWith(jobId);
  });
});

describe('runWorker', () => {
  it('executes queued runs oldest first and writes a heartbeat with no secret values', async () => {
    const db = await testDb();
    const newer = await insertAt(db, cfg, new Date('2026-10-19T10:00:00Z'));
    const oldest = await insertAt(db, cfg, new Date('2026-10-19T09:00:00Z'));
    const env = loadEnv({ LLM_API_KEY: 'test-key-value', GITHUB_TOKEN: 'gh-secret-value', MODEL_OVERRIDES: '{"score":"gemini-x"}' });
    const models = resolveModels(env);
    const seen: string[] = [];
    await runWorker({ executeValidation: noValidation,
      db, intervalMs: 10, signal: never, once: true, log: quietLog,
      heartbeat: () => setSetting(db, WORKER_STATUS_KEY, workerStatus(env, models)),
      execute: async (id) => { seen.push(id); return 'succeeded'; },
    });
    expect(seen).toEqual([oldest]);
    expect((await statusOf(db, newer)).status).toBe('queued');
    const hb = await readWorkerStatus(db);
    expect(hb).toMatchObject({ providers: { llm: true, github: true, stackexchange: false, places: false } });
    expect(hb!.models).toEqual({ ...DEFAULT_MODELS, score: 'gemini-x' });
    expect(JSON.stringify(hb)).not.toContain('test-key-value');
    expect(JSON.stringify(hb)).not.toContain('gh-secret-value');
  });

  it('fails a queued run with an absurd stored config instead of executing it', async () => {
    const db = await testDb();
    const id = await insertAt(db, { ...cfg, ideaCount: 1e9 }, new Date());
    const execute = vi.fn(async () => 'succeeded' as const);
    await runWorker({ executeValidation: noValidation, db, intervalMs: 10, signal: never, once: true, log: quietLog, heartbeat: async () => {}, execute });
    expect(execute).not.toHaveBeenCalled();
    const row = await statusOf(db, id);
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(/^invalid run config: /);
    expect(row.error).toContain('ideaCount');
    expect(row.finishedAt).toBeInstanceOf(Date);
  });

  it('calls the finalize hook after an invalid-config failure in once mode, and survives a throwing hook', async () => {
    const db = await testDb();
    await insertAt(db, { ...cfg, ideaCount: 1e9 }, new Date());
    const finalize = vi.fn(async () => { throw new Error('boom'); });
    await runWorker({ executeValidation: noValidation, db, intervalMs: 10, signal: never, once: true, log: quietLog, heartbeat: async () => {}, execute: async () => 'succeeded', finalize });
    expect(finalize).toHaveBeenCalledTimes(1);
  });

  it('calls the finalize hook after success and after execute throws', async () => {
    const db = await testDb();
    await insertAt(db, cfg, new Date());
    const finalize = vi.fn(async () => {});
    await runWorker({ executeValidation: noValidation, db, intervalMs: 10, signal: never, once: true, log: quietLog, heartbeat: async () => {}, execute: async () => { throw new Error('x'); }, finalize });
    await insertAt(db, cfg, new Date());
    await runWorker({ executeValidation: noValidation, db, intervalMs: 10, signal: never, once: true, log: quietLog, heartbeat: async () => {}, execute: async () => 'succeeded', finalize });
    expect(finalize).toHaveBeenCalledTimes(2);
  });

  it('marks the run failed when execute throws (it never stays running)', async () => {
    const db = await testDb();
    const id = await insertAt(db, cfg, new Date());
    await runWorker({ executeValidation: noValidation,
      db, intervalMs: 10, signal: never, once: true, log: quietLog, heartbeat: async () => {},
      execute: async () => { throw new Error('Model config: bad'); },
    });
    expect(await statusOf(db, id)).toMatchObject({ status: 'failed', error: 'Model config: bad' });
  });

  it('keeps working through the queue until idle, then stops when the signal aborts while idle', async () => {
    const db = await testDb();
    const a = await insertAt(db, cfg, new Date('2026-10-19T09:00:00Z'));
    const b = await insertAt(db, cfg, new Date('2026-10-19T10:00:00Z'));
    const ctrl = new AbortController();
    const seen: string[] = [];
    let beats = 0;
    const started = Date.now();
    const done = runWorker({ executeValidation: noValidation,
      db, intervalMs: 60_000, signal: ctrl.signal, log: quietLog,
      heartbeat: async () => { beats++; },
      execute: async (id) => { seen.push(id); return 'succeeded'; },
    });
    await vi.waitFor(() => expect(seen).toEqual([a, b]));
    await vi.waitFor(() => expect(beats).toBe(3)); // two runs + the idle pass that started sleeping
    ctrl.abort();
    await done;
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('scrubs credentials from a setup error it stores (D2-R1)', async () => {
    const db = await testDb();
    const id = await insertAt(db, cfg, new Date());
    await runWorker({ executeValidation: noValidation,
      db, intervalMs: 10, signal: never, once: true, log: quietLog, heartbeat: async () => {},
      execute: async () => { throw new Error('auth failed for api_key=ghp_abcdefghij0123456789ABCD'); },
    });
    expect((await statusOf(db, id)).error).toBe('auth failed for api_key=[redacted]');
  });

  it('keeps the heartbeat going while a long run executes', async () => {
    const db = await testDb();
    await insertRun(db, cfg);
    let beats = 0;
    await runWorker({ executeValidation: noValidation,
      db, intervalMs: 20, signal: never, once: true, log: quietLog,
      heartbeat: async () => { beats++; },
      execute: async () => { await new Promise((r) => setTimeout(r, 150)); return 'succeeded'; },
    });
    expect(beats).toBeGreaterThanOrEqual(3);
    const after = beats;
    await new Promise((r) => setTimeout(r, 60));
    expect(beats).toBe(after); // the in-run heartbeat timer is cleared
  });

  it('logs "no queued runs" on an idle --once pass and survives a failing heartbeat', async () => {
    const db = await testDb();
    const log = vi.fn();
    await runWorker({ executeValidation: noValidation,
      db, intervalMs: 10, signal: never, once: true, log,
      heartbeat: async () => { throw new Error('db down'); }, execute: async () => 'succeeded',
    });
    expect(log).toHaveBeenCalledWith('no queued runs');
    expect(log.mock.calls.flat().join('\n')).toMatch(/heartbeat failed/);
  });

  it('never starts a run when the signal aborts during the heartbeat (D2-R3)', async () => {
    const db = await testDb();
    const { id } = await insertRun(db, cfg);
    const ctrl = new AbortController();
    const execute = vi.fn(async () => 'succeeded' as const);
    await runWorker({ executeValidation: noValidation,
      db, intervalMs: 60_000, signal: ctrl.signal, log: quietLog, execute,
      heartbeat: async () => { ctrl.abort(); }, // SIGINT ("Stopping.") arrives while the heartbeat is in flight
    });
    expect(execute).not.toHaveBeenCalled();
    expect((await statusOf(db, id)).status).toBe('queued');
  });

  it('returns at once when the signal is already aborted', async () => {
    const db = await testDb();
    await insertRun(db, cfg);
    const ctrl = new AbortController();
    ctrl.abort();
    const execute = vi.fn(async () => 'succeeded' as const);
    await runWorker({ executeValidation: noValidation, db, intervalMs: 60_000, signal: ctrl.signal, log: quietLog, heartbeat: async () => {}, execute });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('workerStatus', () => {
  it('reports which keys are set, never their values', () => {
    const s = workerStatus(loadEnv({ LLM_API_KEY: 'k1', STACKEXCHANGE_KEY: 'k2', GOOGLE_PLACES_API_KEY: 'k3' }), DEFAULT_MODELS);
    expect(s.providers).toEqual({ llm: true, github: false, stackexchange: true, places: true });
    expect(Number.isNaN(Date.parse(s.at))).toBe(false);
    expect(JSON.stringify(s)).not.toMatch(/k1|k2|k3/);
  });
});
