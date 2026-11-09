import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { torontoDayStart } from '../../dashboard/command';
import type { Db } from '../../db/client';
import { llmCalls } from '../../db/schema';
import { upsertKnowledgeItem } from '../../library/store';
import type { KnowledgeKind } from '../../library/kinds';
import { loadPrompt } from '../../llm/prompts';
import type { ModelRouter } from '../../llm/types';
import { capField, stripInvisible } from '../../llm/untrusted';
import { isBannedSource } from '../../tools/banned-sources';
import { logDataCall } from '../../tools/data-calls';
import type { fetchPage as fetchPageFn } from '../../tools/fetch-page';
import { errorMessage } from '../../tools/scrub';
import type { RawItem } from '../../tools/sources/types';
import { getSetting, setSetting } from '../../validation/settings';
import { SourceError, type CallHook } from '../http';
import { EXTRACT_BATCH, extractDrafts, type Collected } from '../mission';
import { arxivFeed } from './arxiv';
import { blueskyFeed } from './bluesky';
import { MAX_PER_SOURCE, type FeedOpts } from './common';
import { githubTrendingFeed } from './githubtrending';
import { hnShowFeed } from './hnshow';
import { huggingFaceFeed } from './huggingface';
import { redditFeed } from './reddit';
import { DEFAULT_RSS_FEEDS, rssFeed, webUrl } from './rss';
import { FEED_SOURCES, FEEDS_STATS_KEY, type FeedSource, type FeedSourceStats } from './status';
import { planFeedTopics, type FeedTopics } from './topics';
import { ytShortsFeed } from './ytshorts';

export const FEEDS_LAST_RUN_KEY = 'feeds.lastRun';
export const FEEDS_EVERY_HOURS_KEY = 'feeds.everyHours';
export const FEEDS_DAILY_USD_KEY = 'feeds.dailyUsd';
export const FEEDS_RSS_KEY = 'feeds.rss';
/** Short hashes of items already sent to extraction, so the same post is not paid for every run. */
export const FEEDS_SEEN_KEY = 'feeds.seen';
export const DEFAULT_EVERY_HOURS = 6;
export const DEFAULT_DAILY_USD = 2;
const MAX_SEEN = 4000;
const MAX_RSS_FEEDS = 20;
const MAX_ERRORS = 5;
/** What the feeds extract: the kinds social and launch posts can support. */
export const FEED_KINDS: KnowledgeKind[] = ['problem', 'startup', 'trend', 'pricing'];
/** Marks the feeds' llm_calls rows (prompt version prefix), so their daily spend is told apart from missions and runs. */
export const FEEDS_PROMPT_PREFIX = 'feeds:';

export type FeedKeys = { youtubeApiKey?: string; blueskyHandle?: string; blueskyAppPassword?: string };
export type FeedCollectors = Record<FeedSource, (q: string) => Promise<RawItem[]>>;

export type FeedDeps = {
  db: Db;
  router: ModelRouter;
  /** The SSRF-guarded fetcher, used for the feed urls from the `feeds.rss` setting. */
  fetchPage: typeof fetchPageFn;
  log: (m: string) => void;
  now?: () => Date;
  keys?: FeedKeys;
  /** Transport hooks for the fixed-host collectors (tests). */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Replaces a built-in collector (tests). */
  collectors?: Partial<FeedCollectors>;
  /**
   * Checked between sources and between extraction batches: true (for example a run was queued) stops this run early,
   * keeping what it has stored and marked seen; the rest waits for the next due run.
   */
  shouldYield?: () => boolean | Promise<boolean>;
  /** The worker's stop signal: an aborted signal stops the run at the same points. */
  signal?: AbortSignal;
};

export type FeedsResult = { bySource: Record<string, FeedSourceStats>; spentUsd: number; warnings: string[] };

const asNumber = (v: unknown, min: number, max: number, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : dflt;

export const feedsEveryHours = async (db: Db): Promise<number> => asNumber(await getSetting(db, FEEDS_EVERY_HOURS_KEY), 0.01, 168, DEFAULT_EVERY_HOURS);
export const feedsDailyUsd = async (db: Db): Promise<number> => asNumber(await getSetting(db, FEEDS_DAILY_USD_KEY), 0, 50, DEFAULT_DAILY_USD);

/** True when the feeds never ran, or the last run (`feeds.lastRun`) is at least `feeds.everyHours` old. */
export async function feedsDue(db: Db, now: Date): Promise<boolean> {
  const last = await getSetting(db, FEEDS_LAST_RUN_KEY);
  const t = typeof last === 'string' ? Date.parse(last) : NaN;
  if (!Number.isFinite(t)) return true;
  return now.getTime() >= t + (await feedsEveryHours(db)) * 3_600_000;
}

/** Model spend of the feeds since Toronto midnight (their llm_calls rows carry the `feeds:` prompt version prefix). */
export async function feedsSpentToday(db: Db, now: Date): Promise<number> {
  const [r] = await db.select({ s: sql<string>`coalesce(sum(${llmCalls.costUsd}), 0)::text` }).from(llmCalls)
    .where(sql`${llmCalls.promptVersion} like ${`${FEEDS_PROMPT_PREFIX}%`} and ${llmCalls.createdAt} >= ${torontoDayStart(now).toISOString()}::timestamptz`);
  return Number(r?.s ?? 0);
}

/** The newsletter feed list: setting `feeds.rss` (an array of web addresses, at most 20) or the defaults. */
export async function getFeedRssList(db: Db): Promise<string[]> {
  const v = await getSetting(db, FEEDS_RSS_KEY);
  if (!Array.isArray(v)) return [...DEFAULT_RSS_FEEDS];
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && x.length <= 300).map((x) => webUrl(x.trim())).filter(Boolean))].slice(0, MAX_RSS_FEEDS);
}

const FEED_OF_SOURCE_TYPE: Record<string, FeedSource> = {
  reddit: 'reddit', bluesky: 'bluesky', hn: 'hnshow', arxiv: 'arxiv', huggingface: 'huggingface', githubtrending: 'githubtrending', rss: 'rss', youtube: 'ytshorts',
};

const hashOf = (key: string): string => createHash('sha1').update(key).digest('hex').slice(0, 16);
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

/** Why a source stopped, in words for the Connections view (never a url, header or key). */
function reasonOf(e: unknown): string {
  if (e instanceof SourceError) {
    switch (e.code) {
      case 'rate_limited': return 'rate limited';
      case 'bad_response': return capField(e.message.replace(/^[a-z-]+: /, ''), 150) || 'unexpected response';
      case 'auth': return capField(e.message.replace(/^[a-z-]+: /, ''), 150) || 'not authorised';
      default: return capField(e.message.replace(/^[a-z-]+: /, ''), 150) || e.code;
    }
  }
  return capField(stripInvisible(errorMessage(e)), 150) || 'failed';
}

function buildCollectors(deps: FeedDeps, onCall: CallHook, now: Date, warnYoutube: (w: string) => void): FeedCollectors {
  const o: FeedOpts = { fetch: deps.fetch, sleep: deps.sleep, onCall, now: () => now, log: (m) => deps.log(`feeds: ${m}`) };
  const keys = deps.keys ?? {};
  const youtube = { searches: 0, stopped: false };
  const built: FeedCollectors = {
    reddit: (q) => redditFeed(q, o),
    bluesky: (q) => blueskyFeed(q, { ...o, handle: keys.blueskyHandle, appPassword: keys.blueskyAppPassword }),
    hnshow: (q) => hnShowFeed(q, o),
    arxiv: (q) => arxivFeed(q, o),
    huggingface: (q) => huggingFaceFeed(q, o),
    githubtrending: (q) => githubTrendingFeed(q, o),
    rss: (q) => rssFeed(q, { ...o, fetchPage: deps.fetchPage }),
    ytshorts: (q) => ytShortsFeed(q, { apiKey: keys.youtubeApiKey, db: deps.db, state: youtube, onCall, onWarn: warnYoutube, fetch: deps.fetch, sleep: deps.sleep, now: () => now.getTime() }),
  };
  return { ...built, ...deps.collectors };
}

function inputsFor(name: FeedSource, topics: FeedTopics, rss: string[]): string[] {
  switch (name) {
    case 'reddit': return [...topics.subreddits, ...topics.queries.slice(0, 6)];
    case 'bluesky': return topics.queries.slice(0, 8);
    case 'arxiv': return topics.queries.slice(0, 4);
    case 'ytshorts': return topics.queries.slice(0, 3);
    case 'rss': return rss;
    default: return ['']; // hnshow, huggingface, githubtrending: global lists, one pass
  }
}

/**
 * The exit code for `gen feeds run`: 1 when no source collected anything (each one failed or was skipped) and nothing
 * was added, else 0.
 */
export function feedsExitCode(r: FeedsResult): number {
  const stats = Object.values(r.bySource);
  const added = stats.reduce((a, s) => a + s.added, 0);
  return stats.length > 0 && added === 0 && stats.every((s) => s.items === 0 && s.errors.length > 0) ? 1 : 0;
}

/** Runs unconditionally (the manual `gen feeds run`). Never throws: a failure is recorded in the returned warnings and stats. */
export async function runFeedsJob(deps: FeedDeps): Promise<FeedsResult> {
  const { db, router, log } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const result: FeedsResult = { bySource: {}, spentUsd: 0, warnings: [] };
  const warn = (w: string) => {
    const msg = capField(stripInvisible(w), 200);
    if (!result.warnings.includes(msg) && result.warnings.length < 20) result.warnings.push(msg);
    log(`feeds: ${msg}`);
  };
  // Recorded first, so a crash or restart mid-run does not start another run early.
  await setSetting(db, FEEDS_LAST_RUN_KEY, now.toISOString());
  const stats = (name: FeedSource): FeedSourceStats => (result.bySource[name] ??= { items: 0, added: 0, errors: [] });
  const fail = (name: FeedSource, msg: string) => {
    const s = stats(name);
    if (s.errors.length < MAX_ERRORS && !s.errors.includes(msg)) s.errors.push(capField(msg, 200));
  };
  const save = async () => {
    await setSetting(db, FEEDS_STATS_KEY, { at: now.toISOString(), spentUsd: result.spentUsd, bySource: result.bySource });
  };
  let yielded = false;
  /** True once the worker has other work queued or is stopping (warned once); the run then stops where it is. */
  const yieldNow = async (): Promise<boolean> => {
    if (yielded) return true;
    if (deps.signal?.aborted || (deps.shouldYield && (await deps.shouldYield()))) {
      yielded = true;
      warn('paused for queued work; the rest waits for the next run');
    }
    return yielded;
  };

  try {
    const cap = await feedsDailyUsd(db);
    const spentBefore = await feedsSpentToday(db, now);
    for (const n of FEED_SOURCES) stats(n);
    if (spentBefore >= cap) {
      warn(`daily cap of $${cap} reached; skipped this run`);
      for (const n of FEED_SOURCES) fail(n, 'skipped: daily cap reached');
      await save();
      return result;
    }
    const topics = await planFeedTopics(db, now);
    const rss = await getFeedRssList(db);
    const onCall: CallHook = (c) => logDataCall(db, { runId: null, provider: c.provider, endpoint: c.endpoint, ok: c.ok });
    const collectors = buildCollectors(deps, onCall, now, (w) => fail('ytshorts', w));
    const seenList = (await getSetting(db, FEEDS_SEEN_KEY));
    const seen = new Set<string>(Array.isArray(seenList) ? seenList.filter((x): x is string => typeof x === 'string') : []);
    const newSeen: string[] = [];

    // 1. Collect, source by source.
    const perSource = new Map<FeedSource, RawItem[]>();
    for (const name of FEED_SOURCES) {
      if (await yieldNow()) break;
      if (name === 'ytshorts' && !deps.keys?.youtubeApiKey && !deps.collectors?.ytshorts) {
        fail(name, 'skipped: no YouTube API key');
        continue;
      }
      const items: RawItem[] = [];
      const keys = new Set<string>();
      let consecutive = 0;
      for (const q of inputsFor(name, topics, rss)) {
        if (items.length >= MAX_PER_SOURCE) break;
        let got: RawItem[];
        try {
          got = await collectors[name](q);
          consecutive = 0;
        } catch (e) {
          const why = reasonOf(e);
          const code = e instanceof SourceError ? e.code : 'network';
          fail(name, name === 'rss' ? `${hostOf(q)}: ${why}` : why);
          if (name === 'rss') continue; // one bad feed never stops the others
          if (code === 'rate_limited' || code === 'bad_response' || code === 'auth' || ++consecutive >= 3) {
            warn(`${name}: ${why}; stopped for this run`);
            break;
          }
          continue;
        }
        for (const it of got) {
          if (items.length >= MAX_PER_SOURCE) break;
          const text = (it.text ?? '').trim();
          // YouTube items share their video's url, so those are told apart by their text.
          const key = it.source === 'youtube' ? `${it.url}\n${text}` : it.url;
          if (!text || keys.has(key) || isBannedSource(it.url) || seen.has(hashOf(key))) continue;
          keys.add(key);
          items.push(it);
        }
      }
      stats(name).items = items.length;
      perSource.set(name, items);
    }

    // 2. Extract in batches, round-robin across sources so a cap never starves the later ones.
    const queue: { it: RawItem; key: string }[] = [];
    const lists = [...perSource.values()];
    for (let i = 0; lists.some((l) => i < l.length); i++) {
      for (const l of lists) if (i < l.length) queue.push({ it: l[i]!, key: l[i]!.source === 'youtube' ? `${l[i]!.url}\n${l[i]!.text.trim()}` : l[i]!.url });
    }
    let capped = false;
    const overCap = async (): Promise<boolean> => {
      if (!capped && (await feedsSpentToday(db, now)) >= cap) {
        capped = true;
        warn(`daily cap of $${cap} reached; stopped extracting`);
      }
      return capped;
    };
    const extractPrompt = loadPrompt('library-extract');
    for (let i = 0; i < queue.length && !(await overCap()) && !(await yieldNow()); i += EXTRACT_BATCH) {
      const slice = queue.slice(i, i + EXTRACT_BATCH);
      const texts: Collected[] = slice.map(({ it }) => ({
        url: it.url, domain: hostOf(it.url), sourceType: it.source, title: it.title ?? '', text: it.text.trim(), publishedAt: it.publishedAt,
      }));
      const ctx = { runId: null, missionId: null, promptVersion: `${FEEDS_PROMPT_PREFIX}${extractPrompt.version}` };
      const out = await extractDrafts(router, texts, { kinds: FEED_KINDS, countries: 'any (global)', ctx, overBudget: overCap, warn });
      if (out.drafts.length > 0) {
        const vectors = await router.embed(out.drafts.map((d) => `${d.title}\n${d.summary}`), { ...ctx, promptVersion: `${FEEDS_PROMPT_PREFIX}library-embed.v1` });
        if (vectors.length !== out.drafts.length) throw new Error('feeds: embedding count mismatch');
        for (let j = 0; j < out.drafts.length; j++) {
          const d = out.drafts[j]!;
          const r = await upsertKnowledgeItem(db, d, vectors[j]!, { now });
          const feed = FEED_OF_SOURCE_TYPE[d.source.sourceType];
          if (r.outcome === 'added' && feed) stats(feed).added++;
        }
      }
      // Items whose batch was paid for (or stopped by the cap) are not retried; a batch that failed is, next run.
      // Saved after every batch, so a failure or a stop later in the run never pays for these again.
      if (out.batchesFailed === 0 && out.batchesOk > 0) {
        for (const { key } of slice) newSeen.push(hashOf(key));
        await setSetting(db, FEEDS_SEEN_KEY, [...seen, ...newSeen].slice(-MAX_SEEN));
      }
    }
    result.spentUsd = Math.max(0, (await feedsSpentToday(db, now)) - spentBefore);
  } catch (e) {
    warn(`failed: ${reasonOf(e)}`);
  }
  await save();
  const total = Object.values(result.bySource).reduce((a, s) => ({ items: a.items + s.items, added: a.added + s.added }), { items: 0, added: 0 });
  log(`feeds: ${total.items} items, ${total.added} added, $${result.spentUsd.toFixed(2)} spent`);
  return result;
}

/** The worker's entry: runs the feeds only when they are due (`feeds.lastRun` plus `feeds.everyHours`); null otherwise. */
export async function runDueFeedsJob(deps: FeedDeps): Promise<FeedsResult | null> {
  const now = (deps.now ?? (() => new Date()))();
  if (!(await feedsDue(deps.db, now))) return null;
  return runFeedsJob(deps);
}
