import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client';
import { llmCalls, validationJobs } from '../../src/db/schema';
import { ValidationJobOptionsSchema } from '../../src/dashboard/validation-jobs';
import { defaultRunConfig } from '../../src/pipeline/types';
import { executeValidationJob } from '../../src/validation/job';
import type { StepResult, ValidationDeps, ValidationResult } from '../../src/validation/run';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';

let db: Db;
let caseId: string;
let runId: string;
let deps: ValidationDeps;
const opts = ValidationJobOptionsSchema.parse({ prospects: 5 });
const cfg = defaultRunConfig({ seedType: 'open' });

beforeEach(async () => {
  db = await testDb();
  runId = (await insertRun(db, cfg)).id;
  const idea = await insertIdea(db, runId);
  caseId = (await insertCase(db, idea.id)).id;
  deps = { db, router: {} as never, fetchPage: (async () => ({})) as never, log: () => {}, outDir: 'x' };
});

async function job(options: unknown = opts, startedAt = new Date()): Promise<string> {
  const [r] = await db.insert(validationJobs).values({ caseId, options: options as never, status: 'running', startedAt }).returning({ id: validationJobs.id });
  return r!.id;
}
const get = async (id: string) => (await db.select().from(validationJobs).where(eq(validationJobs.id, id)))[0]!;
const steps: StepResult[] = [{ step: 'pack', status: 'ok', detail: 'done' }];
const result = (ok: boolean): ValidationResult => ({ ok, exitCode: ok ? 0 : 1, steps });

describe('executeValidationJob', () => {
  it('stores steps and succeeds, passing the options through', async () => {
    const id = await job();
    const run = vi.fn(async () => result(true));
    expect(await executeValidationJob(deps, id, run)).toBe('succeeded');
    expect(run).toHaveBeenCalledWith(deps, caseId, { prospects: 5, skipProspects: false, refresh: false, redraft: false });
    const row = await get(id);
    expect(row).toMatchObject({ status: 'succeeded', steps });
    expect(row.finishedAt).toBeInstanceOf(Date);
  });

  it('fails when the result is not ok', async () => {
    const id = await job();
    expect(await executeValidationJob(deps, id, async () => result(false))).toBe('failed');
    expect(await get(id)).toMatchObject({ status: 'failed', steps });
  });

  it('fails with a scrubbed error on a throw', async () => {
    const id = await job();
    const out = await executeValidationJob(deps, id, async () => { throw new Error('bad api_key=ghp_abcdefghij0123456789ABCD'); });
    expect(out).toBe('failed');
    const row = await get(id);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('bad api_key=[redacted]');
    expect(row.finishedAt).toBeInstanceOf(Date);
  });

  it('fails on invalid stored options without running', async () => {
    const id = await job({ prospects: 1000 });
    const run = vi.fn(async () => result(true));
    expect(await executeValidationJob(deps, id, run)).toBe('failed');
    expect(run).not.toHaveBeenCalled();
    expect((await get(id)).error).toMatch(/^invalid job options/);
  });

  it('sums null-run spend inside the window only', async () => {
    const startedAt = new Date(Date.now() - 60_000);
    const id = await job(opts, startedAt);
    const base = {
      stage: 'pack', provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1, searchRequests: 0, latencyMs: 1,
      promptVersion: 'v', ok: true,
    };
    await db.insert(llmCalls).values([
      { ...base, costUsd: '0.25', createdAt: new Date() },
      { ...base, costUsd: '0.50', createdAt: new Date() },
      { ...base, costUsd: '9', createdAt: new Date(startedAt.getTime() - 3600_000) },
      { ...base, costUsd: '7', createdAt: new Date(), runId },
    ]);
    await executeValidationJob(deps, id, async () => result(true));
    expect(Number((await get(id)).costUsd)).toBeCloseTo(0.75, 6);
  });
});
