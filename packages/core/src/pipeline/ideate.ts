import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { ideas, lenses, markets, signals } from '../db/schema';
import { CONSUMER_SEGMENTS } from '../db/seed';
import { ideationContext, renderIdeationContext } from '../library/context';
import { loadPrompt } from '../llm/prompts';
import { capField, wrapUntrusted } from '../llm/untrusted';
import { errorMessage } from '../tools/scrub';
import { loadAlreadySold } from './already-sold';
import {
  AUDIENCES, BarriersSchema, BUSINESS_MODELS, PriceHintSchema, ValueToUserSchema, type BusinessModel, type IdeaAudience,
} from './business-models';
import type { RunConfig, StageDeps } from './types';

const MAX_SIGNALS = 40;

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
/** The one mix re-ask asks for at most this many ideas. */
const REASK_MAX_IDEAS = 6;
const EPS = 1e-9;

/** How an idea delivers value; screen lets at most 2 generated ideas per mechanism reach the gate. */
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
  libraryItemIds: z.array(z.string().uuid()).max(10),
});
type LensIdea = z.infer<typeof lensIdeaSchema>;
/**
 * One invalid idea parses to `undefined` (dropped and counted) instead of failing the whole call. The JSON schema the
 * model sees is the strict idea schema (a catch is transparent there).
 */
const lensIdeasSchema = z.object({
  ideas: z.array(lensIdeaSchema.catch(() => undefined as unknown as LensIdea)),
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

/** The "fill the gap" section of the one mix re-ask. */
function gapInstruction(count: number, consumer: number, models: number, unused: BusinessModel[]): string {
  const lines = ['Fill the gap. This is one extra request after every lens ran: the ideas so far fall short of the mix this run needs.'];
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

/**
 * A value or price keeps its source only when it is a library id shown to this lens or a signal url of the run;
 * otherwise the source is dropped and the basis is labelled as an assumption (a value needs a source or an assumption).
 */
function ground<T extends Grounded>(v: T, basisMax: number, known: Set<string>): T {
  const src = v.source?.trim().replace(/^\[(.*)\]$/, '$1');
  if (src && known.has(src)) return { ...v, source: src };
  const { source: _drop, ...rest } = v;
  const basis = /^\s*assumption\b/i.test(rest.basis) ? rest.basis : `Assumption: ${rest.basis}`.slice(0, basisMax);
  return { ...rest, basis } as T;
}

type LibraryBlocks = { alreadySold: string; lessons: string; pricing: string; ids: Set<string> };
const EMPTY_LIBRARY = renderIdeationContext({ alreadySold: [], lessons: [], pricing: [] });

export type IdeateOutput = {
  ideaIds: string[];
  /** Generated ideas that failed the schema and were not stored. */
  dropped: number;
  /** The run's mix after the optional re-ask; null for owner ideas. */
  mix: (Mix & { reask: boolean }) | null;
};

export async function ideate(
  { db, router, log }: StageDeps,
  run: { id: string; config: RunConfig },
  input: { signalIds: string[] },
): Promise<IdeateOutput> {
  const cfg = run.config;

  if (cfg.seedType === 'idea') {
    const ideaText = cfg.ideaText?.trim();
    if (!ideaText) throw new Error('ideaText is required for idea seeds');
    const prompt = loadPrompt('owner-idea');
    const out = await router.structured(
      'ideate',
      { prompt: prompt.render({ idea: wrapUntrusted('idea', ideaText) }), schema: ownerIdeaSchema, schemaName: 'owner_idea' },
      { runId: run.id, promptVersion: prompt.version },
    );
    const { audience, businessModel, revenueMechanics, valueToUser, priceHint, barriers, ...fields } = out;
    const ideaIds = await replaceRunIdeas(db, run.id, [{
      runId: run.id, lensId: null, origin: 'owner', ...fields, functionalGap: null, knownIncumbents: null,
      audience: audience ?? null, businessModel: businessModel ?? null, revenueMechanics: revenueMechanics ?? null,
      valueToUser: valueToUser ?? null, priceHint: priceHint ?? null, barriers: barriers ?? null, libraryItemIds: null,
      signalIds: input.signalIds, status: 'candidate',
    }]);
    log('ideate: 1 owner idea');
    return { ideaIds, dropped: 0, mix: null };
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
  const segments = shuffled(CONSUMER_SEGMENTS, seededRandom(`${run.id}:segments`)).slice(0, SEGMENTS_PER_RUN);
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
    let blocks: LibraryBlocks = { ...EMPTY_LIBRARY, ids: new Set() };
    try {
      const text = capField(`${lens.pattern} ${seedText || lens.promptHint}`, 1000);
      const [vector] = await router.embed([text], { runId: run.id, promptVersion: 'library-query.v1' });
      if (vector) {
        const ctx = await ideationContext(db, vector, { countries: market.countries, ...LIBRARY_LIMITS });
        blocks = {
          ...renderIdeationContext(ctx),
          ids: new Set([...ctx.alreadySold, ...ctx.lessons, ...ctx.pricing].map((x) => x.id)),
        };
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

  const generate = async (lens: LensRow, count: number, o: { withSegments: boolean; gap: string }): Promise<IdeaInsert[]> => {
    const library = await libraryFor(lens);
    // Titles from earlier lenses in this run, so each lens steers away from buyers/problems already covered.
    const priorTitles = pending.map((v) => `- ${capField(v.title, 200)}`).join('\n');
    const out = await router.structured(
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
      },
      { runId: run.id, promptVersion: prompt.version },
    );
    const valid = (out.ideas as (LensIdea | undefined)[]).filter((i): i is LensIdea => !!i);
    dropped += out.ideas.length - valid.length;
    const known = new Set([...library.ids, ...signalUrls]);
    return valid.slice(0, count).map(({ signalUrls: urls, libraryItemIds, valueToUser, priceHint, ...f }) => {
      const cited = new Set(urls);
      return {
        runId: run.id,
        lensId: lens.id,
        origin: 'generated' as const,
        ...f,
        valueToUser: ground(valueToUser, 400, known),
        priceHint: ground(priceHint, 300, known),
        // Only library entries this lens was shown; invented ids are not stored.
        libraryItemIds: [...new Set(libraryItemIds.filter((id) => library.ids.has(id)))],
        signalIds: passed.filter((s) => cited.has(s.url)).map((s) => s.id),
        status: 'candidate' as const,
      };
    });
  };

  const count = Math.ceil(cfg.ideaCount / chosen.length);
  for (const lens of chosen) {
    pending.push(...await generate(lens, count, { withSegments: cfg.seedType === 'open', gap: '' }));
  }

  // Enforced mix: at most one re-ask per run, never a loop.
  const minModels = Math.min(MIN_MODELS, cfg.ideaCount);
  const before = checkMix(pending, minModels);
  const reask = isShort(before);
  if (reask) {
    const n = pending.length;
    const consumerNow = pending.filter((i) => i.audience === 'consumer' || i.audience === 'both').length;
    const needModels = Math.max(0, minModels - before.models);
    const k = Math.min(REASK_MAX_IDEAS, Math.max(before.short.consumer, needModels, 1));
    const needConsumer = Math.min(k, Math.max(0, Math.ceil(MIN_CONSUMER_SHARE * (n + k) - consumerNow - EPS)));
    // A consumer lens from the run; otherwise (not for lens seeds) a seeded active consumer lens; else the first lens.
    const consumerPool = allLenses.filter((l) => l.active && l.audience === 'consumer').sort(byId);
    const lens = chosen.find((l) => l.audience === 'consumer')
      ?? (!cfg.lensIds && consumerPool.length
        ? consumerPool[Math.floor(seededRandom(`${run.id}:reask`)() * consumerPool.length)]
        : undefined)
      ?? chosen[0]!;
    try {
      pending.push(...await generate(lens, k, {
        withSegments: true,
        gap: gapInstruction(k, needConsumer, needModels, before.short.models),
      }));
    } catch (err) {
      log(`ideate: mix re-ask failed (${errorMessage(err)}), keeping the lens ideas`);
    }
  }
  const after = checkMix(pending, minModels);

  // Written only after every lens call succeeded, so a failed (and resumed) ideate leaves no partial set.
  const ideaIds = await replaceRunIdeas(db, run.id, pending);
  if (dropped > 0) log(`ideate: dropped ${dropped} invalid idea${dropped === 1 ? '' : 's'}`);
  const stillShort = isShort(after)
    ? [
        after.short.consumer > 0 ? `${after.short.consumer} consumer` : '',
        after.short.models.length ? plural(minModels - after.models, 'model') : '',
      ].filter(Boolean).join(', ')
    : 'no';
  log(`ideate: mix consumer ${Math.round(after.consumerShare * 100)}% models ${after.models} (re-ask: ${reask ? 'yes' : 'no'}, still short: ${stillShort})`);
  log(`ideate: ${ideaIds.length} ideas from ${chosen.length} lenses`);
  return { ideaIds, dropped, mix: { ...after, reask } };
}
