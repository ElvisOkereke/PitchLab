// Idea reviewer (gen audit review): a model stage outside the run pipeline scores a benchmark pass's generated ideas for
// scale, edge, novelty and niche. It never sees owner ratings, tags or holdout items; ideas are wrapped as untrusted.
import { and, asc, desc, eq, inArray, notExists } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { benchmarkPasses, ideaReviews, ideas, runs } from '../db/schema';
import { IDEA_REVIEW_VERSION } from '../bench/definitions';
import { costOf } from '../config/prices';
import { loadPrompt } from '../llm/prompts';
import { StructuredOutputError, type ModelRouter } from '../llm/types';
import { capField, wrapUntrusted } from '../llm/untrusted';
import { ideaBlock } from '../pipeline/idea-text';

/** Ideas per model call. */
export const REVIEW_BATCH_SIZE = 10;
/** Most ideas one review pass takes (a benchmark pass has about 60–72); the rest wait for the next run. */
export const REVIEW_IDEAS_MAX = 500;
const REASON_MAX = 300;

/**
 * Cost estimate per call: the prompt at about 4 characters a token, plus about 800 output tokens per idea (four short
 * reasons and the JSON, with room for a reasoning model's thinking). On the default model that is about 1 cent an idea,
 * in the spec's 1–2 cent range.
 */
const CHARS_PER_TOKEN = 4;
const OUTPUT_TOKENS_PER_IDEA = 800;

const ReasonsSchema = z.object({ scale: z.string(), edge: z.string(), novelty: z.string(), niche: z.string() });
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
export type ReviewResult = { reviewed: number; skipped: number; estimatedUsd: number };

/** Why a pass cannot be reviewed. */
export class ReviewRefusal extends Error {
  constructor(readonly reason: 'not_found' | 'running', passId: string) {
    super(reason === 'running' ? 'That pass is still running. Review it once its runs have finished.' : `No benchmark pass with id: ${passId}`);
    this.name = 'ReviewRefusal';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const inRange = (n: number) => Number.isInteger(n) && n >= 1 && n <= 5;

/** The newest benchmark pass (kind `pass`, not a baseline or recompute), or null. */
export async function newestPassId(db: Db): Promise<string | null> {
  const [row] = await db.select({ id: benchmarkPasses.id }).from(benchmarkPasses)
    .where(eq(benchmarkPasses.kind, 'pass'))
    .orderBy(desc(benchmarkPasses.createdAt), desc(benchmarkPasses.id))
    .limit(1);
  return row?.id ?? null;
}

/** Estimated cost of reviewing `ideaCount` ideas on `model`, sent as these rendered prompts (one call each). */
export function estimateReviewUsd(model: string, prompts: string[], ideaCount: number): number {
  if (prompts.length === 0 || ideaCount === 0) return 0;
  const inputTokens = prompts.reduce((t, p) => t + Math.ceil(p.length / CHARS_PER_TOKEN), 0);
  return costOf(model, { inputTokens, outputTokens: OUTPUT_TOKENS_PER_IDEA * ideaCount, searchRequests: 0 });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Reviews the pass's generated ideas that have no review under the current prompt version, 10 per call on the
 * `review` stage. Valid reviews are stored as each batch returns; unknown ids, repeats, out-of-range scores and ideas
 * the model left out are skipped and counted, so a re-run reviews only what is missing (R20). A batch whose output stays
 * invalid after the router's re-asks is skipped; any other error stops the run with earlier batches kept.
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

  const todo = pass.runIds.length === 0 ? [] : await db.select({
    id: ideas.id, title: ideas.title, oneLiner: ideas.oneLiner, buyer: ideas.buyer, problem: ideas.problem, solution: ideas.solution,
    knownIncumbents: ideas.knownIncumbents, functionalGap: ideas.functionalGap,
  })
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
  const prompts = batches.map((batch) => prompt.render({
    ideas: wrapUntrusted('ideas', batch.map((idea) => `Id: ${idea.id}\n${ideaBlock(idea)}`).join('\n\n')),
    count: String(batch.length),
  }));
  const estimatedUsd = estimateReviewUsd(model, prompts, todo.length);
  log(`${plural(todo.length, 'idea')} to review in ${plural(batches.length, 'call')} on ${model}, estimated $${estimatedUsd.toFixed(2)}.`);
  if (opts.dryRun || todo.length === 0) return { reviewed: 0, skipped: 0, estimatedUsd };

  let reviewed = 0;
  let skipped = 0;
  let invalid = 0;
  for (const [i, batch] of batches.entries()) {
    let entries: Entry[];
    try {
      const out = await router.structured('review', {
        prompt: prompts[i]!, schema: ReviewOutputSchema, schemaName: 'idea_reviews',
      }, { runId: null, promptVersion: prompt.version });
      entries = out.reviews;
    } catch (err) {
      if (!(err instanceof StructuredOutputError)) throw err;
      log(`Call ${i + 1} of ${batches.length}: the output stayed invalid, so its ${plural(batch.length, 'idea')} were skipped.`);
      skipped += batch.length;
      continue;
    }

    const wanted = new Set(batch.map((b) => b.id));
    const rows: (typeof ideaReviews.$inferInsert)[] = [];
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
        },
        model, promptVersion: prompt.version,
      });
    }
    const stored = rows.length === 0 ? [] : await db.insert(ideaReviews).values(rows)
      .onConflictDoNothing({ target: [ideaReviews.ideaId, ideaReviews.promptVersion] })
      .returning({ id: ideaReviews.id });
    reviewed += stored.length;
    skipped += batch.length - stored.length;
  }
  if (invalid > 0) log(`Dropped ${plural(invalid, 'invalid review')} (unknown or repeated ids, or scores outside 1–5).`);
  if (skipped > 0) log(`${plural(skipped, 'idea')} got no valid review; run the command again to retry them.`);
  return { reviewed, skipped, estimatedUsd };
}
