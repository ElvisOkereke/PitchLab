import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { lenses, markets, signals } from '../db/schema';
import { loadPrompt } from '../llm/prompts';
import { DEFAULT_WP_SLUGS } from '../tools/sources/wordpress';
import type { RawItem } from '../tools/sources/types';
import { logDataCall } from '../tools/data-calls';
import type { RunConfig, StageDeps } from './types';

export const PAIN_PHRASES = [
  'stopped working', 'lost leads', 'manual every week', 'spreadsheet nightmare',
  'keeps breaking', 'wasting hours', 'no way to know if', 'silently failing',
];

const BATCH = 25;
const QUERIES_PER_SOURCE = 2;
const PHRASE_SOURCES = new Set(['hn', 'stackexchange', 'github']);

const extractSchema = z.object({
  signals: z.array(z.object({
    url: z.string(),
    title: z.string(),
    quote: z.string(),
    sector: z.string().nullable(),
    painType: z.string().nullable(),
    isPain: z.boolean(),
  })),
});

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
const normalizeQuote = (s: string) => collapse(s).toLowerCase();
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

function pick<T>(arr: T[], n: number, random: () => number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
}

export async function harvest(
  { db, router, sources, log }: StageDeps,
  run: { id: string; config: RunConfig },
  opts: { random?: () => number } = {},
): Promise<{ signalIds: string[] }> {
  const random = opts.random ?? Math.random;
  const cfg = run.config;
  const [market] = await db.select().from(markets).where(eq(markets.id, cfg.marketId));
  if (!market) throw new Error(`Unknown market: ${cfg.marketId}`);
  const countries = market.countries.join(', ');

  // Build phrase queries from the seed.
  let phraseQueries: string[] = [];
  let focus: string;
  if (cfg.seedType === 'open') {
    phraseQueries = pick(market.sectors, 6, random).flatMap((s) => PAIN_PHRASES.map((p) => `${s} ${p}`));
    focus = `Pain across these sectors: ${market.sectors.join(', ')}.`;
  } else if (cfg.seedType === 'sector') {
    const sectors = cfg.sectors ?? [];
    phraseQueries = sectors.flatMap((s) => PAIN_PHRASES.map((p) => `${s} ${p}`));
    focus = `Pain in these sectors: ${sectors.join(', ')}.`;
  } else if (cfg.seedType === 'lens') {
    const rows = await db.select().from(lenses).where(inArray(lenses.id, cfg.lensIds ?? []));
    const hints = rows.map((l) => l.promptHint);
    phraseQueries = hints.flatMap((h) => pick(market.sectors, 4, random).map((s) => `${s} ${h}`));
    focus = `Pain relevant to: ${hints.join(' ')}`;
  } else {
    focus = `The problem described by this idea: "${cfg.ideaText ?? ''}". Find the problem itself, who suffers it, and evidence that it happens.`;
  }

  const items: RawItem[] = [];

  // (a) free sources
  if (cfg.seedType !== 'idea') {
    for (const source of sources) {
      let queries: string[];
      if (PHRASE_SOURCES.has(source.id)) queries = pick(phraseQueries, QUERIES_PER_SOURCE, random);
      else if (source.id === 'wordpress') queries = pick(DEFAULT_WP_SLUGS, QUERIES_PER_SOURCE, random);
      else continue; // appstore skipped in Plan 1 (R12)
      for (const q of queries) {
        const found = await source.search(q, { limit: 10 });
        await logDataCall(db, { runId: run.id, provider: source.id, endpoint: q, costUsd: 0, ok: true });
        items.push(...found);
      }
    }
  }

  // (b) LLM web research
  const researchPrompt = loadPrompt('harvest-research');
  const maxSearches = cfg.seedType === 'idea' ? 2 * cfg.maxSearchesPerCall : cfg.maxSearchesPerCall;
  const research = await router.research(
    'harvest',
    { prompt: researchPrompt.render({ countries, focus }), maxSearches },
    { runId: run.id, promptVersion: researchPrompt.version },
  );
  for (const s of research.sources) {
    const text = s.citedText ?? '';
    if (!text.trim()) continue;
    items.push({ source: 'web', url: s.url, title: s.title ?? s.url, text, publishedAt: null });
  }

  // (c) extraction
  const extractPrompt = loadPrompt('extract-signals');
  const kept: { item: RawItem; quote: string; hash: string; sector: string | null; painType: string | null }[] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const rendered = batch.map((it) => `- url: ${it.url}\n  title: ${it.title}\n  text: ${collapse(it.text)}`).join('\n');
    const out = await router.structured(
      'extract',
      { prompt: extractPrompt.render({ countries, items: rendered }), schema: extractSchema, schemaName: 'extract_signals' },
      { runId: run.id, promptVersion: extractPrompt.version },
    );
    for (const s of out.signals) {
      if (!s.isPain) continue;
      const quote = collapse(s.quote);
      if (!quote) continue;
      const item = batch.find((it) => it.url === s.url && collapse(it.text).includes(quote));
      if (!item) continue;
      kept.push({ item, quote, hash: md5(normalizeQuote(quote)), sector: s.sector, painType: s.painType });
    }
  }
  if (kept.length === 0) {
    log('harvest: no signals extracted');
    return { signalIds: [] };
  }

  await db.insert(signals).values(kept.map((k) => ({
    runId: run.id,
    marketId: cfg.marketId,
    source: k.item.source,
    url: k.item.url,
    title: k.item.title,
    quote: k.quote,
    quoteHash: k.hash,
    sector: k.sector,
    painType: k.painType,
    publishedAt: k.item.publishedAt,
  }))).onConflictDoNothing({ target: [signals.url, signals.quoteHash] });

  const ids = new Set<string>();
  for (const k of kept) {
    const [row] = await db.select({ id: signals.id }).from(signals)
      .where(and(eq(signals.url, k.item.url), eq(signals.quoteHash, k.hash)));
    if (row) ids.add(row.id);
  }
  log(`harvest: ${ids.size} signals`);
  return { signalIds: [...ids] };
}
