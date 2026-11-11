// Idea reviewer (gen audit review): a model stage outside the run pipeline scores a benchmark pass's generated ideas for
// scale, edge, novelty and niche. It never sees owner ratings, tags or holdout items; ideas are wrapped as untrusted.
import { and, asc, desc, eq, inArray, isNull, notExists, sum } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { benchmarkPasses, ideaReviews, ideas, llmCalls, runs } from '../db/schema';
import { IDEA_REVIEW_VERSION } from '../bench/definitions';
import { costOf } from '../config/prices';
import { loadPrompt } from '../llm/prompts';
import { isModelFailure } from '../llm/retry';
import { StructuredOutputError, type ModelRouter } from '../llm/types';
import { capField, wrapUntrusted } from '../llm/untrusted';
import { ideaBlock } from '../pipeline/idea-text';

/** Ideas per model call. */
export const REVIEW_BATCH_SIZE = 10;
/** Most ideas one review pass takes (a benchmark pass has about 60–72); the rest wait for the next run. */
export const REVIEW_IDEAS_MAX = 500;
const REASON_MAX = 300;
/** Output tokens a review call may use: ten ideas of reasons and JSON, with room for a reasoning model's thinking. */
export const REVIEW_MAX_TOKENS = 16000;
/** The soft budget: a run stops after a batch once its review spend passes this multiple of the estimate. */
export const REVIEW_BUDGET_MULTIPLE = 2;

/**
 * Cost estimate per call: the prompt at about 4 characters a token, plus about 800 output tokens per idea (four short
 * reasons and the JSON, with room for a reasoning model's thinking). On the default model that is about 1 cent an idea,
 * in the spec's 1–2 cent range.
 */
const CHARS_PER_TOKEN = 4;
const OUTPUT_TOKENS_PER_IDEA = 800;

const ReasonsSchema = z.object({ scale: z.string(), edge: z.string(), novelty: z.string(), niche: z.string(), upside: z.string().optional() });
const score = z.number().describe('a whole number from 1 to 5');
/**
 * What the model returns. Scores are any number here so that one bad entry is skipped on its own instead of failing
 * (and re-asking) the whole batch; `validEntry` checks ids and ranges entry by entry.
 */
export const ReviewOutputSchema = z.object({
  reviews: z.array(z.object({ ideaId: z.string(), scale: score, edge: score, novelty: score, niche: score, reasons: ReasonsSchema })),
});
type Entry = z.infer<typeof ReviewOutputSchema>['reviews'][number];

export type ReviewDeps = { db: Db; router: ModelRouter; log: (m: string) => void };
export type ReviewResult = {
  reviewed: number;
  skipped: number;
  estimatedUsd: number;
  /** Review spend logged since this run started (llm_calls on the `review` stage outside any run). */
  spentUsd: number;
  /** True when the soft budget stopped the run before its last batch. */
  stoppedForBudget: boolean;
};

/** Why a pass cannot be reviewed. */
export class ReviewRefusal extends Error {
  constructor(readonly reason: 'not_found' | 'running', passId: string) {
    super(reason === 'running' ? 'That pass is still running. Review it once its runs have finished.' : `No benchmark pass with id: ${passId}`);
    this.name = 'ReviewRefusal';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const inRange = (n: number) => Number.isInteger(n) && n >= 1 && n <= 5;

/**
 * The pass `--last` means: the newest finished benchmark pass (kind `pass`, not a baseline or recompute, status not
 * `running`); only when none has finished, the newest pass (which the reviewer then refuses as still running); or null.
 */
export async function newestPassId(db: Db): Promise<string | null> {
  const rows = await db.select({ id: benchmarkPasses.id, status: benchmarkPasses.status }).from(benchmarkPasses)
    .where(eq(benchmarkPasses.kind, 'pass'))
    .orderBy(desc(benchmarkPasses.createdAt), desc(benchmarkPasses.id))
    .limit(50);
  return (rows.find((r) => r.status !== 'running') ?? rows[0])?.id ?? null;
}

/** Total review spend logged so far (llm_calls on the `review` stage outside any run). */
async function reviewSpendUsd(db: Db): Promise<number> {
  const [row] = await db.select({ total: sum(llmCalls.costUsd) }).from(llmCalls)
    .where(and(eq(llmCalls.stage, 'review'), isNull(llmCalls.runId)));
  return Number(row?.total ?? 0);
}

/** Estimated cost of reviewing `ideaCount` ideas on `model`, sent as these rendered prompts (one call each). */
export function estimateReviewUsd(model: string, prompts: string[], ideaCount: number): number {
  if (prompts.length === 0 || ideaCount === 0) return 0;
  const inputTokens = prompts.reduce((t, p) => t + Math.ceil(p.length / CHARS_PER_TOKEN), 0);
  return costOf(model, { inputTokens, outputTokens: OUTPUT_TOKENS_PER_IDEA * ideaCount, searchRequests: 0 });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

type ReviewIdea = Pick<typeof ideas.$inferSelect, 'id' | 'title' | 'oneLiner' | 'buyer' | 'problem' | 'solution' | 'knownIncumbents' | 'functionalGap' | 'edge' | 'scale' | 'scaleEstimate' | 'scaleResult'>;
const reviewIdeaColumns = {
  id: ideas.id, title: ideas.title, oneLiner: ideas.oneLiner, buyer: ideas.buyer, problem: ideas.problem, solution: ideas.solution,
  knownIncumbents: ideas.knownIncumbents, functionalGap: ideas.functionalGap, edge: ideas.edge, scale: ideas.scale,
  scaleEstimate: ideas.scaleEstimate, scaleResult: ideas.scaleResult,
};
const renderBatch = (prompt: ReturnType<typeof loadPrompt>, batch: ReviewIdea[]) => prompt.render({
  ideas: wrapUntrusted('ideas', batch.map((idea) => `Id: ${idea.id}\n${ideaBlock(idea)}`).join('\n\n')),
  count: String(batch.length),
});

/**
 * One review call and its storage, shared by the benchmark-pass review and the per-run review: valid entries (known
 * id, not repeated, scores 1-5) are stored; `failed` is true when the output stayed invalid after the router's re-asks
 * (any other router error is thrown unless `tolerateModelFailures`, which also treats a provider error (isModelFailure)
 * as a failed batch, with its message in `error`). Only the router call is guarded, and a database or code error always
 * throws, including one the router raises while logging the call.
 */
async function reviewBatch(
  deps: ReviewDeps, promptVersion: string, model: string, prompt: string, batch: ReviewIdea[], runId: string | null,
  tolerateModelFailures = false,
): Promise<{ failed: boolean; stored: number; invalid: number; error?: string }> {
  const { db, router } = deps;
  let entries: Entry[];
  try {
    const out = await router.structured('review', {
      prompt, schema: ReviewOutputSchema, schemaName: 'idea_reviews', maxTokens: REVIEW_MAX_TOKENS,
    }, { runId, promptVersion });
    entries = out.reviews;
  } catch (err) {
    if (!(err instanceof StructuredOutputError) && !(tolerateModelFailures && isModelFailure(err))) throw err;
    return { failed: true, stored: 0, invalid: 0, error: err instanceof Error ? err.message : String(err) };
  }
  const wanted = new Set(batch.map((b) => b.id));
  const rows: (typeof ideaReviews.$inferInsert)[] = [];
  let invalid = 0;
  for (const e of entries) {
    const ok = wanted.has(e.ideaId) && inRange(e.scale) && inRange(e.edge) && inRange(e.novelty) && inRange(e.niche);
    if (!ok) {
      invalid += 1;
      continue;
    }
    wanted.delete(e.ideaId); // a repeat of an id already taken is invalid
    rows.push({
      ideaId: e.ideaId, scale: e.scale, edge: e.edge, novelty: e.novelty, niche: e.niche,
      reasons: {
        scale: capField(e.reasons.scale, REASON_MAX), edge: capField(e.reasons.edge, REASON_MAX),
        novelty: capField(e.reasons.novelty, REASON_MAX), niche: capField(e.reasons.niche, REASON_MAX),
        ...(e.reasons.upside ? { upside: capField(e.reasons.upside, REASON_MAX) } : {}),
      },
      model, promptVersion,
    });
  }
  const stored = rows.length === 0 ? [] : await db.insert(ideaReviews).values(rows)
    .onConflictDoNothing({ target: [ideaReviews.ideaId, ideaReviews.promptVersion] })
    .returning({ id: ideaReviews.id });
  return { failed: false, stored: stored.length, invalid };
}

/** The review score total: scale + edge + novelty + niche. Calibration and the screen both rank by it. */
export const reviewTotal = (r: Pick<typeof ideaReviews.$inferSelect, 'scale' | 'edge' | 'novelty' | 'niche'>): number => r.scale + r.edge + r.novelty + r.niche;

/** The newest review total of each of the given ideas (any prompt version); ideas with no review are absent. */
export async function reviewTotals(db: Db, ideaIds: string[]): Promise<Map<string, number>> {
  if (ideaIds.length === 0) return new Map();
  const rows = await db.select().from(ideaReviews).where(inArray(ideaReviews.ideaId, ideaIds))
    .orderBy(desc(ideaReviews.createdAt), desc(ideaReviews.id));
  const out = new Map<string, number>();
  for (const r of rows) if (!out.has(r.ideaId)) out.set(r.ideaId, reviewTotal(r));
  return out;
}

/**
 * Reviews the given ideas of one run that have no review yet (same prompt, schema and storage as reviewPassIdeas, 10 per
 * call on the `review` stage, logged under `runId`) and returns each idea's newest review total. A failed batch (invalid
 * output or any router error) leaves its ideas out of the map and is logged once; this never throws for a model failure,
 * but a storage or code error rejects.
 */
export async function reviewRunIdeas(deps: ReviewDeps, runId: string, ideaIds: string[]): Promise<Map<string, number>> {
  const { db, router, log } = deps;
  if (ideaIds.length === 0) return new Map();
  const prompt = loadPrompt('idea-review');
  const todo = await db.select(reviewIdeaColumns).from(ideas)
    .where(and(
      inArray(ideas.id, ideaIds),
      notExists(db.select({ one: ideaReviews.id }).from(ideaReviews)
        .where(and(eq(ideaReviews.ideaId, ideas.id), eq(ideaReviews.promptVersion, prompt.version)))),
    ))
    .orderBy(asc(ideas.createdAt), asc(ideas.id));
  if (todo.length > 0) {
    const model = router.modelFor('review');
    let lastError = '';
    for (let i = 0; i < todo.length; i += REVIEW_BATCH_SIZE) {
      const batch = todo.slice(i, i + REVIEW_BATCH_SIZE);
      // A model failure leaves the batch unreviewed; a storage or code error propagates.
      const res = await reviewBatch(deps, prompt.version, model, renderBatch(prompt, batch), batch, runId, true);
      if (res.failed) lastError = res.error ?? 'the output stayed invalid';
    }
    // Counted from storage, so a review another run stored meanwhile (an insert skipped on conflict) is not missed.
    const done = await db.select({ id: ideaReviews.ideaId }).from(ideaReviews)
      .where(and(inArray(ideaReviews.ideaId, todo.map((t) => t.id)), eq(ideaReviews.promptVersion, prompt.version)));
    const unreviewed = todo.length - done.length;
    if (unreviewed > 0) log(`review: ${unreviewed} of ${todo.length} ideas still unreviewed (last error: ${lastError || 'invalid or missing entries'}); they rank without a review.`);
  }
  return reviewTotals(db, ideaIds);
}

/**
 * Reviews the pass's generated ideas that have no review under the current prompt version, 10 per call on the
 * `review` stage. Valid reviews are stored as each batch returns; unknown ids, repeats, out-of-range scores and ideas
 * the model left out are skipped and counted, so a re-run reviews only what is missing (R20). A batch whose output stays
 * invalid after the router's re-asks is skipped; any other error stops the run with earlier batches kept. A soft
 * budget stops the run after a batch once its spend passes twice the estimate (earlier batches kept; a re-run goes on).
 * `dryRun` estimates the cost and makes no call.
 */
export async function reviewPassIdeas(deps: ReviewDeps, passId: string, opts: { dryRun?: boolean } = {}): Promise<ReviewResult> {
  const { db, router, log } = deps;
  if (!UUID_RE.test(passId)) throw new ReviewRefusal('not_found', passId);
  const [pass] = await db.select({ status: benchmarkPasses.status, runIds: benchmarkPasses.runIds })
    .from(benchmarkPasses).where(eq(benchmarkPasses.id, passId));
  if (!pass) throw new ReviewRefusal('not_found', passId);
  if (pass.status === 'running') throw new ReviewRefusal('running', passId);

  const prompt = loadPrompt('idea-review');
  if (prompt.version !== IDEA_REVIEW_VERSION) {
    throw new Error(`The newest idea-review prompt is ${prompt.version}, but IDEA_REVIEW_VERSION is ${IDEA_REVIEW_VERSION}; update it in bench/definitions.ts.`);
  }
  const model = router.modelFor('review');

  const todo = pass.runIds.length === 0 ? [] : await db.select(reviewIdeaColumns)
    .from(ideas)
    .innerJoin(runs, eq(runs.id, ideas.runId))
    .where(and(
      inArray(ideas.runId, pass.runIds),
      eq(runs.isExample, false),
      eq(ideas.origin, 'generated'),
      notExists(db.select({ one: ideaReviews.id }).from(ideaReviews)
        .where(and(eq(ideaReviews.ideaId, ideas.id), eq(ideaReviews.promptVersion, prompt.version)))),
    ))
    .orderBy(asc(ideas.createdAt), asc(ideas.id))
    .limit(REVIEW_IDEAS_MAX + 1);
  if (todo.length > REVIEW_IDEAS_MAX) {
    todo.length = REVIEW_IDEAS_MAX;
    log(`More than ${REVIEW_IDEAS_MAX} ideas need a review; this run takes the first ${REVIEW_IDEAS_MAX}. Run it again for the rest.`);
  }

  const batches: (typeof todo)[] = [];
  for (let i = 0; i < todo.length; i += REVIEW_BATCH_SIZE) batches.push(todo.slice(i, i + REVIEW_BATCH_SIZE));
  const prompts = batches.map((batch) => renderBatch(prompt, batch));
  const estimatedUsd = estimateReviewUsd(model, prompts, todo.length);
  log(`${plural(todo.length, 'idea')} to review in ${plural(batches.length, 'call')} on ${model}, estimated $${estimatedUsd.toFixed(2)}.`);
  if (opts.dryRun || todo.length === 0) return { reviewed: 0, skipped: 0, estimatedUsd, spentUsd: 0, stoppedForBudget: false };

  // Spend is measured as the logged total minus the total at the start, so no clock is compared.
  const spentBefore = await reviewSpendUsd(db);
  let spentUsd = 0;
  let stoppedForBudget = false;
  let reviewed = 0;
  let skipped = 0;
  let invalid = 0;
  for (const [i, batch] of batches.entries()) {
    if (i > 0) {
      spentUsd = (await reviewSpendUsd(db)) - spentBefore;
      if (spentUsd > REVIEW_BUDGET_MULTIPLE * estimatedUsd) {
        log(`Stopped after call ${i} of ${batches.length}: spent $${spentUsd.toFixed(2)}, more than twice the estimate ($${estimatedUsd.toFixed(2)}). ${plural(reviewed, 'idea')} reviewed so far; run the command again to go on.`);
        stoppedForBudget = true;
        break;
      }
    }
    const res = await reviewBatch(deps, prompt.version, model, prompts[i]!, batch, null);
    if (res.failed) {
      log(`Call ${i + 1} of ${batches.length}: the output stayed invalid, so its ${plural(batch.length, 'idea')} were skipped.`);
      skipped += batch.length;
      continue;
    }
    invalid += res.invalid;
    const stored = res.stored;
    reviewed += stored;
    skipped += batch.length - stored;
  }
  if (!stoppedForBudget) spentUsd = (await reviewSpendUsd(db)) - spentBefore;
  if (invalid > 0) log(`Dropped ${plural(invalid, 'invalid review')} (unknown or repeated ids, or scores outside 1–5).`);
  if (skipped > 0) log(`${plural(skipped, 'idea')} got no valid review; run the command again to retry them.`);
  return { reviewed, skipped, estimatedUsd, spentUsd, stoppedForBudget };
}
