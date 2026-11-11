import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { ideaReviews, ideas, lenses, signals, sketches } from '../db/schema';
import { loadPrompt } from '../llm/prompts';
import { StructuredOutputError, type CallCtx } from '../llm/types';
import { capField, wrapUntrusted } from '../llm/untrusted';
import { errorMessage } from '../tools/scrub';
import { loadAlreadySold } from './already-sold';
import {
  AUDIENCES, BarriersSchema, BUSINESS_MODELS, computeScale, EDGE_KINDS, EdgeSchema, PriceHintSchema, ScaleEstimateSchema, ScaleSchema,
  ValueToUserSchema, type Barriers, type BusinessModel, type IdeaAudience, type ScaleEstimate,
} from './business-models';
import { meetsEvidenceRule } from './evidence';
import { asRecord, bareId, enumValue, topReasons } from './normalize';
import { buildSeedContext, byId, renderSignals, seededRandom, type Known } from './seed-context';
import { SKETCH_TEXT_MAX } from './engine/kinds';
import { usesEngineV2, type RunConfig, type StageDeps } from './types';

export { hasDemandEvidence } from './evidence';
export {
  AMBITION_LENS_IDS, MAX_LENSES_PER_RUN, MIN_AMBITION_LENSES, MIN_CONSUMER_LENSES, pickConsumerSegments, seededRandom, selectLenses,
} from './seed-context';

const VALUE_KINDS = ValueToUserSchema.shape.kind.options;

/** The run's generated ideas should be at least this share consumer (audience `consumer` or `both`)… */
export const MIN_CONSUMER_SHARE = 0.3;
/** …and use at least this many distinct business models (or as many as the run asks ideas for, if fewer). */
export const MIN_MODELS = 4;
/** The one re-ask round (mix gap and count top-up) asks for at most this many ideas. */
const REASK_MAX_IDEAS = 6;
/** Each ideate call asks for at most this many ideas: long v8 ideas in bigger calls hit the output cap and were lost. */
export const IDEAS_PER_CALL = 3;
/** Output limit for ideate calls (a cap, not a cost). */
const IDEATE_MAX_TOKENS = 16000;
const EPS = 1e-9;

/** `total` split into calls of at most `perCall`: splitCounts(7, 3) is [3, 3, 1]. */
export function splitCounts(total: number, perCall: number): number[] {
  const step = Math.max(1, Math.floor(perCall));
  const out: number[] = [];
  for (let left = Math.max(0, Math.floor(total)); left > 0; left -= step) out.push(Math.min(step, left));
  return out;
}

/** How an idea delivers value (stored on the idea; screen caps gate entrants per business model, not per mechanism). */
export const IDEA_MECHANISMS = [
  'monitoring', 'money_recovery', 'workflow_automation', 'data_product', 'integration', 'compliance', 'marketplace', 'other',
] as const;

const ideaFields = {
  title: z.string(),
  oneLiner: z.string(),
  buyer: z.string(),
  problem: z.string(),
  solution: z.string(),
  mechanism: z.enum(IDEA_MECHANISMS),
  buyerType: z.string(),
};
/** A cited library entry id. */
const LIBRARY_ID = z.string().uuid();
/** ideate.v8: who pays, the business model, the money story and the barriers to entry. */
const moneyFields = {
  audience: z.enum(AUDIENCES),
  businessModel: z.enum(BUSINESS_MODELS),
  revenueMechanics: z.string().min(1).max(400),
  valueToUser: ValueToUserSchema,
  priceHint: PriceHintSchema,
  barriers: BarriersSchema,
};
/**
 * Generated ideas also name the incumbents the model knows and the functional gap they leave (ideate.v7), so the gate
 * can judge that claimed gap. Both are model claims, not verified evidence.
 */
const lensIdeaSchema = z.object({
  ...ideaFields,
  knownIncumbents: z.array(z.string().max(120)).max(8),
  functionalGap: z.string().max(600),
  signalUrls: z.array(z.string()),
  ...moneyFields,
  libraryItemIds: z.array(LIBRARY_ID).max(10),
  // ideate.v12: required on generated ideas (an idea without it drops with a reason).
  edge: EdgeSchema,
  // ideate.v13: the free-text scale is optional (older ideas keep theirs); the scale estimate is required instead.
  scale: ScaleSchema.optional(),
  scaleEstimate: ScaleEstimateSchema,
});
type LensIdea = z.infer<typeof lensIdeaSchema>;

const clip = (v: unknown, max: number) => (typeof v === 'string' && v.length > max ? v.slice(0, max) : v);

/**
 * The number a model wrote as text: `"$1,200/yr"` → 1200, `"about 300"` → 300, `"2.5"` → 2.5. Only a leading number
 * (after an optional "about"-style word and currency) is read, and only when the text after it matches `restOk`.
 * Anything else is returned unchanged so it still fails validation and drops with a reason: no number (`"N/A"`), a
 * minus sign, a malformed or space-grouped number (`"1,2"`, `"2 000"`, `"1e5"`), a magnitude word (`"$15k"`,
 * `"2 million"`) or a remainder the field does not allow (a per-month amount where a yearly one is asked for).
 */
export function leadingNumber(v: unknown, restOk: RegExp): unknown {
  if (typeof v !== 'string') return v;
  // Model text can be steered by untrusted evidence: trim, refuse long strings and collapse spaces before the regex, whose
  // adjacent optional whitespace runs would otherwise backtrack polynomially on a long run of spaces.
  const s = v.trim().replace(/\s+/g, ' ');
  if (s.length > NUMBER_TEXT_MAX) return v;
  const m = /^(?:(?:about|around|approximately|approx\.?|roughly|~) ?)?(?:USD|CAD|EUR|GBP|AUD)? ?(?:US|CA|C|A)?[$€£]? ?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(.*)$/i.exec(s);
  if (!m) return v;
  const rest = m[3]!.trim();
  if (/^[\d.,]|^e\d/i.test(rest) || /^(?:k|m|mm|bn|b|thousand|million|billion)\b/i.test(rest) || !restOk.test(rest)) return v;
  const n = Number(m[1]!.replace(/,/g, '') + (m[2] ?? ''));
  return Number.isFinite(n) ? n : v;
}
/** Number text longer than this is left as it is (it is a sentence, not an amount). */
const NUMBER_TEXT_MAX = 64;
const CURRENCY = String.raw`(?:USD|CAD|EUR|GBP|AUD|[$€£])`;
/** After a yearly value: nothing, a currency, a year marker (`/yr`, `per year`, `a year`, `annually`, `yearly`). */
const YEARLY_REST = new RegExp(
  String.raw`^(?:${CURRENCY}\s*)?(?:\/\s*(?:yr|year|annum)|(?:per|a|an|each|every)\s+(?:year|annum)|annually|yearly)?\.?$`, 'i',
);
/** After a price amount: nothing or a currency (its period lives in `priceHint.unit`). */
const CURRENCY_REST = new RegExp(String.raw`^${CURRENCY}?\.?$`, 'i');
/** After a barrier score: anything that is not a number or magnitude (`"4/5"`, `"3 - moderate"`). */
const SCORE_REST = /^/;

/** After a population count: nothing or a period. */
const COUNT_REST = /^\.?$/;
/** After a share: nothing, a percent sign, or a period. */
const PCT_REST = /^%?\.?$/;
const MAGNITUDES: Record<string, number> = { thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, billion: 1e9, bn: 1e9 };

/**
 * A population count as the model wrote it (ideate.v13): plain number text as `leadingNumber` reads it, or a number
 * followed by one magnitude word (`"about 2 million"` → 2,000,000, `"40k"`, `"1.2bn"`), since a head count in millions
 * is unambiguous; the scale estimator reads its counts the same way. Money fields never take this path. Anything else
 * is returned unchanged and drops the idea with a reason.
 */
export function populationCount(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const s = v.trim().replace(/\s+/g, ' ');
  if (s.length > NUMBER_TEXT_MAX) return v;
  const m = /^(.*?\d) ?(thousand|million|billion|bn|k|m)\.?$/i.exec(s);
  if (!m) return leadingNumber(v, COUNT_REST);
  const n = leadingNumber(m[1], /^$/);
  return typeof n === 'number' ? Math.round(n * MAGNITUDES[m[2]!.toLowerCase()]!) : v;
}

/** Spellings of the scale estimate's buyer unit. */
const BUYER_UNITS: Record<string, ScaleEstimate['buyerUnit']> = {
  businesses: 'businesses', business: 'businesses', companies: 'businesses', company: 'businesses', firms: 'businesses', b2b: 'businesses',
  individuals: 'individuals', individual: 'individuals', consumers: 'individuals', consumer: 'individuals', people: 'individuals', persons: 'individuals',
};
/** A buyer unit as the model spelled it, mapped to a valid one; anything unrecognised is returned unchanged (and fails validation). */
export const buyerUnit = (v: unknown) => (typeof v === 'string' ? BUYER_UNITS[v.trim().toLowerCase()] ?? v : v);
/** Each step of the scale estimate: its key, its number field and how that number text is read. */
const ESTIMATE_STEPS: [string, string, (v: unknown) => unknown][] = [
  ['population', 'count', populationCount],
  ['shareWithProblem', 'pct', (v) => leadingNumber(v, PCT_REST)],
  ['shareWillingToPay', 'pct', (v) => leadingNumber(v, PCT_REST)],
  ['shareReachable', 'pct', (v) => leadingNumber(v, PCT_REST)],
];

/** A 1–5 barrier score: a number (or number text) rounded and clamped; anything else unchanged. */
function score(v: unknown): unknown {
  const n = leadingNumber(v, SCORE_REST);
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : n;
}

/**
 * Before validation, conservative repairs so an easy slip never drops a whole idea:
 * - over-long text is cut to its limit (v8 text fields, `functionalGap` 600, each incumbent 120, the first 8 incumbents);
 * - number text becomes a number for the value (bare, currency or a year marker only), the price (bare or currency
 *   only) and the barrier scores; scores are rounded and clamped to 1–5;
 * - enum values are trimmed, lower-cased and matched through a short synonym list; a mechanism that is not on the list
 *   (only a label; unknown, missing or not text) becomes `other`;
 * - cited library ids are unwrapped, filtered to well-formed uuids and capped at 10;
 * - edge and scale text (ideate.v12) is cut to its limits (claim 300, versus 200, whyNow 300; buyers 200, basis 300,
 *   source 300), and the edge kind goes through the same enum matching (`"New capability"` → `new_capability`);
 * - the scale estimate (ideate.v13): each basis and source is cut to 300 and a null source removed; shares read number
 *   text like the price (`"40%"` → 40); the population count also reads one magnitude word (`"2 million"`), which money
 *   fields never do; the buyer unit reads common spellings (`"business"` → `businesses`, `"consumers"` → `individuals`).
 * Still strict: an unknown business model, audience, value kind or edge kind is left as is and drops the idea (no relabelling).
 */
export function normalizeIdea(raw: unknown): unknown {
  const idea = asRecord(raw);
  if (!idea) return raw;
  const set = (o: Record<string, unknown>, key: string, f: (v: unknown) => unknown) => { if (key in o) o[key] = f(o[key]); };
  const cut = (o: Record<string, unknown>, key: string, max: number) => set(o, key, (v) => clip(v, max));
  cut(idea, 'revenueMechanics', 400);
  cut(idea, 'functionalGap', 600);
  if (Array.isArray(idea.knownIncumbents)) idea.knownIncumbents = idea.knownIncumbents.slice(0, 8).map((s) => clip(s, 120));
  set(idea, 'audience', (v) => enumValue(v, AUDIENCES));
  set(idea, 'businessModel', (v) => enumValue(v, BUSINESS_MODELS));
  // The mechanism is only a label: anything not on the list (unknown, missing, null, not text) becomes `other`.
  const mechanism = enumValue(idea.mechanism, IDEA_MECHANISMS);
  idea.mechanism = typeof mechanism === 'string' && (IDEA_MECHANISMS as readonly string[]).includes(mechanism) ? mechanism : 'other';
  const value = asRecord(idea.valueToUser);
  if (value) {
    cut(value, 'basis', 400); cut(value, 'source', 300);
    set(value, 'kind', (v) => enumValue(v, VALUE_KINDS));
    set(value, 'amountPerYear', (v) => leadingNumber(v, YEARLY_REST));
    idea.valueToUser = value;
  }
  const price = asRecord(idea.priceHint);
  if (price) {
    cut(price, 'unit', 60); cut(price, 'basis', 300); cut(price, 'source', 300);
    set(price, 'amount', (v) => leadingNumber(v, CURRENCY_REST));
    idea.priceHint = price;
  }
  const barriers = asRecord(idea.barriers);
  if (barriers) {
    cut(barriers, 'toStartWhy', 300); cut(barriers, 'toCopyWhy', 300);
    set(barriers, 'toStart', score); set(barriers, 'toCopy', score);
    // Only a preference: yes/true text reads as true; missing, null or anything else reads as false (the cautious answer).
    barriers.soloBuildable = soloFlag(barriers.soloBuildable);
    idea.barriers = barriers;
  }
  const edge = asRecord(idea.edge);
  if (edge) {
    cut(edge, 'claim', 300); cut(edge, 'versus', 200); cut(edge, 'whyNow', 300);
    set(edge, 'kind', (v) => enumValue(v, EDGE_KINDS));
    idea.edge = edge;
  }
  const scale = asRecord(idea.scale);
  if (scale) {
    cut(scale, 'buyers', 200); cut(scale, 'basis', 300); cut(scale, 'source', 300);
    idea.scale = scale;
  }
  const estimate = asRecord(idea.scaleEstimate);
  if (estimate) {
    set(estimate, 'buyerUnit', buyerUnit);
    for (const [key, field, read] of ESTIMATE_STEPS) {
      const step = asRecord(estimate[key]);
      if (!step) continue;
      cut(step, 'basis', 300); cut(step, 'source', 300);
      // A null source is read as no source (the basis is then labelled an assumption when stored).
      if (step.source === null) delete step.source;
      set(step, field, read);
      estimate[key] = step;
    }
    idea.scaleEstimate = estimate;
  }
  if (Array.isArray(idea.libraryItemIds)) {
    // One malformed id (a name, a url, a number) is dropped on its own instead of failing the whole idea.
    idea.libraryItemIds = idea.libraryItemIds
      .flatMap((id) => (typeof id === 'string' ? [bareId(id)] : []))
      .filter((id) => LIBRARY_ID.safeParse(id).success)
      .slice(0, 10);
  }
  return idea;
}

/** `soloBuildable` as a boolean: true, or text meaning yes; everything else is false. */
function soloFlag(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  return typeof v === 'string' && /^\s*(?:true|yes|y)\s*\.?\s*$/i.test(v);
}

/**
 * An idea that failed validation, with why: each issue as `path:code` (array indexes read as `*`), never the content.
 * A type mismatch also names the type the model sent (`(string)`, `(undefined)`), which is not content either.
 */
class DroppedIdea {
  constructor(readonly reasons: string[]) {}
}
const typeAt = (input: unknown, path: PropertyKey[]): string => {
  let v: unknown = input;
  for (const p of path) v = v && typeof v === 'object' ? (v as Record<PropertyKey, unknown>)[p] : undefined;
  return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
};
const reasonKey = (issue: { path: PropertyKey[]; code: string }, input?: unknown) =>
  `${issue.path.map((p) => (typeof p === 'number' ? '*' : String(p))).join('.') || '(idea)'}:${issue.code}` +
  (issue.code === 'invalid_type' && input !== undefined ? `(${typeAt(input, issue.path)})` : '');

/**
 * One invalid idea parses to a DroppedIdea (dropped, counted, reasons kept) instead of failing the whole call. The
 * marker travels in the parsed result, so it holds only the reasons of the answer that was used, with no shared state.
 * The JSON schema the model sees is the strict idea schema (the preprocess and the catch are transparent there; the
 * catch is called with no context while that schema is built).
 */
const lensIdeasSchema = z.object({
  ideas: z.array(z.preprocess(normalizeIdea, lensIdeaSchema).catch((ctx) =>
    (ctx ? new DroppedIdea([...new Set(ctx.error.issues.map((i) => reasonKey(i, normalizeIdea(ctx.input))))]) : undefined) as unknown as LensIdea)),
});
/** ideate.v15 (engine v2): a generated idea also names the label of the sketch it expands (`S1`, `S2`, …). */
const sketchIdeaSchema = lensIdeaSchema.extend({ sketch: z.string() });
type SketchIdea = z.infer<typeof sketchIdeaSchema>;
/** normalizeIdea, and a label written as a number (`1`) read as text. */
const normalizeSketchIdea = (raw: unknown): unknown => {
  const idea = normalizeIdea(raw);
  const r = asRecord(idea);
  if (r && typeof r.sketch === 'number') r.sketch = String(r.sketch);
  return idea;
};
const sketchIdeasSchema = z.object({
  ideas: z.array(z.preprocess(normalizeSketchIdea, sketchIdeaSchema).catch((ctx) =>
    (ctx ? new DroppedIdea([...new Set(ctx.error.issues.map((i) => reasonKey(i, normalizeSketchIdea(ctx.input))))]) : undefined) as unknown as SketchIdea)),
});
/** Drop reasons of a v15 idea whose label names no sketch of its call, or a sketch another idea of the call already expands. */
export const SKETCH_UNKNOWN_DROP = 'sketch:unknown';
export const SKETCH_DUPLICATE_DROP = 'sketch:duplicate';

/**
 * The 0-based index of the sketch a v15 label names, or null: the first number in the label (`S2`, `Sketch 2`, `[S2]`
 * and `2` all name the second sketch), when it is between 1 and `n`.
 */
export function sketchIndex(label: string, n: number): number | null {
  const m = /\d+/.exec(label.slice(0, 40));
  const i = m ? Number(m[0]) - 1 : -1;
  return Number.isInteger(i) && i >= 0 && i < n ? i : null;
}
/** Owner ideas never get invented incumbents or gaps (those columns stay null); the money fields are optional. */
const ownerIdeaSchema = z.object({
  ...ideaFields,
  audience: moneyFields.audience.optional(),
  businessModel: moneyFields.businessModel.optional(),
  revenueMechanics: moneyFields.revenueMechanics.optional(),
  valueToUser: moneyFields.valueToUser.optional(),
  priceHint: moneyFields.priceHint.optional(),
  barriers: moneyFields.barriers.optional(),
  edge: EdgeSchema.optional(),
  scale: ScaleSchema.optional(),
});

type IdeaInsert = typeof ideas.$inferInsert;
type LensRow = typeof lenses.$inferSelect;
type SketchRow = typeof sketches.$inferSelect;

/**
 * The <sketches> block of an ideate.v15 call: each sketch labelled S1, S2, … in call order, its text fields capped at
 * SKETCH_TEXT_MAX (one line each), its signals as the urls shown in <signals> (ids not shown are left out).
 */
function renderSketches(list: SketchRow[], urlOf: Map<string, string>): string {
  const cap = (s: string) => capField(s, SKETCH_TEXT_MAX);
  return list.map((s, i) => {
    const urls = s.signalIds.flatMap((id) => urlOf.get(id) ?? []);
    return [
      `- label: S${i + 1}`,
      `  title: ${cap(s.title)}`,
      `  buyer: ${cap(s.buyer)}`,
      `  problem: ${cap(s.problem)}`,
      `  how it earns: ${cap(s.howItEarns)}`,
      `  business model: ${cap(s.businessModel)}`,
      `  edge (${s.edgeKind}): ${cap(s.edge)}`,
      `  why not trivial: ${cap(s.whyNotTrivial)}`,
      `  earn or save: ${cap(s.earnOrSave)}`,
      `  signals: ${urls.length ? urls.join(' ') : '(none)'}`,
      `  library ids: ${s.libraryItemIds.length ? s.libraryItemIds.join(', ') : '(none)'}`,
    ].join('\n');
  }).join('\n');
}

/**
 * Idempotent per run (R20): in one transaction, drop any ideas an earlier attempt left for this run and insert
 * the new set. Safe because no later stage can have run while ideate is not done. Reviews of the dropped ideas go
 * with them (idea_reviews has no cascade), so a review never outlives its idea or lands on a different one.
 */
async function replaceRunIdeas(db: Db, runId: string, values: IdeaInsert[]): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.delete(ideaReviews).where(inArray(ideaReviews.ideaId, tx.select({ id: ideas.id }).from(ideas).where(eq(ideas.runId, runId))));
    await tx.delete(ideas).where(eq(ideas.runId, runId));
    if (values.length === 0) return [];
    const inserted = await tx.insert(ideas).values(values).returning({ id: ideas.id });
    return inserted.map((r) => r.id);
  });
}

/**
 * The lens for the one mix re-ask: a consumer lens the run already used; otherwise (never for lens seeds, which keep
 * exactly their lenses) a seeded active consumer lens from the pool; otherwise the run's first lens. Open and sector
 * runs always include the available consumer lenses, so the pool step is a fallback.
 */
export function pickReaskLens<L extends { id: string; active: boolean; audience: string }>(
  chosen: L[], all: L[], cfg: Pick<RunConfig, 'seedType' | 'lensIds'>, rng: () => number,
): L {
  const fromRun = chosen.find((l) => l.audience === 'consumer');
  if (fromRun) return fromRun;
  const pool = all.filter((l) => l.active && l.audience === 'consumer').sort(byId);
  if (!cfg.lensIds && pool.length) return pool[Math.floor(rng() * pool.length)]!;
  return chosen[0]!;
}

export type Mix = { consumerShare: number; models: number; short: { consumer: number; models: BusinessModel[] } };

/** Smallest number of extra consumer ideas that lifts `consumer` of `n` to MIN_CONSUMER_SHARE. */
const consumerNeeded = (consumer: number, n: number) =>
  Math.max(0, Math.ceil((MIN_CONSUMER_SHARE * n - consumer) / (1 - MIN_CONSUMER_SHARE) - EPS));

/**
 * The run's audience and model mix. `short.consumer`: consumer ideas still needed for MIN_CONSUMER_SHARE (if added);
 * `short.models`: the unused business models, listed only while fewer than `minModels` are used.
 */
export function checkMix(
  list: { audience?: IdeaAudience | null; businessModel?: BusinessModel | null }[],
  minModels: number = MIN_MODELS,
): Mix {
  const n = list.length;
  const consumer = list.filter((i) => i.audience === 'consumer' || i.audience === 'both').length;
  const used = new Set(list.map((i) => i.businessModel).filter((m): m is BusinessModel => !!m));
  return {
    consumerShare: n ? consumer / n : 0,
    models: used.size,
    short: {
      consumer: consumerNeeded(consumer, n),
      models: used.size < minModels ? BUSINESS_MODELS.filter((m) => !used.has(m)) : [],
    },
  };
}

const isShort = (m: Mix) => m.short.consumer > 0 || m.short.models.length > 0;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The "fill the gap" section of one call in the re-ask round: the ideas still missing from the count the run asked for
 * (`have` of `target`), the consumer ideas and the unused business models the mix still needs.
 */
function gapInstruction(
  count: number,
  g: { consumer: number; models: number; unused: BusinessModel[]; have: number; target: number },
): string {
  const { consumer, models, unused, have, target } = g;
  const lines = ['Fill the gap. This is one extra request after every lens ran: the ideas so far fall short of what this run needs.'];
  if (have < target) {
    lines.push(`- The run has ${have} of the ${target} ideas it asked for, so each new idea here counts toward the rest.`);
  }
  if (consumer > 0) {
    lines.push(`- At least ${consumer} of the ${count} ideas must be consumer ideas (audience \`consumer\` or \`both\`) that follow the named-buyer rule below. Draw on the consumer segments in <focus>.`);
  }
  if (models > 0) {
    lines.push(`- Use at least ${models} business models this run has not used yet, from: ${unused.map((m) => `\`${m}\``).join(', ')}.`);
  }
  lines.push('- Every other rule below still applies. Return fewer ideas rather than break a rule.');
  return lines.join('\n');
}

type Grounded = { basis: string; source?: string };

/** The id or url a cited source stands for, or null. A cut-off rendered url also matches a longer citation that starts with it. */
function resolveSource(raw: string | undefined, known: Known, prefixes: [string, string][]): string | null {
  if (!raw) return null;
  const s = bareId(raw);
  if (!s) return null;
  const hit = known.get(s);
  if (hit) return hit;
  return prefixes.find(([prefix]) => s.startsWith(prefix))?.[1] ?? null;
}

/**
 * A value or price keeps its source only when it is a library entry shown to this lens (by id or url; stored as the id)
 * or a signal url of the run; otherwise the source is dropped and the basis is labelled as an assumption (a value needs
 * a source or an assumption).
 */
function ground<T extends Grounded>(v: T, basisMax: number, known: Known, prefixes: [string, string][] = []): T {
  const src = resolveSource(v.source, known, prefixes);
  if (src) return { ...v, source: src };
  const { source: _drop, ...rest } = v;
  const basis = /^\s*assumption\b/i.test(rest.basis) ? rest.basis : `Assumption: ${rest.basis}`.slice(0, basisMax);
  return { ...rest, basis } as T;
}

/**
 * The scale estimate with each sourced step grounded like a value or price: a source is kept only when it was shown to
 * this call (a library entry or a run signal url); otherwise it is dropped and the basis becomes an assumption. The
 * reachable share never has a source and is kept as written.
 */
function groundEstimate(e: ScaleEstimate, known: Known, prefixes: [string, string][]): ScaleEstimate {
  return {
    ...e,
    population: ground(e.population, 300, known, prefixes),
    shareWithProblem: ground(e.shareWithProblem, 300, known, prefixes),
    shareWillingToPay: ground(e.shareWillingToPay, 300, known, prefixes),
  };
}

/**
 * Words that name a way to be hard to copy (ideate.v9). A sanity check, not a judgement of quality: forgiving about word
 * forms, and deliberately not matching generic praise such as "great UX", "first mover", "better product" or "brand".
 */
export const MOAT_KEYWORDS: readonly RegExp[] = [
  /\b(?:proprietary|usage|first[- ]party)\s+(?:\w+\s+)?(?:data|datasets?)\b/i,
  /\bdata\s+(?:that\s+)?(?:only\s+)?(?:usage|use)\s+produces\b/i,
  /\bnetwork[- ]effects?\b/i,
  /\bliquidity\b/i,
  /\btwo[- ]sided\b/i,
  /\bintegrat(?:e|es|ed|ing|ion|ions)\b/i,
  /\bswitching[- ]costs?\b/i,
  /\block(?:s|ed)?[- ]?in\b/i,
  /\blicen[cs]\w*/i,
  /\bcertif\w*/i,
  /\bdistribution\b/i,
  /\bcommunit(?:y|ies)\b/i,
  // Spec B5 (screen v5): a model, benchmark or store built from data. Allowlists, so generic praise next to these words
  // ("a proprietary delivery model", "accumulated track records", "the benchmark of reliability", "trained on public
  // data") never matches.
  // proprietary model: "proprietary [word] model(s) of|for|trained|built" (not a business-style model), or a
  // prediction-style model ("proprietary [word] risk|pricing|prediction|scoring|rate model").
  /\bproprietary\s+(?:(?!(?:business|revenue|pricing|operating|delivery|subscription|service|go-to-market|sales|engagement|franchise|membership|support)\b)[\w-]+\s+)?models?\s+(?:of|for|trained|built)\b/i,
  /\bproprietary\s+(?:[\w-]+\s+)?(?:risk|pricing|prediction|predictive|scoring|rate|forecasting)(?:-[\w-]+)?\s+models?\b/i,
  /\btrained\s+on\s+(?:our|its|their|customers?'?)\s+(?:own\s+)?(?:[\w-]+\s+){0,2}data(?:sets?)?\b/i,
  // accumulated: data, labelled examples, or records / history / examples of a data noun ("accumulated history" alone is not).
  /\baccumulat\w*\s+(?:(?:[\w-]+\s+)?data(?:sets?)?\b|labell?ed\s+[\w-]+|records\s+of\s+(?:usage|use|transactions|claims|jobs|payouts)\b|history\s+of\s+(?:usage|transactions|claims|jobs|payouts|outcomes)\b|examples\s+of\s+(?:[\w-]+\s+)?(?:data|claims|invoices|transactions|payouts|outcomes|jobs)\b)/i,
  // benchmark(s) of|from|across [number] [up to 2 words] <data noun>.
  /\bbenchmarks?\s+(?:of|from|across)\s+(?:\d[\d,.]*[km]?\+?\s+)?(?:[\w'-]+\s+){0,2}(?:payouts|prices|claims|outcomes|records|jobs|invoices|data|transactions|rates|results)\b/i,
  /\bworkflow\s+data\b/i,
];

/** A toCopy of 4 or 5 whose reason names no moat mechanism is stored as 3. */
export function checkToCopy(b: Barriers): { barriers: Barriers; lowered: boolean } {
  if (b.toCopy < 4 || MOAT_KEYWORDS.some((re) => re.test(b.toCopyWhy))) return { barriers: b, lowered: false };
  return { barriers: { ...b, toCopy: 3 }, lowered: true };
}

/** The drop reason for a generated idea that meets neither evidence route (counted in `dropReasons`). */
export const EVIDENCE_DROP = 'evidence:insufficient';

export type IdeateOutput = {
  ideaIds: string[];
  /** Generated ideas that failed the schema or the evidence rule and were not stored. */
  dropped: number;
  /** Why ideas were dropped: `path:code` (for example `functionalGap:too_big`) to the number of ideas. Never content. */
  dropReasons: Record<string, number>;
  /** Ideas asked for across all calls, the re-ask round included. */
  requested: number;
  /** Ideas the model gave back, before validation and before extras were cut to the count asked for. */
  returned: number;
  /** Model responses cut off at the output limit (the router's re-asks included). */
  truncatedCalls: number;
  /** Calls that gave no valid answer even after the router's re-asks; each contributed 0 ideas. */
  failedCalls: number;
  /** Ideas whose toCopy of 4 or 5 named no mechanism and was stored as 3. */
  toCopyLowered: number;
  /** The run's mix after the optional re-ask; null for owner ideas. */
  mix: (Mix & { reask: boolean }) | null;
};

export async function ideate(
  { db, router, log }: StageDeps,
  run: { id: string; config: RunConfig },
  input: { signalIds: string[]; sketchIds?: unknown } & Record<string, unknown>,
): Promise<IdeateOutput> {
  const cfg = run.config;
  let truncatedCalls = 0;
  const callCtx = (promptVersion: string): CallCtx => ({
    runId: run.id, promptVersion, onTruncated: () => { truncatedCalls++; },
  });

  if (cfg.seedType === 'idea') {
    const ideaText = cfg.ideaText?.trim();
    if (!ideaText) throw new Error('ideaText is required for idea seeds');
    const prompt = loadPrompt('owner-idea');
    const out = await router.structured(
      'ideate',
      {
        prompt: prompt.render({ idea: wrapUntrusted('idea', ideaText) }), schema: ownerIdeaSchema, schemaName: 'owner_idea',
        maxTokens: IDEATE_MAX_TOKENS,
      },
      callCtx(prompt.version),
    );
    const { audience, businessModel, revenueMechanics, valueToUser, priceHint, barriers, edge, scale, ...fields } = out;
    let toCopyLowered = 0;
    let ownerBarriers: Barriers | null = barriers ?? null;
    if (ownerBarriers) {
      const checked = checkToCopy(ownerBarriers);
      ownerBarriers = checked.barriers;
      if (checked.lowered) toCopyLowered++;
    }
    // Owner ideas cite nothing we can check: any money claim is kept as a stated assumption.
    const none: Known = new Map();
    const ideaIds = await replaceRunIdeas(db, run.id, [{
      runId: run.id, lensId: null, origin: 'owner', ...fields, functionalGap: null, knownIncumbents: null,
      audience: audience ?? null, businessModel: businessModel ?? null, revenueMechanics: revenueMechanics ?? null,
      valueToUser: valueToUser ? ground(valueToUser, 400, none) : null,
      priceHint: priceHint ? ground(priceHint, 300, none) : null,
      barriers: ownerBarriers, libraryItemIds: null,
      edge: edge ?? null, scale: scale ? ground(scale, 300, none) : null,
      signalIds: input.signalIds, status: 'candidate',
    }]);
    log('ideate: 1 owner idea');
    return { ideaIds, dropped: 0, dropReasons: {}, requested: 1, returned: 1, truncatedCalls, failedCalls: 0, toCopyLowered, mix: null };
  }

  // Engine v2 (spec §10): the input is the evolve output (Ruling R1), whose final sketches are expanded with ideate.v15.
  // A v2 run without sketch ids (a stage output from before engine v2) and every v1 run generate with ideate.v14.
  const sketchIds = usesEngineV2(cfg) && Array.isArray(input.sketchIds)
    ? [...new Set(input.sketchIds.filter((x): x is string => typeof x === 'string'))]
    : null;
  if (usesEngineV2(cfg) && !sketchIds) log('ideate: an engine v2 run with no sketch ids; generating ideas with ideate.v14');
  const sketchRows = sketchIds?.length ? await db.select().from(sketches).where(inArray(sketches.id, sketchIds)) : [];
  const sketchById = new Map(sketchRows.map((s) => [s.id, s]));
  const finalSketches = (sketchIds ?? []).map((id) => {
    const s = sketchById.get(id);
    if (!s) throw new Error(`ideate: unknown sketch ${id}`);
    return s;
  });

  const { market, allLenses, chosen, passed: harvested, withSegmentsSeed, focusFor, libraryFor } = await buildSeedContext(
    { db, router, log }, run, input.signalIds, 'ideate',
  );
  // A sketch may cite a harvest signal past the first MAX_SIGNALS (an evolve variant): it is shown too, so it can be cited.
  const shownIds = new Set(harvested.map((s) => s.id));
  const missingIds = [...new Set(finalSketches.flatMap((s) => s.signalIds))].filter((id) => !shownIds.has(id));
  const extra = missingIds.length ? await db.select().from(signals).where(inArray(signals.id, missingIds)) : [];
  const passed = [...harvested, ...extra];
  const signalsText = renderSignals(passed);
  const signalUrls = new Set(passed.map((s) => s.url));
  const urlOf = new Map(passed.map((s) => [s.id, s.url]));

  // What competitors already sell (gate kills on `generic`) and what already has a case, so ideation steers away.
  const { sold, covered } = await loadAlreadySold(db);
  const asList = (items: string[]) => (items.length ? items.map((s) => `- ${s}`).join('\n') : '(none yet)');
  const gateKilled = wrapUntrusted('gate-killed', asList(sold));
  const alreadyCovered = wrapUntrusted('already-covered', asList(covered));
  const prompt = loadPrompt('ideate', sketchIds ? 15 : 14);
  const pending: IdeaInsert[] = [];
  let dropped = 0;
  let requested = 0;
  let returned = 0;
  let failedCalls = 0;
  let toCopyLowered = 0;
  const dropReasons: Record<string, number> = {};

  /**
   * One ideate call for at most IDEAS_PER_CALL ideas: invented with ideate.v14, or, with `o.sketches`, one per given
   * sketch with ideate.v15 (`count` is then the number of sketches). A call the router gives up on (StructuredOutputError,
   * after its re-asks; for example every answer cut off) contributes 0 ideas and the run goes on; any other error
   * (network, budget) propagates as before.
   */
  const generate = async (
    lens: LensRow, count: number, o: { withSegments: boolean; gap: string; sketches?: SketchRow[] },
  ): Promise<IdeaInsert[]> => {
    const library = await libraryFor(lens);
    requested += count;
    const shared = {
      market: `${market.name} (${market.countries.join(', ')})`,
      lensName: lens.name,
      lensPattern: lens.pattern,
      lensHint: lens.promptHint,
      focus: wrapUntrusted('focus', focusFor(o.withSegments)),
      signals: wrapUntrusted('signals', signalsText),
      alreadySold: wrapUntrusted('already-sold', library.alreadySold),
      lessons: wrapUntrusted('lessons', library.lessons),
      pricing: wrapUntrusted('pricing', library.pricing),
      changing: wrapUntrusted('changing', library.changing),
      markets: wrapUntrusted('markets', library.markets),
      seenInTheWild: wrapUntrusted('seen-in-the-wild', library.seenInTheWild),
      gateKilled,
      alreadyCovered,
      count: String(count),
      minSignals: String(cfg.minSignals),
    };
    // Titles from earlier calls in this run (earlier lenses and this lens's earlier calls), so each call steers away
    // from buyers/problems already covered. Each shows its audience and business model, so later calls can vary the mix.
    const priorTitles = () => pending.map((v) => `- ${capField(v.title, 200)} (${v.audience}, ${v.businessModel})`).join('\n');
    let out: { ideas: (LensIdea | SketchIdea)[] };
    try {
      out = o.sketches
        ? await router.structured(
          'ideate',
          {
            prompt: prompt.render({ ...shared, sketches: wrapUntrusted('sketches', renderSketches(o.sketches, urlOf)) }),
            schema: sketchIdeasSchema,
            schemaName: 'ideate_ideas',
            maxTokens: IDEATE_MAX_TOKENS,
          },
          callCtx(prompt.version),
        )
        : await router.structured(
          'ideate',
          {
            prompt: prompt.render({ ...shared, priorIdeas: wrapUntrusted('prior-ideas', priorTitles() || '(none yet)'), gap: o.gap }),
            schema: lensIdeasSchema,
            schemaName: 'ideate_ideas',
            maxTokens: IDEATE_MAX_TOKENS,
          },
          callCtx(prompt.version),
        );
    } catch (err) {
      if (!(err instanceof StructuredOutputError)) throw err;
      failedCalls++;
      // The message only; the issues can quote the model's answer.
      log(`ideate: a call for lens ${lens.id} gave no valid answer (${errorMessage(err)}), 0 ideas from it`);
      return [];
    }
    const items = out.ideas as unknown[];
    // `returned` counts every item the model sent; drops are counted only among the first `count`, since items past
    // the requested count are ignored (neither kept nor counted as drops).
    returned += items.length;
    const drop = (reason: string) => {
      dropped++;
      dropReasons[reason] = (dropReasons[reason] ?? 0) + 1;
    };
    const valid: { idea: LensIdea; sketch: SketchRow | null }[] = [];
    const claimed = new Set<number>();
    for (const item of items.slice(0, count)) {
      if (item instanceof DroppedIdea) {
        dropped++;
        for (const r of item.reasons) dropReasons[r] = (dropReasons[r] ?? 0) + 1;
      } else if (item && o.sketches) {
        // ideate.v15: each idea expands one sketch of this call, named by its label; any other label drops the idea.
        const { sketch: label, ...idea } = item as SketchIdea;
        const i = sketchIndex(label, o.sketches.length);
        if (i === null) drop(SKETCH_UNKNOWN_DROP);
        else if (claimed.has(i)) drop(SKETCH_DUPLICATE_DROP);
        else {
          claimed.add(i);
          valid.push({ idea, sketch: o.sketches[i]! });
        }
      } else if (item) {
        valid.push({ idea: item as LensIdea, sketch: null });
      }
    }
    const known: Known = new Map(library.sources);
    for (const url of signalUrls) if (!known.has(url.toLowerCase())) known.set(url.toLowerCase(), url);
    // The evidence rule (ideate.v12), counted against what this call was shown: minSignals independent operator or
    // neutral complaint (pain) sites, or 1 such complaint plus a demand source (a shown trend, market, rule_change or
    // pricing entry, or an opportunity signal from another site than the complaint). An idea meeting neither is
    // dropped as `evidence:insufficient`.
    const evidenced = valid.filter(({ idea }) => {
      const cited = new Set(idea.signalUrls);
      if (meetsEvidenceRule(idea, library.kinds, passed.filter((s) => cited.has(s.url)), cfg.minSignals)) return true;
      drop(EVIDENCE_DROP);
      return false;
    });
    return evidenced.map(({ idea, sketch }) => {
      const { signalUrls: urls, libraryItemIds, valueToUser, priceHint, barriers, scale, scaleEstimate, ...f } = idea;
      const cited = new Set(urls);
      const checked = checkToCopy(barriers);
      if (checked.lowered) toCopyLowered++;
      const price = ground(priceHint, 300, known, library.prefixes);
      // Sources are grounded before the result is computed, so a share whose source was not shown is capped.
      const estimate = groundEstimate(scaleEstimate, known, library.prefixes);
      // Only library entries this lens was shown (or its sketch already cited); invented ids are not stored.
      const citable = (id: string) => library.ids.has(id) || !!sketch?.libraryItemIds.includes(id);
      return {
        runId: run.id,
        lensId: lens.id,
        origin: 'generated' as const,
        ...f,
        barriers: checked.barriers,
        valueToUser: ground(valueToUser, 400, known, library.prefixes),
        priceHint: price,
        scale: scale ? ground(scale, 300, known, library.prefixes) : null,
        scaleEstimate: estimate,
        scaleResult: computeScale(estimate, price, f.businessModel),
        libraryItemIds: [...new Set(libraryItemIds.filter(citable))],
        signalIds: passed.filter((s) => cited.has(s.url)).map((s) => s.id),
        // Engine v2: the sketch it expands and that sketch's final tournament Elo (screen adds it as a band).
        ...(sketch ? { sketchId: sketch.id, elo: sketch.elo } : {}),
        status: 'candidate' as const,
      };
    });
  };

  if (sketchIds) {
    // Engine v2: the final sketches, grouped by their lens (for its library context) in rank order, IDEAS_PER_CALL per
    // call. Expansion never invents ideas, so there is no mix re-ask; the mix is still reported.
    const lensById = new Map(allLenses.map((l) => [l.id, l]));
    const groups = new Map<string, { lens: LensRow; list: SketchRow[] }>();
    for (const s of finalSketches) {
      const lens = (s.lensId && lensById.get(s.lensId)) || chosen[0]!;
      const g = groups.get(lens.id) ?? { lens, list: [] };
      g.list.push(s);
      groups.set(lens.id, g);
    }
    for (const { lens, list } of groups.values()) {
      for (let i = 0; i < list.length; i += IDEAS_PER_CALL) {
        const batch = list.slice(i, i + IDEAS_PER_CALL);
        pending.push(...await generate(lens, batch.length, { withSegments: withSegmentsSeed, gap: '', sketches: batch }));
      }
    }
    const mix = checkMix(pending, Math.min(MIN_MODELS, finalSketches.length));
    const ideaIds = await replaceRunIdeas(db, run.id, pending);
    if (dropped > 0) log(`ideate: dropped ${dropped} invalid (top reasons: ${topReasons(dropReasons)})`);
    log(`ideate: asked for ${requested} ideas, got ${returned} back (cut off: ${truncatedCalls}, failed calls: ${failedCalls})`);
    if (toCopyLowered > 0) log(`ideate: ${toCopyLowered} toCopy score(s) lowered to 3 (no moat mechanism named)`);
    log(`ideate: ${ideaIds.length} ideas from ${finalSketches.length} sketches (ideate.v15)`);
    return { ideaIds, dropped, dropReasons, requested, returned, truncatedCalls, failedCalls, toCopyLowered, mix: { ...mix, reask: false } };
  }

  // Each lens asks for its share in calls of at most IDEAS_PER_CALL, in lens order (R20: same run id, same calls).
  const count = Math.ceil(cfg.ideaCount / chosen.length);
  for (const lens of chosen) {
    for (const n of splitCounts(count, IDEAS_PER_CALL)) {
      pending.push(...await generate(lens, n, { withSegments: withSegmentsSeed, gap: '' }));
    }
  }

  // At most one re-ask round per run, never a loop: it fills the mix gap and tops up a short count, together asking
  // for at most REASK_MAX_IDEAS ideas in calls of at most IDEAS_PER_CALL.
  const minModels = Math.min(MIN_MODELS, cfg.ideaCount);
  const before = checkMix(pending, minModels);
  const missing = Math.max(0, cfg.ideaCount - pending.length);
  const reask = isShort(before) || missing > 0;
  if (reask) {
    const mixIdeas = isShort(before) ? Math.max(before.short.consumer, minModels - before.models, 1) : 0;
    const k = Math.min(REASK_MAX_IDEAS, Math.max(mixIdeas, missing));
    // A mix gap uses the consumer re-ask lens with consumer segments; a count-only top-up rotates the run's own lenses
    // (call i uses chosen[i % chosen.length]), with segments only for open seeds, like the lens calls.
    const mixShort = isShort(before);
    const reaskLens = mixShort ? pickReaskLens(chosen, allLenses, cfg, seededRandom(`${run.id}:reask`)) : null;
    let left = k;
    let callNo = 0;
    try {
      for (const n of splitCounts(k, IDEAS_PER_CALL)) {
        const lens = reaskLens ?? chosen[callNo % chosen.length]!;
        callNo++;
        // Each call states what is still missing once the earlier calls' ideas are in: consumer ideas so the share
        // reaches MIN_CONSUMER_SHARE once the round's remaining ideas are added, then unused business models.
        const now = checkMix(pending, minModels);
        const consumerNow = pending.filter((i) => i.audience === 'consumer' || i.audience === 'both').length;
        const needConsumer = Math.min(n, Math.max(0, Math.ceil(MIN_CONSUMER_SHARE * (pending.length + left) - consumerNow - EPS)));
        const needModels = Math.min(n, Math.max(0, minModels - now.models));
        const gap = gapInstruction(n, {
          consumer: needConsumer, models: needModels, unused: now.short.models, have: pending.length, target: cfg.ideaCount,
        });
        left -= n;
        pending.push(...await generate(lens, n, { withSegments: mixShort || withSegmentsSeed, gap }));
      }
    } catch (err) {
      log(`ideate: re-ask failed (${errorMessage(err)}), keeping the ideas so far`);
    }
  }
  const after = checkMix(pending, minModels);

  // Written only after every lens call succeeded, so a failed (and resumed) ideate leaves no partial set.
  const ideaIds = await replaceRunIdeas(db, run.id, pending);
  if (dropped > 0) log(`ideate: dropped ${dropped} invalid (top reasons: ${topReasons(dropReasons)})`);
  log(`ideate: asked for ${requested} ideas, got ${returned} back (cut off: ${truncatedCalls}, failed calls: ${failedCalls})`);
  if (toCopyLowered > 0) log(`ideate: ${toCopyLowered} toCopy score(s) lowered to 3 (no moat mechanism named)`);
  const stillShort = isShort(after)
    ? [
        after.short.consumer > 0 ? `${after.short.consumer} consumer` : '',
        after.short.models.length ? plural(minModels - after.models, 'model') : '',
      ].filter(Boolean).join(', ')
    : 'no';
  log(`ideate: mix consumer ${Math.round(after.consumerShare * 100)}% models ${after.models} (re-ask: ${reask ? 'yes' : 'no'}, still short: ${stillShort})`);
  log(`ideate: ${ideaIds.length} ideas from ${chosen.length} lenses`);
  return { ideaIds, dropped, dropReasons, requested, returned, truncatedCalls, failedCalls, toCopyLowered, mix: { ...after, reask } };
}
