import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client';
import { cases, validationJobs } from '../../src/db/schema';
import {
  MAX_QUEUED_VALIDATIONS, ValidationJobOptionsSchema, latestValidationJob, queueValidationJob,
} from '../../src/dashboard/validation-jobs';
import { SENDER_KEYS, setSetting } from '../../src/validation/settings';
import { defaultRunConfig } from '../../src/pipeline/types';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';

let db: Db;
let runId: string;
const opts = ValidationJobOptionsSchema.parse({});

async function setSender(d: Db): Promise<void> {
  for (const k of SENDER_KEYS) await setSetting(d, k, `v-${k}`);
}
async function newCase(d: Db = db, rid: string = runId): Promise<string> {
  const idea = await insertIdea(d, rid);
  return (await insertCase(d, idea.id)).id;
}

beforeEach(async () => {
  db = await testDb();
  runId = (await insertRun(db, defaultRunConfig({ seedType: 'open' }))).id;
  await setSender(db);
});

describe('ValidationJobOptionsSchema', () => {
  it('defaults and bounds', () => {
    expect(opts).toEqual({ prospects: 25, skipProspects: false, refresh: false, redraft: false });
    expect(ValidationJobOptionsSchema.safeParse({ prospects: 101 }).success).toBe(false);
    expect(ValidationJobOptionsSchema.safeParse({ prospects: 0 }).success).toBe(false);
  });
});

describe('queueValidationJob', () => {
  it('queues with the default options', async () => {
    const caseId = await newCase();
    const r = await queueValidationJob(db, caseId, opts);
    expect(r.ok).toBe(true);
    const [row] = await db.select().from(validationJobs);
    expect(row).toMatchObject({ caseId, status: 'queued', options: opts });
  });

  it('not_found for an unknown case', async () => {
    expect(await queueValidationJob(db, '00000000-0000-4000-8000-000000000000', opts)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('refuses the example case', async () => {
    const caseId = await newCase();
    await db.update(cases).set({ isExample: true }).where(eq(cases.id, caseId));
    expect(await queueValidationJob(db, caseId, opts)).toEqual({ ok: false, reason: 'example' });
  });

  it('sender_missing when the sender is unset', async () => {
    const fresh = await testDb();
    const rid = (await insertRun(fresh, defaultRunConfig({ seedType: 'open' }))).id;
    const caseId = await newCase(fresh, rid);
    expect(await queueValidationJob(fresh, caseId, opts)).toEqual({ ok: false, reason: 'sender_missing' });
  });

  it('already_queued on a second queue', async () => {
    const caseId = await newCase();
    await queueValidationJob(db, caseId, opts);
    expect(await queueValidationJob(db, caseId, opts)).toEqual({ ok: false, reason: 'already_queued' });
  });

  it('allows a new job over a stale running one, not a fresh one', async () => {
    const caseId = await newCase();
    await db.insert(validationJobs).values({
      caseId, options: opts, status: 'running', startedAt: new Date(Date.now() - 3 * 3600_000),
    });
    expect((await queueValidationJob(db, caseId, opts)).ok).toBe(true);
    await db.delete(validationJobs);
    await db.insert(validationJobs).values({ caseId, options: opts, status: 'running', startedAt: new Date() });
    expect(await queueValidationJob(db, caseId, opts)).toEqual({ ok: false, reason: 'already_queued' });
  });

  it('too_many_queued across cases', async () => {
    for (let i = 0; i < MAX_QUEUED_VALIDATIONS; i++) expect((await queueValidationJob(db, await newCase(), opts)).ok).toBe(true);
    expect(await queueValidationJob(db, await newCase(), opts)).toEqual({ ok: false, reason: 'too_many_queued' });
  });
});

describe('latestValidationJob', () => {
  it('returns null with none, else the newest with a scrubbed, capped error', async () => {
    const caseId = await newCase();
    expect(await latestValidationJob(db, caseId)).toBeNull();
    await db.insert(validationJobs).values({ caseId, options: opts, status: 'failed', createdAt: new Date('2026-01-01') });
    await db.insert(validationJobs).values({
      caseId, options: opts, status: 'failed', createdAt: new Date('2026-02-01'), costUsd: '0.5',
      error: `auth failed api_key=ghp_abcdefghij0123456789ABCD ${'x'.repeat(400)}`,
    });
    const v = await latestValidationJob(db, caseId);
    expect(v!.createdAt).toEqual(new Date('2026-02-01'));
    expect(v!.costUsd).toBe(0.5);
    expect(v!.error).toContain('api_key=[redacted]');
    expect(v!.error).not.toContain('ghp_');
    expect(v!.error!.length).toBeLessThanOrEqual(300);
  });
});
