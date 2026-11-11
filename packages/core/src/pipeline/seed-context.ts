import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { lenses, markets, signals } from '../db/schema';
import { AMBITION_LENSES, CONSUMER_SEGMENTS } from '../db/seed';
import { findEntries, ideationContext, renderIdeationContext, type CtxFind } from '../library/context';
import { recentCapturedFindIds } from '../finds/store';
import { capField } from '../llm/untrusted';
import { errorMessage } from '../tools/scrub';
import type { RunConfig, StageDeps } from './types';

/**
 * The seed context shared by ideate and sketch: the run's lenses, its signals, its focus (sectors and consumer
 * segments), a finds seed's finds, the seed text and the per-lens library context. Both stages build it the same way,
 * so a v2 run's sketches and a v1 run's ideas see the same evidence.
 */

/** At most this many harvest signals are shown to a generation call. */
export const MAX_SIGNALS = 40;
/** Open and sector seeds sample at most this many lenses per run (lens seeds use exactly their lenses). */
export const MAX_LENSES_PER_RUN = 6;
/** Of the sampled lenses, at least this many are consumer lenses when that many are active. */
export const MIN_CONSUMER_LENSES = 0;
export const AMBITION_LENS_IDS: readonly string[] = AMBITION_LENSES.map((l) => l.id);
export const MIN_AMBITION_LENSES = 2;
/** Consumer segments an open seed (and the mix re-ask) shows next to the business sectors. */
const SEGMENTS_PER_RUN = 5;
const MAX_FOCUS_SECTORS = 8;
/** Library context per lens: startups already selling, dead startups, pricing entries, what is changing, market size. */
const LIBRARY_LIMITS = { alreadySoldMax: 15, lessonsMax: 8, pricingMax: 15, changingMax: 10, marketsMax: 6, seenInTheWildMax: 6 } as const;
const RENDERED_URL_MAX = 80; // renderIdeationContext caps each url at 80 characters

export const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

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

export const byId = <L extends { id: string }>(a: L, b: L) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The lenses a run uses. Lens seeds (any config with `lensIds`): exactly those active lenses, in the order given.
 * Otherwise at most MAX_LENSES_PER_RUN active lenses: MIN_CONSUMER_LENSES consumer and MIN_AMBITION_LENSES ambition
 * lenses when available (an ambition lens is never also counted as consumer), the rest drawn by `weight ?? 1` from
 * business and `any` lenses and consumer lenses, which compete with them for the slots by weight (no forced consumer lens). Sorted by id before the seeded
 * draws, so the choice depends only on `rng`, not on database row order.
 */
export function selectLenses<L extends { id: string; active: boolean; audience: string; weight?: number | null }>(
  all: L[], cfg: Pick<RunConfig, 'seedType' | 'lensIds'>, rng: () => number,
): L[] {
  const active = all.filter((l) => l.active).sort(byId);
  if (cfg.lensIds) {
    const found = new Map(active.map((l) => [l.id, l]));
    return [...new Set(cfg.lensIds)].map((id) => found.get(id)).filter((l): l is L => !!l);
  }
  const consumer = active.filter((l) => l.audience === 'consumer');
  const rest = active.filter((l) => l.audience !== 'consumer');
  const ambition = rest.filter((l) => AMBITION_LENS_IDS.includes(l.id));
  const pickedAmbition = weightedPick(ambition, MIN_AMBITION_LENSES, rng);
  const pickedConsumer = weightedPick(consumer, MIN_CONSUMER_LENSES, rng);
  const picked = [...pickedConsumer, ...pickedAmbition];
  // Every remaining active lens (business, any and consumer) competes for the other slots by weight.
  const taken = new Set(picked);
  picked.push(...weightedPick([...rest, ...consumer].filter((l) => !taken.has(l)), MAX_LENSES_PER_RUN - picked.length, rng));
  return shuffled(picked, rng);
}

/**
 * Seeded weighted draw of up to `n` items without replacement; a null weight reads as 1. A weight of 0 (or below) is
 * clamped to a tiny positive value, so it means "almost never", not "never": such a lens is still drawn when too few
 * others are left to fill a required slot.
 */
function weightedPick<L extends { weight?: number | null }>(items: L[], n: number, rng: () => number): L[] {
  const left = [...items];
  const out: L[] = [];
  while (out.length < n && left.length) {
    const w = left.map((l) => Math.max(l.weight ?? 1, 1e-6));
    let r = rng() * w.reduce((a, b) => a + b, 0);
    let i = 0;
    while (i < left.length - 1 && r >= w[i]!) r -= w[i++]!;
    out.push(...left.splice(i, 1));
  }
  return out;
}

/** The run's consumer segments (seeded by run id): ideate shows them and harvest queries the library with them. */
export function pickConsumerSegments(runId: string): string[] {
  return shuffled(CONSUMER_SEGMENTS, seededRandom(`${runId}:segments`)).slice(0, SEGMENTS_PER_RUN);
}

/** Citable sources, keyed lower case: a shown library entry's id, url and url as rendered (to the id); a signal url (to itself). */
export type Known = Map<string, string>;

export type LibraryBlocks = {
  alreadySold: string; lessons: string; pricing: string; changing: string; markets: string; seenInTheWild: string;
  ids: Set<string>;
  /** Each shown entry's id to its library kind (the demand evidence route counts only shown trend, market, rule_change and pricing entries). */
  kinds: Map<string, string>;
  /** Lower-cased id, url and rendered url of each shown entry, to its id. */
  sources: Known;
  /** Rendered urls that were cut off (lower case), to the entry id. */
  prefixes: [string, string][];
  /** The lens query embedding (lens pattern + seed), or null when embedding failed. Sketch reuses it for the avoid list. */
  vector: number[] | null;
};
const EMPTY_LIBRARY = renderIdeationContext({ alreadySold: [], lessons: [], pricing: [], changing: [], markets: [], seenInTheWild: [] });

type LensRow = typeof lenses.$inferSelect;
type MarketRow = typeof markets.$inferSelect;
export type SignalRow = typeof signals.$inferSelect;

/**
 * The signals as a generation prompt lists them: url, who wrote it (untagged pre-tuning-4 rows show as `untagged`,
 * which never counts as evidence), its kind (pain or opportunity, for the demand evidence route) and the quote. With
 * `ids`, each signal also shows its id first (sketches cite signals by id).
 */
export function renderSignals(passed: SignalRow[], o: { ids?: boolean } = {}): string {
  return passed
    .map((s) => `${o.ids ? `- id: ${s.id}\n  url: ` : '- url: '}${s.url}\n  voice: ${s.voice ?? 'untagged'}\n  kind: ${s.kind === 'opportunity' ? 'opportunity' : 'pain'}\n  quote: ${oneLine(s.quote)}`)
    .join('\n');
}

export type SeedContext = {
  market: MarketRow;
  allLenses: LensRow[];
  /** The run's lenses (selectLenses, seeded by run id). Never empty. */
  chosen: LensRow[];
  /** The harvest signals shown (the first MAX_SIGNALS that still exist), in harvest order. */
  passed: SignalRow[];
  sectors: string[];
  segments: string[];
  /** Open and finds seeds (neither is tied to a sector) show consumer segments in the focus. */
  withSegmentsSeed: boolean;
  /** The <focus> text: business sectors and, when asked, consumer segments (untrusted; callers wrap it). */
  focusFor(withSegments: boolean): string;
  seedFindIds: string[];
  seedFinds: CtxFind[];
  seedText: string;
  /** The library context for a lens (cached per lens). Never throws: an unavailable library gives empty blocks. */
  libraryFor(lens: LensRow): Promise<LibraryBlocks>;
};

/**
 * Builds the seed context for a non-owner-idea run. Throws on an unknown market or when no active lens is found.
 * `stage` prefixes the log lines (`ideate: …`, `sketch: …`).
 */
export async function buildSeedContext(
  { db, router, log }: Pick<StageDeps, 'db' | 'router' | 'log'>,
  run: { id: string; config: RunConfig },
  signalIds: string[],
  stage: string,
): Promise<SeedContext> {
  const cfg = run.config;
  const [market] = await db.select().from(markets).where(eq(markets.id, cfg.marketId));
  if (!market) throw new Error(`Unknown market: ${cfg.marketId}`);

  const allLenses = await db.select().from(lenses);
  const chosen = selectLenses(allLenses, cfg, seededRandom(`${run.id}:lenses`));
  if (chosen.length === 0) {
    throw new Error(`No active lenses found${cfg.lensIds ? ` for lens ids: ${cfg.lensIds.join(', ')}` : ''}`);
  }

  const used = signalIds.slice(0, MAX_SIGNALS);
  const rows = used.length ? await db.select().from(signals).where(inArray(signals.id, used)) : [];
  const signalById = new Map(rows.map((r) => [r.id, r]));
  const passed = used.map((id) => signalById.get(id)).filter((r): r is NonNullable<typeof r> => !!r);

  // The run's focus: business sectors (the seed's, or those the evidence came from) and, for open and finds seeds
  // (neither is tied to a sector), consumer segments.
  const sectors = cfg.seedType === 'sector'
    ? (cfg.sectors ?? []).map((s) => capField(s, 80)).filter(Boolean)
    : cfg.seedType === 'open'
      ? [...new Set(passed.map((s) => capField(s.sector, 80)).filter(Boolean))].slice(0, MAX_FOCUS_SECTORS)
      : [];
  const segments = pickConsumerSegments(run.id);
  const withSegmentsSeed = cfg.seedType === 'open' || cfg.seedType === 'finds';
  const focusFor = (withSegments: boolean) => {
    const lines = [`Business sectors: ${sectors.length ? sectors.join('; ') : 'any in the market'}`];
    if (withSegments) lines.push(`Consumer segments: ${segments.join('; ')}`);
    return lines.join('\n');
  };
  // A finds seed: its finds are shown first to every lens, and what they are steers the library query.
  let seedFindIds: string[] = [];
  let seedFinds: CtxFind[] = [];
  if (cfg.seedType === 'finds') {
    try {
      seedFindIds = cfg.findIds?.length ? cfg.findIds : await recentCapturedFindIds(db);
      seedFinds = await findEntries(db, seedFindIds);
    } catch (err) {
      log(`${stage}: the seed's finds are unavailable (${errorMessage(err)})`);
    }
  }
  const seedText = cfg.seedType === 'lens' ? ''
    : cfg.seedType === 'finds' ? seedFinds.map((f) => capField(f.what, 120)).join('; ')
    : [...sectors, ...(cfg.seedType === 'open' ? segments : [])].join(', ');

  // Library context per lens: one embedding (lens pattern + seed), then bounded SQL. Never fails the stage.
  const libraryCache = new Map<string, LibraryBlocks>();
  const libraryFor = async (lens: LensRow): Promise<LibraryBlocks> => {
    const cached = libraryCache.get(lens.id);
    if (cached) return cached;
    let blocks: LibraryBlocks = { ...EMPTY_LIBRARY, ids: new Set(), kinds: new Map(), sources: new Map(), prefixes: [], vector: null };
    try {
      const text = capField(`${lens.pattern} ${seedText || lens.promptHint}`, 1000);
      const [vector] = await router.embed([text], { runId: run.id, promptVersion: 'library-query.v1' });
      if (vector) {
        blocks = { ...blocks, vector };
        const ctx = await ideationContext(db, vector, { countries: market.countries, ...LIBRARY_LIMITS, pinnedFindIds: seedFindIds });
        const shown = [...ctx.alreadySold, ...ctx.lessons, ...ctx.pricing, ...ctx.changing, ...ctx.markets, ...ctx.seenInTheWild];
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
        const kinds = new Map<string, string>([
          ...[...ctx.alreadySold, ...ctx.lessons].map((e) => [e.id, 'startup'] as const),
          ...ctx.pricing.map((e) => [e.id, 'pricing'] as const),
          ...ctx.changing.map((e) => [e.id, e.kind] as const),
          ...ctx.markets.map((e) => [e.id, 'market'] as const),
          // Shown and citable, but never a demand source (DEMAND_LIBRARY_KINDS leaves `find` out).
          ...ctx.seenInTheWild.map((e) => [e.id, 'find'] as const),
        ]);
        blocks = { ...renderIdeationContext(ctx), ids: new Set(shown.map((x) => x.id)), kinds, sources, prefixes, vector };
      }
    } catch (err) {
      log(`${stage}: library context unavailable for lens ${lens.id} (${errorMessage(err)})`);
    }
    libraryCache.set(lens.id, blocks);
    return blocks;
  };

  return {
    market, allLenses, chosen, passed, sectors, segments, withSegmentsSeed, focusFor, seedFindIds, seedFinds, seedText, libraryFor,
  };
}
