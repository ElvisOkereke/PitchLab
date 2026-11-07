// Scale estimator (gen audit scale): a model stage outside the run pipeline writes the same scaleEstimate that ideate.v13
// gives new ideas, for ideas that have none. It never reads a case stage, owner rating or tag into a prompt; ideas and
// library entries are wrapped as untrusted. Only ideas without an estimate are sent, so a re-run fills what is missing (R20).
import { and, asc, eq, inArray, isNull, ne, sum } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { benchmarkPasses, cases, ideas, llmCalls, runs, signals } from '../db/schema';
import { costOf } from '../config/prices';
import { loadPrompt, type LoadedPrompt } from '../llm/prompts';
import { StructuredOutputError, type ModelRouter } from '../llm/types';
import { capField, wrapUntrusted } from '../llm/untrusted';
import { ideationContext } from '../library/context';
import { ScaleEstimateSchema, computeScale, type PriceHint } from '../pipeline/business-models';
import { ideaBlock } from '../pipeline/idea-text';
import { leadingNumber } from '../pipeline/ideate';
import { ReviewRefusal } from './review';

/** Ideas per model call. */
export const ESTIMATE_BATCH_SIZE = 8;
/** Most ideas one run takes; the rest wait for the next run. */
export const ESTIMATE_IDEAS_MAX = 500;
/** Output tokens a call may use: eight ideas of five short bases and JSON, with room for a reasoning model's thinking. */
export const ESTIMATE_MAX_TOKENS = 16000;
/** The soft budget: a run stops after a batch once its spend passes this multiple of the estimate. */
export const ESTIMATE_BUDGET_MULTIPLE = 2;
/** Nearest live library market entries shown per idea. */
export const MARKETS_PER_IDEA = 5;
const CHARS_PER_TOKEN = 4;
const OUTPUT_TOKENS_PER_IDEA = 600;
/** About how long one rendered market line is (capped at 300 in the prompt). */
const MARKET_LINE_CHARS = 250;
const BASIS_MAX = 300;
const SOURCE_MAX = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A number as the model wrote it: a number or number text (normalised in buildEstimate). */
const num = z.union([z.number(), z.string()]);
const basis = z.string().optional().default('');
const sourced = z.object({ pct: num, basis, source: z.string().nullish() });
/**
 * What the model returns. Numbers may be text so one bad entry is skipped on its own instead of failing (and re-asking)
 * the whole batch; `buildEstimate` normalises and validates entry by entry.
 */
export const EstimateOutputSchema = z.object({
  estimates: z.array(z.object({
    ideaId: z.string(),
    buyerUnit: z.string(),
    population: z.object({ count: num, basis, source: z.string().nullish() }),
    shareWithProblem: sourced,
    shareWillingToPay: sourced,
    shareReachable: z.object({ pct: num, basis }),
  })),
});
type Entry = z.infer<typeof EstimateOutputSchema>['estimates'][number];

export type EstimateDeps = { db: Db; router: ModelRouter; log: (m: string) => void };
export type EstimateTarget = { passId: string } | { decided: true };
export type EstimateResult = { estimated: number; skipped: number; estimatedUsd: number; spentUsd: number; stoppedForBudget: boolean };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** Plain digits only (a trailing period, or a percent sign after a share). Magnitude words ("2 million") stay text and fail validation. */
const COUNT_REST = /^\.?$/;
const PCT_REST = /^%?\.?$/;

/** Total spend logged so far on the review stage outside any run (shared with the reviewer; measured as a delta). */
async function spendUsd(db: Db): Promise<number> {
  const [row] = await db.select({ total: sum(llmCalls.costUsd) }).from(llmCalls)
    .where(and(eq(llmCalls.stage, 'review'), isNull(llmCalls.runId)));
  return Number(row?.total ?? 0);
}

/** A source is kept only when it is a library id shown for this idea or a URL the idea's own text or signals carry. */
function keepSource(raw: string | null | undefined, allowed: Set<string>): string | undefined {
  const s = capField(raw, SOURCE_MAX);
  if (!s) return undefined;
  const bare = s.replace(/^\[\s*(.*?)\s*\]$/, '$1').toLowerCase();
  if (UUID_RE.test(bare)) return allowed.has(bare) ? bare : undefined;
  return /^https?:\/\//i.test(s) && allowed.has(s.toLowerCase()) ? s : undefined;
}

/** The validated estimate for one entry, or null when it is invalid. */
export function buildEstimate(e: Entry, allowed: Set<string>) {
  const pct = (v: unknown) => leadingNumber(v, PCT_REST);
  const src = (s: string | null | undefined) => { const k = keepSource(s, allowed); return k ? { source: k } : {}; };
  const parsed = ScaleEstimateSchema.safeParse({
    buyerUnit: e.buyerUnit.trim().toLowerCase(),
    population: { count: leadingNumber(e.population.count, COUNT_REST), basis: capField(e.population.basis, BASIS_MAX), ...src(e.population.source) },
    shareWithProblem: { pct: pct(e.shareWithProblem.pct), basis: capField(e.shareWithProblem.basis, BASIS_MAX), ...src(e.shareWithProblem.source) },
    shareWillingToPay: { pct: pct(e.shareWillingToPay.pct), basis: capField(e.shareWillingToPay.basis, BASIS_MAX), ...src(e.shareWillingToPay.source) },
    shareReachable: { pct: pct(e.shareReachable.pct), basis: capField(e.shareReachable.basis, BASIS_MAX) },
  });
  return parsed.success ? parsed.data : null;
}

type Todo = Pick<typeof ideas.$inferSelect, 'id' | 'title' | 'oneLiner' | 'buyer' | 'problem' | 'solution' | 'knownIncumbents' | 'functionalGap' | 'edge' | 'scale' | 'priceHint' | 'embedding' | 'signalIds'>;

const cols = {
  id: ideas.id, title: ideas.title, oneLiner: ideas.oneLiner, buyer: ideas.buyer, problem: ideas.problem, solution: ideas.solution,
  knownIncumbents: ideas.knownIncumbents, functionalGap: ideas.functionalGap, edge: ideas.edge, scale: ideas.scale,
  priceHint: ideas.priceHint, embedding: ideas.embedding, signalIds: ideas.signalIds,
};

async function selectTodo(db: Db, target: EstimateTarget): Promise<Todo[]> {
  if ('decided' in target) {
    // Ideas behind cases moved off `new` (kept or killed); the example case is never included. Only this selection reads
    // the stage: it never reaches a prompt.
    const rows = await db.select(cols).from(ideas).innerJoin(cases, eq(cases.ideaId, ideas.id))
      .where(and(ne(cases.stage, 'new'), eq(cases.isExample, false), isNull(ideas.scaleEstimate)))
      .orderBy(asc(ideas.createdAt), asc(ideas.id)).limit(ESTIMATE_IDEAS_MAX + 1);
    return rows;
  }
  if (!UUID_RE.test(target.passId)) throw new ReviewRefusal('not_found', target.passId);
  const [pass] = await db.select({ status: benchmarkPasses.status, runIds: benchmarkPasses.runIds })
    .from(benchmarkPasses).where(eq(benchmarkPasses.id, target.passId));
  if (!pass) throw new ReviewRefusal('not_found', target.passId);
  if (pass.status === 'running') throw new ReviewRefusal('running', target.passId);
  if (pass.runIds.length === 0) return [];
  const rows = await db.select(cols).from(ideas).innerJoin(runs, eq(runs.id, ideas.runId))
    .where(and(inArray(ideas.runId, pass.runIds), eq(runs.isExample, false), eq(ideas.origin, 'generated'), isNull(ideas.scaleEstimate)))
    .orderBy(asc(ideas.createdAt), asc(ideas.id)).limit(ESTIMATE_IDEAS_MAX + 1);
  return rows;
}

function priceLine(p: unknown): string {
  const x = p as PriceHint | null;
  if (!x || !Number.isFinite(x.amount) || typeof x.unit !== 'string') return 'none given';
  return `${x.amount} ${capField(x.unit, 60)}`;
}

const ideasText = (batch: Todo[]) => batch.map((i) => `Id: ${i.id}\n${ideaBlock(i)}\nPrice hint: ${priceLine(i.priceHint)}`).join('\n\n');

/** The prompt for one batch with a placeholder library block, for the cost estimate (no embedding or query needed). */
function approxPrompt(prompt: LoadedPrompt, batch: Todo[]): string {
  return prompt.render({
    ideas: wrapUntrusted('ideas', ideasText(batch)),
    library: wrapUntrusted('library', 'x'.repeat(batch.length * MARKETS_PER_IDEA * MARKET_LINE_CHARS)),
    count: String(batch.length),
  });
}

/** The prompt for one batch: the ideas, and each idea's 5 nearest live market entries (its embedding, else title and one-liner). */
async function renderBatch(deps: EstimateDeps, prompt: LoadedPrompt, batch: Todo[]): Promise<{ text: string; allowed: Map<string, Set<string>> }> {
  const { db, router } = deps;
  const missing = batch.filter((i) => !i.embedding);
  const vectors = new Map<string, number[]>();
  if (missing.length > 0) {
    const out = await router.embed(missing.map((i) => `${capField(i.title, 200)}. ${capField(i.oneLiner, 600)}`), { runId: null, promptVersion: 'library-query.v1' });
    missing.forEach((i, n) => { if (out[n]) vectors.set(i.id, out[n]!); });
  }
  const signalIds = [...new Set(batch.flatMap((i) => i.signalIds ?? []))].slice(0, 200);
  const urlRows = signalIds.length === 0 ? [] : await db.select({ id: signals.id, url: signals.url }).from(signals).where(inArray(signals.id, signalIds));
  const urlById = new Map(urlRows.map((r) => [r.id, r.url.toLowerCase()]));

  const allowed = new Map<string, Set<string>>();
  const library: string[] = [];
  for (const idea of batch) {
    const set = new Set<string>();
    for (const id of idea.signalIds ?? []) { const u = urlById.get(id); if (u) set.add(u); }
    const own = (idea.scale as { source?: unknown } | null)?.source;
    if (typeof own === 'string') set.add(capField(own, SOURCE_MAX).toLowerCase());
    const vector = idea.embedding ?? vectors.get(idea.id);
    let lines = 'none found';
    if (vector) {
      const ctx = await ideationContext(db, vector, { alreadySoldMax: 0, lessonsMax: 0, pricingMax: 0, changingMax: 0, marketsMax: MARKETS_PER_IDEA });
      for (const m of ctx.markets) set.add(m.id.toLowerCase());
      if (ctx.markets.length) {
        lines = ctx.markets
          .map((m) => capField(`[${m.id}] ${capField(m.segment, 80)} (${capField(m.geography, 40)}): ${capField(m.keyFact, 140)} | ${capField(m.url, 80)}`, 300))
          .join('\n');
      }
    }
    allowed.set(idea.id, set);
    library.push(`For idea ${idea.id}:\n${lines}`);
  }
  const text = prompt.render({
    ideas: wrapUntrusted('ideas', ideasText(batch)),
    library: wrapUntrusted('library', library.join('\n\n')),
    count: String(batch.length),
  });
  return { text, allowed };
}

/**
 * Estimates the scale of ideas that have no estimate (a pass's generated ideas, or every idea behind a case moved off
 * `new`), 8 per call on the `review` stage. Valid estimates are stored with their computed result as each batch returns;
 * unknown ids, repeats and invalid numbers are skipped and counted. A soft budget stops after a batch once spend passes
 * twice the estimate. `dryRun` estimates the cost and makes no model call.
 */
export async function estimateScale(deps: EstimateDeps, target: EstimateTarget, opts: { dryRun?: boolean } = {}): Promise<EstimateResult> {
  const { db, router, log } = deps;
  const prompt = loadPrompt('scale-estimate');
  const model = router.modelFor('review');
  const todo = await selectTodo(db, target);
  if (todo.length > ESTIMATE_IDEAS_MAX) {
    todo.length = ESTIMATE_IDEAS_MAX;
    log(`More than ${ESTIMATE_IDEAS_MAX} ideas need an estimate; this run takes the first ${ESTIMATE_IDEAS_MAX}. Run it again for the rest.`);
  }
  const batches: Todo[][] = [];
  for (let i = 0; i < todo.length; i += ESTIMATE_BATCH_SIZE) batches.push(todo.slice(i, i + ESTIMATE_BATCH_SIZE));

  const inputTokens = batches.reduce((t, b) => t + Math.ceil(approxPrompt(prompt, b).length / CHARS_PER_TOKEN), 0);
  const estimatedUsd = todo.length === 0 ? 0 : costOf(model, { inputTokens, outputTokens: OUTPUT_TOKENS_PER_IDEA * todo.length, searchRequests: 0 });
  log(`${plural(todo.length, 'idea')} to estimate in ${plural(batches.length, 'call')} on ${model}, estimated $${estimatedUsd.toFixed(2)}.`);
  if (opts.dryRun || todo.length === 0) return { estimated: 0, skipped: 0, estimatedUsd, spentUsd: 0, stoppedForBudget: false };

  const spentBefore = await spendUsd(db);
  let spentUsd = 0;
  let stoppedForBudget = false;
  let estimated = 0;
  let skipped = 0;
  let invalid = 0;
  for (const [i, batch] of batches.entries()) {
    if (i > 0) {
      spentUsd = (await spendUsd(db)) - spentBefore;
      if (spentUsd > ESTIMATE_BUDGET_MULTIPLE * estimatedUsd) {
        log(`Stopped after call ${i} of ${batches.length}: spent $${spentUsd.toFixed(2)}, more than twice the estimate ($${estimatedUsd.toFixed(2)}). ${plural(estimated, 'idea')} estimated so far; run the command again to go on.`);
        stoppedForBudget = true;
        break;
      }
    }
    const { text, allowed } = await renderBatch(deps, prompt, batch);
    let entries: Entry[];
    try {
      const out = await router.structured('review', {
        prompt: text, schema: EstimateOutputSchema, schemaName: 'scale_estimates', maxTokens: ESTIMATE_MAX_TOKENS,
      }, { runId: null, promptVersion: prompt.version });
      entries = out.estimates;
    } catch (err) {
      if (!(err instanceof StructuredOutputError)) throw err;
      log(`Call ${i + 1} of ${batches.length}: the output stayed invalid, so its ${plural(batch.length, 'idea')} were skipped.`);
      skipped += batch.length;
      continue;
    }
    const byId = new Map(batch.map((b) => [b.id, b]));
    let stored = 0;
    for (const e of entries) {
      const idea = byId.get(e.ideaId);
      const estimate = idea ? buildEstimate(e, allowed.get(idea.id) ?? new Set()) : null;
      if (!idea || !estimate) { invalid += 1; continue; }
      byId.delete(e.ideaId); // a repeat of an id already taken is invalid
      const done = await db.update(ideas)
        .set({ scaleEstimate: estimate, scaleResult: computeScale(estimate, idea.priceHint as PriceHint | null) })
        .where(and(eq(ideas.id, idea.id), isNull(ideas.scaleEstimate)))
        .returning({ id: ideas.id });
      stored += done.length;
    }
    estimated += stored;
    skipped += batch.length - stored;
  }
  if (!stoppedForBudget) spentUsd = (await spendUsd(db)) - spentBefore;
  if (invalid > 0) log(`Dropped ${plural(invalid, 'invalid estimate')} (unknown or repeated ids, or numbers that are not plain digits).`);
  if (skipped > 0) log(`${plural(skipped, 'idea')} got no valid estimate; run the command again to retry them.`);
  return { estimated, skipped, estimatedUsd, spentUsd, stoppedForBudget };
}
