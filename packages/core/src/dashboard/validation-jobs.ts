import { and, count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { cases, validationJobs, type runStatus } from '../db/schema';
import { scrubError } from '../tools/scrub';
import type { StepResult } from '../validation/run';
import { getSender } from '../validation/settings';

// Web-safe: imported by the dashboard. No env, db client, router or validation runtime here.

type RunStatus = (typeof runStatus.enumValues)[number];

export const ValidationJobOptionsSchema = z.object({
  prospects: z.number().int().min(1).max(100).default(25),
  skipProspects: z.boolean().default(false),
  refresh: z.boolean().default(false),
  redraft: z.boolean().default(false),
});
export type ValidationJobOptions = z.infer<typeof ValidationJobOptionsSchema>;

/** Most validation jobs that may wait in the queue at once. */
export const MAX_QUEUED_VALIDATIONS = 3;
/** A `running` job older than this is treated as dead (the worker stopped), so a new one may be queued. */
export const STALE_RUNNING_MS = 2 * 60 * 60 * 1000;
/** Serialises queue inserts (transaction-scoped lock); a different key from queueRun's. */
const VALIDATION_LOCK_KEY = 0x6263_7132; // "bcq2"

export type QueueValidationResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'not_found' | 'example' | 'sender_missing' | 'already_queued' | 'too_many_queued' };

/** Queues a validation pack for `gen worker`. Checks in order: case exists, not the example, sender set, no live job for the case, global cap. */
export async function queueValidationJob(db: Db, caseId: string, raw: ValidationJobOptions): Promise<QueueValidationResult> {
  const options = ValidationJobOptionsSchema.parse(raw);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${VALIDATION_LOCK_KEY})`);
    const [kase] = await tx.select({ isExample: cases.isExample }).from(cases).where(eq(cases.id, caseId));
    if (!kase) return { ok: false, reason: 'not_found' } as const;
    if (kase.isExample) return { ok: false, reason: 'example' } as const;
    if ((await getSender(tx as unknown as Db)).missing.length > 0) return { ok: false, reason: 'sender_missing' } as const;
    const cutoff = new Date(Date.now() - STALE_RUNNING_MS);
    const [live] = await tx.select({ n: count() }).from(validationJobs).where(and(
      eq(validationJobs.caseId, caseId),
      sql`(${validationJobs.status} = 'queued' or (${validationJobs.status} = 'running' and ${validationJobs.startedAt} > ${cutoff}))`,
    ));
    if ((live?.n ?? 0) > 0) return { ok: false, reason: 'already_queued' } as const;
    const [queued] = await tx.select({ n: count() }).from(validationJobs).where(eq(validationJobs.status, 'queued'));
    if ((queued?.n ?? 0) >= MAX_QUEUED_VALIDATIONS) return { ok: false, reason: 'too_many_queued' } as const;
    const [row] = await tx.insert(validationJobs).values({ caseId, options, status: 'queued' }).returning({ id: validationJobs.id });
    return { ok: true, id: row!.id } as const;
  });
}

export type ValidationJobView = {
  id: string;
  status: RunStatus;
  options: ValidationJobOptions;
  steps: StepResult[] | null;
  error: string | null;
  costUsd: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};

/** The newest validation job of a case, or null. The error is scrubbed and cut to 300 characters. */
export async function latestValidationJob(db: Db, caseId: string): Promise<ValidationJobView | null> {
  const [r] = await db.select().from(validationJobs).where(eq(validationJobs.caseId, caseId))
    .orderBy(desc(validationJobs.createdAt), desc(validationJobs.id)).limit(1);
  if (!r) return null;
  return {
    id: r.id,
    status: r.status,
    options: ValidationJobOptionsSchema.parse(r.options),
    steps: r.steps ?? null,
    error: r.error === null ? null : scrubError(r.error).slice(0, 300),
    costUsd: Number(r.costUsd),
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
}
