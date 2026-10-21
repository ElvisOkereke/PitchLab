import { and, eq, gte, isNull, sum } from 'drizzle-orm';
import { ValidationJobOptionsSchema } from '../dashboard/validation-jobs';
import { dataCalls, llmCalls, validationJobs } from '../db/schema';
import { errorMessage, scrubError } from '../tools/scrub';
import { runValidation, type ValidationDeps } from './run';

const ERROR_MAX = 1000;

/** Spend recorded outside pipeline runs (validation calls carry no run id) since `since`. */
async function spendSince(db: ValidationDeps['db'], since: Date): Promise<number> {
  const [llm] = await db.select({ total: sum(llmCalls.costUsd) }).from(llmCalls).where(and(isNull(llmCalls.runId), gte(llmCalls.createdAt, since)));
  const [data] = await db.select({ total: sum(dataCalls.costUsd) }).from(dataCalls).where(and(isNull(dataCalls.runId), gte(dataCalls.createdAt, since)));
  return Number(llm?.total ?? 0) + Number(data?.total ?? 0);
}

/** Runs a claimed (running) validation job and records steps, status, cost and any error. Job failures never throw. */
export async function executeValidationJob(
  deps: ValidationDeps,
  jobId: string,
  run: typeof runValidation = runValidation,
): Promise<'succeeded' | 'failed'> {
  const { db } = deps;
  const fail = async (error: string, extra: { costUsd?: string } = {}) => {
    await db.update(validationJobs)
      .set({ status: 'failed', error: scrubError(error).slice(0, ERROR_MAX), finishedAt: new Date(), ...extra })
      .where(eq(validationJobs.id, jobId));
    return 'failed' as const;
  };
  const [job] = await db.select().from(validationJobs).where(eq(validationJobs.id, jobId));
  if (!job) return 'failed';
  const parsed = ValidationJobOptionsSchema.safeParse(job.options);
  if (!parsed.success) return fail('invalid job options');
  const startedAt = job.startedAt ?? new Date();
  const { prospects, skipProspects, refresh, redraft } = parsed.data;
  try {
    const result = await run(deps, job.caseId, { prospects, skipProspects, refresh, redraft });
    const costUsd = String(await spendSince(db, startedAt));
    const status = result.ok ? 'succeeded' : 'failed';
    await db.update(validationJobs)
      .set({ steps: result.steps, status, finishedAt: new Date(), costUsd })
      .where(eq(validationJobs.id, jobId));
    return status;
  } catch (err) {
    let costUsd: string | undefined;
    try {
      costUsd = String(await spendSince(db, startedAt));
    } catch {
      // keep the failure itself
    }
    return fail(errorMessage(err), costUsd === undefined ? {} : { costUsd });
  }
}
