import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { ideas, lenses, markets, signals } from '../db/schema';
import { CONSUMER_SEGMENTS } from '../db/seed';
import { ideationContext, renderIdeationContext } from '../library/context';
import { loadPrompt } from '../llm/prompts';
import { StructuredOutputError, type CallCtx } from '../llm/types';
import { capField, wrapUntrusted } from '../llm/untrusted';
import { errorMessage } from '../tools/scrub';
import { loadAlreadySold } from './already-sold';
import {
  AUDIENCES, BarriersSchema, BUSINESS_MODELS, PriceHintSchema, ValueToUserSchema, type Barriers, type BusinessModel, type IdeaAudience,
} from './business-models';
import type { RunConfig, StageDeps } from './types';

const MAX_SIGNALS = 40;
const VALUE_KINDS = ValueToUserSchema.shape.kind.options;

/** Open and sector seeds sample at most this many lenses per run (lens seeds use exactly their lenses). */
export const MAX_LENSES_PER_RUN = 6;
/** Of the sampled lenses, at least this many are consumer lenses when that many are active. */
export const MIN_CONSUMER_LENSES = 2;
/** The run's generated ideas should be at least this share consumer (audience `consumer` or `both`)… */
export const MIN_CONSUMER_SHARE = 0.3;
/** …and use at least this many distinct business models (or as many as the run asks ideas for, if fewer). */
export const MIN_MODELS = 4;
/** Consumer segments an open seed (and the mix re-ask) shows next to the business sectors. */
const SEGMENTS_PER_RUN = 5;
const MAX_FOCUS_SECTORS = 8;
/** Library context per lens: startups already selling, dead startups, pricing entries. */
const LIBRARY_LIMITS = { alreadySoldMax: 15, lessonsMax: 8, pricingMax: 15 } as const;
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
});
type LensIdea = z.infer<typeof lensIdeaSchema>;
/** Plain object copy, or null. */
const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : null;
/** A library id as cited: trimmed, surrounding square brackets removed, lower case. */
const bareId = (s: string) => s.trim().replace(/^\[\s*(.*?)\s*\]$/, '$1').toLowerCase();

const clip = (v: unknown, max: number) => (typeof v === 'string' && v.length > max ? v.slice(0, max) : v);

/**
 * The number a model wrote as text: `"$1,200/yr"` → 1200, `"about 300"` → 300, `"2.5"` → 2.5. Only a leading number
 * (after an optional "about"-style word and currency) is read, and only when the text after it matches `restOk`.
 * Anything else is returned unchanged so it still fails validation and drops with a reason: no number (`"N/A"`), a
 * minus sign, a malformed or space-grouped number (`"1,2"`, `"2 000"`, `"1e5"`), a magnitude word (`"$15k"`,
 * `"2 million"`) or a remainder the field does not allow (a per-month amount where a yearly one is asked for).
 */
function leadingNumber(v: unknown, restOk: RegExp): unknown {
  if (typeof v !== 'string') return v;
  const m = /^\s*(?:(?:about|around|approximately|approx\.?|roughly|~)\s*)?(?:USD|CAD|EUR|GBP|AUD)?\s*(?:US|CA|C|A)?[$€£]?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(.*)$/i.exec(v);
  if (!m) return v;
  const rest = m[3]!.trim();
  if (/^[\d.,]|^e\d/i.test(rest) || /^(?:k|m|mm|bn|b|thousand|million|billion)\b/i.test(rest) || !restOk.test(rest)) return v;
  const n = Number(m[1]!.replace(/,/g, '') + (m[2] ?? ''));
  return Number.isFinite(n) ? n : v;
}
const CURRENCY = String.raw`(?:USD|CAD|EUR|GBP|AUD|[$€£])`;
/** After a yearly value: nothing, a currency, a year marker (`/yr`, `per year`, `a year`, `annually`, `yearly`). */
const YEARLY_REST = new RegExp(
  String.raw`^(?:${CURRENCY}\s*)?(?:\/\s*(?:yr|year|annum)|(?:per|a|an|each|every)\s+(?:year|annum)|annually|yearly)?\.?$`, 'i',
);
/** After a price amount: nothing or a currency (its period lives in `priceHint.unit`). */
const CURRENCY_REST = new RegExp(String.raw`^${CURRENCY}?\.?$`, 'i');
/** After a barrier score: anything that is not a number or magnitude (`"4/5"`, `"3 - moderate"`). */
const SCORE_REST = /^/;

/** A 1–5 barrier score: a number (or number text) rounded and clamped; anything else unchanged. */
function score(v: unknown): unknown {
  const n = leadingNumber(v, SCORE_REST);
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : n;
}

/** Spellings the model uses for an allowed enum value (spec §2); only applied when the target is allowed for the field. */
const ENUM_SYNONYMS: Record<string, string> = {
  one_time: 'one_off', 'one-time': 'one_off', 'one time': 'one_off',
  'service plus software': 'service_plus_software', 'service+software': 'service_plus_software', 'service + software': 'service_plus_software',
  consumers: 'consumer', individual: 'consumer',
  businesses: 'business', b2b: 'business',
};

/**
 * An enum value trimmed and lower-cased, matched as is, through the synonym list, or with spaces and hyphens read as
 * underscores (`"One-off"`, `"Transaction fee"`). An unknown value is returned unchanged, so a strict field still fails.
 */
function enumValue(v: unknown, allowed: readonly string[]): unknown {
  if (typeof v !== 'string') return v;
  const s = v.trim().toLowerCase();
  const hit = [s, ENUM_SYNONYMS[s], s.replace(/[\s-]+/g, '_')].find((c) => c !== undefined && allowed.includes(c));
  return hit ?? v;
}

/**
 * Before validation, conservative repairs so an easy slip never drops a whole idea:
 * - over-long text is cut to its limit (v8 text fields, `functionalGap` 600, each incumbent 120, the first 8 incumbents);
 * - number text becomes a number for the value (bare, currency or a year marker only), the price (bare or currency
 *   only) and the barrier scores; scores are rounded and clamped to 1–5;
 * - enum values are trimmed, lower-cased and matched through a short synonym list; a mechanism that is not on the list
 *   (only a label; unknown, missing or not text) becomes `other`;
 * - cited library ids are unwrapped, filtered to well-formed uuids and capped at 10.
 * Still strict: an unknown business model, audience or value kind is left as is and drops the idea (no relabelling).
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
    idea.barriers = barriers;
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

/** An idea that failed validation, with why: each issue as `path:code` (array indexes read as `*`), never the content. */
class DroppedIdea {
  constructor(readonly reasons: string[]) {}
}
const reasonKey = (issue: { path: PropertyKey[]; code: string }) =>
  `${issue.path.map((p) => (typeof p === 'number' ? '*' : String(p))).join('.') || '(idea)'}:${issue.code}`;

/**
 * One invalid idea parses to a DroppedIdea (dropped, counted, reasons kept) instead of failing the whole call. The
 * marker travels in the parsed result, so it holds only the reasons of the answer that was used, with no shared state.
 * The JSON schema the model sees is the strict idea schema (the preprocess and the catch are transparent there; the
 * catch is called with no context while that schema is built).
 */
const lensIdeasSchema = z.object({
  ideas: z.array(z.preprocess(normalizeIdea, lensIdeaSchema).catch((ctx) =>
    (ctx ? new DroppedIdea([...new Set(ctx.error.issues.map(reasonKey))]) : undefined) as unknown as LensIdea)),
});
/** Owner ideas never get invented incumbents or gaps (those columns stay null); the money fields are optional. */
const ownerIdeaSchema = z.object({
  ...ideaFields,
  audience: moneyFields.audience.optional(),
  businessModel: moneyFields.businessModel.optional(),
  revenueMechanics: moneyFields.revenueMechanics.optional(),
  valueToUser: moneyFields.valueToUser.optional(),
  priceHint: moneyFields.priceHint.optional(),
  barriers: moneyFields.barriers.optional(),
});

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

type IdeaInsert = typeof ideas.$inferInsert;
type LensRow = typeof lenses.$inferSelect;

/**
 * Idempotent per run (R20): in one transaction, drop any ideas an earlier attempt left for this run and insert
 * the new set. Safe because no later stage can have run while ideate is not done.
 */
async function replaceRunIdeas(db: Db, runId: string, values: IdeaInsert[]): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.delete(ideas).where(eq(ideas.runId, runId));
    if (values.length === 0) return [];
    const inserted = await tx.insert(ideas).values(values).returning({ id: ideas.id });
    return inserted.map((r) => r.id);
  });
}

/** Deterministic PRNG (FNV-1a hash of the seed, then mulberry32): seeded by the run id, re-runs pick the same (R20). */
export function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(arr: readonly T[], random: () => number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

const byId = <L extends { id: string }>(a: L, b: L) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The lenses a run uses. Lens seeds (any config with `lensIds`): exactly those active lenses, in the order given.
 * Otherwise at most MAX_LENSES_PER_RUN active lenses: MIN_CONSUMER_LENSES consumer lenses when available, the rest from
 * business and `any` lenses (topped up with more consumer lenses if those run out). Sorted by id before the seeded
 * shuffle, so the choice depends only on `rng`, not on database row order.
 */
export function selectLenses<L extends { id: string; active: boolean; audience: string }>(
  all: L[], cfg: Pick<RunConfig, 'seedType' | 'lensIds'>, rng: () => number,
): L[] {
  const active = all.filter((l) => l.active).sort(byId);
  if (cfg.lensIds) {
    const found = new Map(active.map((l) => [l.id, l]));
    return [...new Set(cfg.lensIds)].map((id) => found.get(id)).filter((l): l is L => !!l);
  }
  const consumer = shuffled(active.filter((l) => l.audience === 'consumer'), rng);
  const rest = shuffled(active.filter((l) => l.audience !== 'consumer'), rng);
  const nConsumer = Math.min(MIN_CONSUMER_LENSES, consumer.length, MAX_LENSES_PER_RUN);
  const picked = [...consumer.slice(0, nConsumer), ...rest.slice(0, MAX_LENSES_PER_RUN - nConsumer)];
  picked.push(...consumer.slice(nConsumer, nConsumer + MAX_LENSES_PER_RUN - picked.length));
  return shuffled(picked, rng);
}

/** The run's consumer segments (seeded by run id): ideate shows them and harvest queries the library with them. */
export function pickConsumerSegments(runId: string): string[] {
  return shuffled(CONSUMER_SEGMENTS, seededRandom(`${runId}:segments`)).slice(0, SEGMENTS_PER_RUN);
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
/** Citable sources, keyed lower case: a shown library entry's id, url and url as rendered (to the id); a signal url (to itself). */
type Known = Map<string, string>;
const RENDERED_URL_MAX = 80; // renderIdeationContext caps each url at 80 characters

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

type LibraryBlocks = {
  alreadySold: string; lessons: string; pricing: string;
  ids: Set<string>;
  /** Lower-cased id, url and rendered url of each shown entry, to its id. */
  sources: Known;
  /** Rendered urls that were cut off (lower case), to the entry id. */
  prefixes: [string, string][];
};
const EMPTY_LIBRARY = renderIdeationContext({ alreadySold: [], lessons: [], pricing: [] });

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
];

/** A toCopy of 4 or 5 whose reason names no moat mechanism is stored as 3. */
export function checkToCopy(b: Barriers): { barriers: Barriers; lowered: boolean } {
  if (b.toCopy < 4 || MOAT_KEYWORDS.some((re) => re.test(b.toCopyWhy))) return { barriers: b, lowered: false };
  return { barriers: { ...b, toCopy: 3 }, lowered: true };
}

export type IdeateOutput = {
  ideaIds: string[];
  /** Generated ideas that failed the schema and were not stored. */
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

/** `a ×2, b ×1`: the most frequent drop reasons first (ties by name), at most `max`. */
function topReasons(reasons: Record<string, number>, max = 3): string {
  return Object.entries(reasons)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, max)
    .map(([k, n]) => `${k} ×${n}`)
    .join(', ');
}

export async function ideate(
  { db, router, log }: StageDeps,
  run: { id: string; config: RunConfig },
  input: { signalIds: string[] },
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
    const { audience, businessModel, revenueMechanics, valueToUser, priceHint, barriers, ...fields } = out;
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
      signalIds: input.signalIds, status: 'candidate',
    }]);
    log('ideate: 1 owner idea');
    return { ideaIds, dropped: 0, dropReasons: {}, requested: 1, returned: 1, truncatedCalls, failedCalls: 0, toCopyLowered, mix: null };
  }

  const [market] = await db.select().from(markets).where(eq(markets.id, cfg.marketId));
  if (!market) throw new Error(`Unknown market: ${cfg.marketId}`);

  const allLenses = await db.select().from(lenses);
  const chosen = selectLenses(allLenses, cfg, seededRandom(`${run.id}:lenses`));
  if (chosen.length === 0) {
    throw new Error(`No active lenses found${cfg.lensIds ? ` for lens ids: ${cfg.lensIds.join(', ')}` : ''}`);
  }

  const used = input.signalIds.slice(0, MAX_SIGNALS);
  const rows = used.length ? await db.select().from(signals).where(inArray(signals.id, used)) : [];
  const signalById = new Map(rows.map((r) => [r.id, r]));
  const passed = used.map((id) => signalById.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
  // Each signal carries who wrote it; untagged (pre-tuning-4) rows show as `untagged`, which never counts as evidence.
  const signalsText = passed.map((s) => `- url: ${s.url}\n  voice: ${s.voice ?? 'untagged'}\n  quote: ${oneLine(s.quote)}`).join('\n');
  const signalUrls = new Set(passed.map((s) => s.url));

  // The run's focus: business sectors (the seed's, or those the evidence came from) and, for open seeds, consumer segments.
  const sectors = cfg.seedType === 'sector'
    ? (cfg.sectors ?? []).map((s) => capField(s, 80)).filter(Boolean)
    : cfg.seedType === 'open'
      ? [...new Set(passed.map((s) => capField(s.sector, 80)).filter(Boolean))].slice(0, MAX_FOCUS_SECTORS)
      : [];
  const segments = pickConsumerSegments(run.id);
  const focusFor = (withSegments: boolean) => {
    const lines = [`Business sectors: ${sectors.length ? sectors.join('; ') : 'any in the market'}`];
    if (withSegments) lines.push(`Consumer segments: ${segments.join('; ')}`);
    return lines.join('\n');
  };
  const seedText = cfg.seedType === 'lens' ? '' : [...sectors, ...(cfg.seedType === 'open' ? segments : [])].join(', ');

  // Library context per lens: one embedding (lens pattern + seed), then bounded SQL. Never fails the stage.
  const libraryCache = new Map<string, LibraryBlocks>();
  const libraryFor = async (lens: LensRow): Promise<LibraryBlocks> => {
    const cached = libraryCache.get(lens.id);
    if (cached) return cached;
    let blocks: LibraryBlocks = { ...EMPTY_LIBRARY, ids: new Set(), sources: new Map(), prefixes: [] };
    try {
      const text = capField(`${lens.pattern} ${seedText || lens.promptHint}`, 1000);
      const [vector] = await router.embed([text], { runId: run.id, promptVersion: 'library-query.v1' });
      if (vector) {
        const ctx = await ideationContext(db, vector, { countries: market.countries, ...LIBRARY_LIMITS });
        const shown = [...ctx.alreadySold, ...ctx.lessons, ...ctx.pricing];
        const sources: Known = new Map();
        const prefixes: [string, string][] = [];
        for (const e of shown) {
          sources.set(e.id.toLowerCase(), e.id);
          const url = e.url.trim().toLowerCase();
          if (!url) continue;
          if (!sources.has(url)) sources.set(url, e.id);
          const rendered = capField(e.url, RENDERED_URL_MAX).toLowerCase();
          if (!sources.has(rendered)) sources.set(rendered, e.id);
          if (url.length > RENDERED_URL_MAX) prefixes.push([rendered, e.id]);
        }
        blocks = { ...renderIdeationContext(ctx), ids: new Set(shown.map((x) => x.id)), sources, prefixes };
      }
    } catch (err) {
      log(`ideate: library context unavailable for lens ${lens.id} (${errorMessage(err)})`);
    }
    libraryCache.set(lens.id, blocks);
    return blocks;
  };

  // What competitors already sell (gate kills on `generic`) and what already has a case, so ideation steers away.
  const { sold, covered } = await loadAlreadySold(db);
  const asList = (items: string[]) => (items.length ? items.map((s) => `- ${s}`).join('\n') : '(none yet)');
  const gateKilled = wrapUntrusted('gate-killed', asList(sold));
  const alreadyCovered = wrapUntrusted('already-covered', asList(covered));
  const prompt = loadPrompt('ideate');
  const pending: IdeaInsert[] = [];
  let dropped = 0;
  let requested = 0;
  let returned = 0;
  let failedCalls = 0;
  let toCopyLowered = 0;
  const dropReasons: Record<string, number> = {};

  /**
   * One ideate call for at most IDEAS_PER_CALL ideas. A call the router gives up on (StructuredOutputError, after its
   * re-asks; for example every answer cut off) contributes 0 ideas and the run goes on; any other error (network,
   * budget) propagates as before.
   */
  const generate = async (lens: LensRow, count: number, o: { withSegments: boolean; gap: string }): Promise<IdeaInsert[]> => {
    const library = await libraryFor(lens);
    // Titles from earlier calls in this run (earlier lenses and this lens's earlier calls), so each call steers away
    // from buyers/problems already covered. Each shows its audience and business model, so later calls can vary the mix.
    const priorTitles = pending.map((v) => `- ${capField(v.title, 200)} (${v.audience}, ${v.businessModel})`).join('\n');
    requested += count;
    let out: z.infer<typeof lensIdeasSchema>;
    try {
      out = await router.structured(
        'ideate',
        {
          prompt: prompt.render({
            market: `${market.name} (${market.countries.join(', ')})`,
            lensName: lens.name,
            lensPattern: lens.pattern,
            lensHint: lens.promptHint,
            focus: wrapUntrusted('focus', focusFor(o.withSegments)),
            signals: wrapUntrusted('signals', signalsText),
            alreadySold: wrapUntrusted('already-sold', library.alreadySold),
            lessons: wrapUntrusted('lessons', library.lessons),
            pricing: wrapUntrusted('pricing', library.pricing),
            priorIdeas: wrapUntrusted('prior-ideas', priorTitles || '(none yet)'),
            gateKilled,
            alreadyCovered,
            gap: o.gap,
            count: String(count),
            minSignals: String(cfg.minSignals),
          }),
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
    const valid: LensIdea[] = [];
    for (const item of items.slice(0, count)) {
      if (item instanceof DroppedIdea) {
        dropped++;
        for (const r of item.reasons) dropReasons[r] = (dropReasons[r] ?? 0) + 1;
      } else if (item) {
        valid.push(item as LensIdea);
      }
    }
    const known: Known = new Map(library.sources);
    for (const url of signalUrls) if (!known.has(url.toLowerCase())) known.set(url.toLowerCase(), url);
    return valid.slice(0, count).map(({ signalUrls: urls, libraryItemIds, valueToUser, priceHint, barriers, ...f }) => {
      const cited = new Set(urls);
      const checked = checkToCopy(barriers);
      if (checked.lowered) toCopyLowered++;
      return {
        runId: run.id,
        lensId: lens.id,
        origin: 'generated' as const,
        ...f,
        barriers: checked.barriers,
        valueToUser: ground(valueToUser, 400, known, library.prefixes),
        priceHint: ground(priceHint, 300, known, library.prefixes),
        // Only library entries this lens was shown; invented ids are not stored.
        libraryItemIds: [...new Set(libraryItemIds.filter((id) => library.ids.has(id)))],
        signalIds: passed.filter((s) => cited.has(s.url)).map((s) => s.id),
        status: 'candidate' as const,
      };
    });
  };

  // Each lens asks for its share in calls of at most IDEAS_PER_CALL, in lens order (R20: same run id, same calls).
  const count = Math.ceil(cfg.ideaCount / chosen.length);
  for (const lens of chosen) {
    for (const n of splitCounts(count, IDEAS_PER_CALL)) {
      pending.push(...await generate(lens, n, { withSegments: cfg.seedType === 'open', gap: '' }));
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
        pending.push(...await generate(lens, n, { withSegments: mixShort || cfg.seedType === 'open', gap }));
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
