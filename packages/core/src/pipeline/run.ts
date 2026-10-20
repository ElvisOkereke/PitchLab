import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { runs, runStages } from '../db/schema';
import { dedupe } from './dedupe';
import { deepCase } from './deep-case';
import { gate } from './gate';
import { harvest } from './harvest';
import { ideate } from './ideate';
import { score } from './score';
import { screen } from './screen';
import { STAGES, type RunConfig, type Stage, type StageDeps, type StageFn } from './types';
import { verify } from './verify';

/** The real stage functions, in pipeline order. */
export const DEFAULT_STAGE_IMPLS: Record<Stage, StageFn> = {
  harvest: (deps, run) => harvest(deps, run), // third parameter is opts, not an input
  ideate,
  dedupe,
  screen,
  gate,
  case: deepCase,
  verify,
  score,
};

/** The id list whose emptiness means there is nothing left for later stages to do. */
const EMPTY_KEY: Record<Stage, string | null> = {
  harvest: 'signalIds',
  ideate: 'ideaIds',
  dedupe: 'ideaIds',
  screen: 'ideaIds',
  gate: 'passed',
  case: 'caseIds',
  verify: 'caseIds',
  score: null,
};

function isEmptyOutput(stage: Stage, output: unknown, config: RunConfig): boolean {
  const key = EMPTY_KEY[stage];
  if (key === null) return false;
  // An owner idea always gets a case (gate is advisory), even when harvest found no signals.
  if (stage === 'harvest' && config.seedType === 'idea') return false;
  const list = (output as Record<string, unknown> | null | undefined)?.[key];
  return Array.isArray(list) && list.length === 0;
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Inserts a run row. `gen run` creates its run as `running` (it executes it at once), so a `gen worker` sharing the
 * database never claims it; runs queued for the worker are `queued` (the default).
 */
export async function createRun(
  db: Db,
  config: RunConfig,
  o: { status?: 'queued' | 'running' } = {},
): Promise<{ id: string }> {
  const [row] = await db.insert(runs).values({ config, status: o.status ?? 'queued' }).returning({ id: runs.id });
  return { id: row!.id };
}

/**
 * Runs every stage in order, persisting each stage's output. Stages already `done` are reused, so calling
 * this again on a failed run resumes from the failed stage (stages are idempotent per item, R20).
 */
export async function executeRun(
  deps: StageDeps,
  runId: string,
  stageImpls: Partial<Record<Stage, StageFn>> = {},
): Promise<'succeeded' | 'failed'> {
  const { db } = deps;
  const [row] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!row) throw new Error(`Run not found: ${runId}`);
  const run = { id: row.id, config: row.config };
  const impls = { ...DEFAULT_STAGE_IMPLS, ...stageImpls };

  await db.update(runs)
    .set({ status: 'running', startedAt: row.startedAt ?? new Date(), finishedAt: null, error: null })
    .where(eq(runs.id, runId));

  const existing = await db.select().from(runStages).where(eq(runStages.runId, runId));
  const doneOutputs = new Map(existing.filter((r) => r.status === 'done').map((r) => [r.stage, r.output]));

  const saveStage = async (stage: Stage, values: Omit<typeof runStages.$inferInsert, 'runId' | 'stage'>) => {
    await db.insert(runStages)
      .values({ runId, stage, ...values })
      .onConflictDoUpdate({ target: [runStages.runId, runStages.stage], set: values });
  };

  let previous: unknown = undefined;
  let skipRest = false;
  for (const stage of STAGES) {
    const log = (msg: string) => deps.log(`[${stage}] ${msg}`);

    if (skipRest) {
      if (!doneOutputs.has(stage)) {
        const now = new Date();
        await saveStage(stage, { status: 'done', output: {}, startedAt: now, finishedAt: now });
      }
      log('skipped (nothing to process)');
      continue;
    }

    if (doneOutputs.has(stage)) {
      previous = doneOutputs.get(stage);
      log('reused output from an earlier attempt');
    } else {
      await db.update(runs).set({ currentStage: stage }).where(eq(runs.id, runId));
      await saveStage(stage, { status: 'running', output: null, startedAt: new Date(), finishedAt: null });
      log('started');
      let output: object;
      try {
        output = await impls[stage]({ ...deps, log }, run, previous);
      } catch (err) {
        const error = messageOf(err);
        const now = new Date();
        await saveStage(stage, { status: 'failed', finishedAt: now });
        await db.update(runs).set({ status: 'failed', error, finishedAt: now }).where(eq(runs.id, runId));
        log(`failed: ${error}`);
        return 'failed';
      }
      await saveStage(stage, { status: 'done', output, finishedAt: new Date() });
      log('done');
      previous = output;
    }

    if (isEmptyOutput(stage, previous, run.config)) skipRest = true;
  }

  await db.update(runs).set({ status: 'succeeded', finishedAt: new Date() }).where(eq(runs.id, runId));
  return 'succeeded';
}
