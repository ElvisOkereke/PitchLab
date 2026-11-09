import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../../src/db/client';
import { knowledgeItems, llmCalls, settings } from '../../../src/db/schema';
import type { CallCtx, ModelRouter } from '../../../src/llm/types';
import { SourceError } from '../../../src/research/http';
import { FEEDS_LAST_RUN_KEY, FEEDS_RSS_KEY, FEEDS_SEEN_KEY, feedsDue, feedsSpentToday, getFeedRssList, runDueFeedsJob, runFeedsJob, type FeedCollectors, type FeedDeps } from '../../../src/research/feeds/job';
import { DEFAULT_RSS_FEEDS } from '../../../src/research/feeds/rss';
import { FEEDS_STATS_KEY, readFeedsStatus } from '../../../src/research/feeds/status';
import { resetThrottle } from '../../../src/research/http';
import type { RawItem } from '../../../src/tools/sources/types';
import { getSetting, setSetting } from '../../../src/validation/settings';
import { testDb, unit } from '../../helpers/db';

const NOW = new Date('2026-11-08T15:00:00Z');
beforeEach(resetThrottle);

const SENTENCE = 'Chasing unpaid invoices takes me six hours every single week and nothing fixes it.';
const item = (source: string, n: number, extra = ''): RawItem => ({
  source, url: `https://example.com/${source}/${n}`, title: `Post ${n}`, text: `${SENTENCE} Item ${n}. ${extra}`, publishedAt: new Date('2026-11-01'),
});
const items = (source: string, count: number, offset = 0): RawItem[] => Array.from({ length: count }, (_, i) => item(source, offset + i));

const vec = new Map<string, number>();
const vectorFor = (t: string) => {
  if (!vec.has(t)) vec.set(t, vec.size % 1536);
  return unit(vec.get(t)!);
};

/** Extraction: one problem entry per source, quoting the first sentence; each call costs `extractCost`. */
function router(db: Db, o: { extractCost?: number; fail?: boolean } = {}) {
  const calls: { kind: string; ctx: CallCtx; prompt: string }[] = [];
  const log = (stage: string, ctx: CallCtx, cost: number) =>
    db.insert(llmCalls).values({ runId: ctx.runId, missionId: ctx.missionId ?? null, stage, provider: 'p', model: 'm', inputTokens: 0, outputTokens: 0, searchRequests: 0, costUsd: String(cost), latencyMs: 0, promptVersion: ctx.promptVersion, ok: true, createdAt: NOW });
  const r: ModelRouter & { calls: typeof calls } = {
    calls,
    modelFor: () => 'm',
    async text() { throw new Error('unused'); },
    async research() { throw new Error('unused'); },
    async structured(stage, req, ctx) {
      calls.push({ kind: 'structured', ctx, prompt: req.prompt });
      await log(stage, ctx, o.extractCost ?? 0.01);
      if (o.fail) throw new Error('model down');
      const sources = [...req.prompt.matchAll(/Source (\d+):\n<source>\n([\s\S]*?)\n<\/source>/g)].map((m) => ({ n: Number(m[1]), text: m[2]! }));
      return req.schema.parse({
        entries: sources.map((s) => ({
          source: s.n, kind: 'problem', title: `Pain ${s.text.slice(0, 50)}`, summary: `Someone says: ${s.text.slice(0, 60)}`,
          quote: SENTENCE,
          audience: 'business', countries: ['us'], industries: ['Trades'], voice: 'operator', facts: { persona: 'plumber' },
        })),
      });
    },
    async embed(texts, ctx) {
      calls.push({ kind: 'embed', ctx, prompt: texts.join('|') });
      await log('embed', ctx, 0);
      return texts.map(vectorFor);
    },
  };
  return r;
}

type Run = { collectors: Partial<FeedCollectors>; asked: Record<string, string[]> };
function collectors(map: Record<string, (q: string, n: number) => RawItem[] | Error>): Run {
  const asked: Record<string, string[]> = {};
  const out: Partial<FeedCollectors> = {};
  for (const [name, fn] of Object.entries(map)) {
    out[name as keyof FeedCollectors] = async (q) => {
      (asked[name] ??= []).push(q);
      const r = fn(q, asked[name]!.length - 1);
      if (r instanceof Error) throw r;
      return r;
    };
  }
  return { collectors: out, asked };
}

const NONE = { reddit: () => [], bluesky: () => [], hnshow: () => [], arxiv: () => [], huggingface: () => [], githubtrending: () => [], rss: () => [], ytshorts: () => [] };
const deps = (db: Db, r: ModelRouter, c: Partial<FeedCollectors>, extra: Partial<FeedDeps> = {}): FeedDeps => ({
  db, router: r, fetchPage: (async () => { throw new Error('no network'); }) as never, log: () => {}, now: () => NOW, collectors: c, ...extra,
});

describe('runFeedsJob', () => {
  it('collects, extracts, stores, and reports items and added per source; saves the schedule and the stats', async () => {
    const db = await testDb();
    const c = collectors({ ...NONE, hnshow: () => items('hn', 3), reddit: (q) => (q.startsWith('r/') ? items('reddit', 2, 100) : []) });
    const r = await runFeedsJob(deps(db, router(db), c.collectors));
    expect(r.bySource.hnshow).toMatchObject({ items: 3, added: 3 });
    expect(r.bySource.reddit).toMatchObject({ items: 2, added: 2 }); // returned once per subreddit, deduplicated by url
    const rows = await db.select().from(knowledgeItems);
    expect(rows).toHaveLength(5);
    expect(await getSetting(db, FEEDS_LAST_RUN_KEY)).toBe(NOW.toISOString());
    const status = await readFeedsStatus(db);
    expect(status?.at).toBe(NOW.toISOString());
    expect(status?.sources.find((s) => s.name === 'hnshow')).toMatchObject({ items: 3, added: 3, errors: [] });
    expect(r.spentUsd).toBeGreaterThan(0);
  });

  it('queries sources with the planned topics: 10 to 20 for the query sources, once for the global lists, feeds for rss', async () => {
    const db = await testDb();
    const c = collectors(NONE);
    await runFeedsJob(deps(db, router(db), c.collectors, { keys: { youtubeApiKey: 'k' } }));
    expect(c.asked.reddit!.filter((q) => q.startsWith('r/'))).toHaveLength(3);
    expect(c.asked.bluesky!.length).toBeGreaterThanOrEqual(8);
    expect(c.asked.arxiv).toHaveLength(4);
    expect(c.asked.ytshorts).toHaveLength(3);
    expect(c.asked.hnshow).toEqual(['']);
    expect(c.asked.huggingface).toEqual(['']);
    expect(c.asked.githubtrending).toEqual(['']);
    expect(c.asked.rss).toEqual([...DEFAULT_RSS_FEEDS]);
  });

  it('keeps at most 200 items per source per run', async () => {
    const db = await testDb();
    const c = collectors({ ...NONE, reddit: (q, n) => items('reddit', 25, n * 25), rss: (q) => items('rss', 25, 1000) });
    await setSetting(db, 'feeds.dailyUsd', 1);
    const r = await runFeedsJob(deps(db, router(db, { extractCost: 5 }), c.collectors)); // the cap ends extraction after one batch
    expect(r.bySource.reddit!.items).toBe(200);
    expect(c.asked.reddit!.length).toBeLessThan(9 + 1); // 3 subreddits + 6 queries at most; stops asking once full
  });

  it('a 429 stops that source for the run with a warning; the other sources carry on', async () => {
    const db = await testDb();
    const warnings: string[] = [];
    const c = collectors({ ...NONE, reddit: () => new SourceError('rate_limited', 'reddit'), hnshow: () => items('hn', 2) });
    const r = await runFeedsJob(deps(db, router(db), c.collectors, { log: (m) => warnings.push(m) }));
    expect(c.asked.reddit).toHaveLength(1);
    expect(r.bySource.reddit!.errors).toEqual(['rate limited']);
    expect(r.bySource.hnshow!.added).toBe(2);
    expect(r.warnings.join('\n')).toContain('reddit: rate limited; stopped for this run');
    expect(warnings.join('\n')).toContain('reddit: rate limited');
  });

  it('HTML or malformed data (bad_response) stops that source for the run with a warning', async () => {
    const db = await testDb();
    const c = collectors({ ...NONE, bluesky: () => new SourceError('bad_response', 'bluesky', 'bluesky: response had no post list'), arxiv: () => items('arxiv', 1) });
    const r = await runFeedsJob(deps(db, router(db), c.collectors));
    expect(c.asked.bluesky).toHaveLength(1);
    expect(r.warnings.join('\n')).toContain('bluesky: response had no post list; stopped for this run');
    expect(r.bySource.arxiv!.items).toBe(1);
  });

  it('other errors are recorded and the source stops after three in a row', async () => {
    const db = await testDb();
    const c = collectors({ ...NONE, bluesky: () => new SourceError('network', 'bluesky', 'bluesky: request failed') });
    const r = await runFeedsJob(deps(db, router(db), c.collectors));
    expect(c.asked.bluesky).toHaveLength(3);
    expect(r.bySource.bluesky!.errors).toEqual(['request failed']);
  });

  it('one failing feed does not stop the other feeds', async () => {
    const db = await testDb();
    await setSetting(db, FEEDS_RSS_KEY, ['https://a.example/feed', 'https://b.example/feed']);
    const c = collectors({ ...NONE, rss: (q) => (q.includes('a.example') ? new SourceError('bad_response', 'rss', 'rss: response was not an RSS or Atom feed') : items('rss', 2)) });
    const r = await runFeedsJob(deps(db, router(db), c.collectors));
    expect(c.asked.rss).toEqual(['https://a.example/feed', 'https://b.example/feed']);
    expect(r.bySource.rss).toMatchObject({ items: 2, added: 2 });
    expect(r.bySource.rss!.errors[0]).toContain('a.example');
  });

  it('keeps reddit.com posts from any source (bans lifted) but refuses banned and never-fetch hosts', async () => {
    const db = await testDb();
    const reddit = { ...item('reddit', 1), url: 'https://www.reddit.com/r/smallbusiness/comments/abc123/slug/' };
    const linked = { ...item('rss', 2), url: 'https://www.reddit.com/r/x/comments/zzz999/slug/' };
    const bing = { ...item('rss', 3), url: 'https://www.bing.com/news/x' };
    const pilot = { ...item('rss', 4), url: 'https://shop.gamersgetaway.ca/sale' };
    const c = collectors({ ...NONE, reddit: (q) => (q.startsWith('r/') ? [reddit] : []), rss: () => [linked, bing, pilot] });
    const r = await runFeedsJob(deps(db, router(db), c.collectors));
    expect(r.bySource.reddit).toMatchObject({ items: 1, added: 1 });
    expect(r.bySource.rss!.items).toBe(1);
  });

  it('skips Shorts without a YouTube key and says so', async () => {
    const db = await testDb();
    const c = collectors(NONE);
    const r = await runFeedsJob(deps(db, router(db), c.collectors, { collectors: { ...c.collectors, ytshorts: undefined } }));
    expect(r.bySource.ytshorts!.errors).toEqual(['skipped: no YouTube API key']);
  });

  it('stops extracting between batches when the daily cap is reached, and does not mark unextracted items as seen', async () => {
    const db = await testDb();
    await setSetting(db, 'feeds.dailyUsd', 1);
    const c = collectors({ ...NONE, hnshow: () => items('hn', 24) }); // 3 batches of 8
    const rt = router(db, { extractCost: 0.6 });
    const r = await runFeedsJob(deps(db, rt, c.collectors));
    expect(rt.calls.filter((x) => x.kind === 'structured')).toHaveLength(2); // 0.6, then 1.2 >= 1: no third batch
    expect(r.warnings.join('\n')).toContain('daily cap of $1 reached');
    expect(r.bySource.hnshow!.added).toBe(16);
    expect(((await getSetting(db, FEEDS_SEEN_KEY)) as string[]).length).toBe(16);
    expect(r.spentUsd).toBeCloseTo(1.2, 5);
  });

  it('does nothing when the cap was already spent today', async () => {
    const db = await testDb();
    await setSetting(db, 'feeds.dailyUsd', 1);
    await db.insert(llmCalls).values({ runId: null, missionId: null, stage: 'library_extract', provider: 'p', model: 'm', inputTokens: 0, outputTokens: 0, searchRequests: 0, costUsd: '1.5', latencyMs: 0, promptVersion: 'feeds:library-extract.v1', ok: true, createdAt: NOW });
    const c = collectors({ ...NONE, hnshow: () => items('hn', 3) });
    const r = await runFeedsJob(deps(db, router(db), c.collectors));
    expect(c.asked.hnshow).toBeUndefined();
    expect(r.bySource.hnshow!.errors).toEqual(['skipped: daily cap reached']);
  });

  it('counts only its own spend (feeds: prompt versions) against the cap', async () => {
    const db = await testDb();
    await db.insert(llmCalls).values({ runId: null, missionId: null, stage: 's', provider: 'p', model: 'm', inputTokens: 0, outputTokens: 0, searchRequests: 0, costUsd: '5', latencyMs: 0, promptVersion: 'library-extract.v1', ok: true, createdAt: NOW });
    expect(await feedsSpentToday(db, NOW)).toBe(0);
  });

  it('does not pay twice for the same items on the next run', async () => {
    const db = await testDb();
    const c = collectors({ ...NONE, hnshow: () => items('hn', 3) });
    const rt = router(db);
    await runFeedsJob(deps(db, rt, c.collectors));
    const first = rt.calls.length;
    const r = await runFeedsJob(deps(db, rt, c.collectors));
    expect(rt.calls.length).toBe(first);
    expect(r.bySource.hnshow!.items).toBe(0);
  });

  it('a failed extraction batch is retried next run (items not marked seen)', async () => {
    const db = await testDb();
    const c = collectors({ ...NONE, hnshow: () => items('hn', 2) });
    await runFeedsJob(deps(db, router(db, { fail: true }), c.collectors));
    expect(await getSetting(db, FEEDS_SEEN_KEY)).toBeNull();
    const r = await runFeedsJob(deps(db, router(db), c.collectors));
    expect(r.bySource.hnshow!.added).toBe(2);
  });

  it('never throws: a broken run is recorded as a warning', async () => {
    const db = await testDb();
    const rt = router(db);
    rt.embed = async () => { throw new Error('embed down'); };
    const c = collectors({ ...NONE, hnshow: () => items('hn', 2) });
    const r = await runFeedsJob(deps(db, rt, c.collectors));
    expect(r.warnings.join('\n')).toContain('failed');
    expect(await getSetting(db, FEEDS_STATS_KEY)).not.toBeNull();
  });

  it('tags its model calls with the feeds: prompt version and no mission or run', async () => {
    const db = await testDb();
    const c = collectors({ ...NONE, hnshow: () => items('hn', 1) });
    await runFeedsJob(deps(db, router(db), c.collectors));
    const calls = await db.select().from(llmCalls).where(eq(llmCalls.stage, 'library_extract'));
    expect(calls.every((x) => x.promptVersion.startsWith('feeds:') && x.missionId === null && x.runId === null)).toBe(true);
  });
});

describe('schedule', () => {
  it('is due when never run, not due before feeds.everyHours (default 6), due after', async () => {
    const db = await testDb();
    expect(await feedsDue(db, NOW)).toBe(true);
    await setSetting(db, FEEDS_LAST_RUN_KEY, new Date(NOW.getTime() - 5 * 3_600_000).toISOString());
    expect(await feedsDue(db, NOW)).toBe(false);
    await setSetting(db, FEEDS_LAST_RUN_KEY, new Date(NOW.getTime() - 6 * 3_600_000).toISOString());
    expect(await feedsDue(db, NOW)).toBe(true);
    await setSetting(db, 'feeds.everyHours', 12);
    expect(await feedsDue(db, NOW)).toBe(false);
  });

  it('runDueFeedsJob skips a recent run (a restart does not re-run early) and runs an old one', async () => {
    const db = await testDb();
    const c = collectors({ ...NONE, hnshow: () => items('hn', 1) });
    expect(await runDueFeedsJob(deps(db, router(db), c.collectors))).not.toBeNull();
    expect(await runDueFeedsJob(deps(db, router(db), c.collectors))).toBeNull(); // lastRun was saved
    expect(c.asked.hnshow).toHaveLength(1);
    const later = new Date(NOW.getTime() + 7 * 3_600_000);
    expect(await runDueFeedsJob(deps(db, router(db), c.collectors, { now: () => later }))).not.toBeNull();
  });

  it('records lastRun before collecting, so a crash mid-run does not loop', async () => {
    const db = await testDb();
    const c = collectors({ ...NONE, reddit: () => { throw new Error('boom'); } });
    await runFeedsJob(deps(db, router(db), c.collectors));
    const [row] = await db.select().from(settings).where(eq(settings.key, FEEDS_LAST_RUN_KEY));
    expect(row?.value).toBe(NOW.toISOString());
  });
});

describe('getFeedRssList', () => {
  it('uses the defaults, or setting feeds.rss (web addresses only, deduplicated)', async () => {
    const db = await testDb();
    expect(await getFeedRssList(db)).toEqual([...DEFAULT_RSS_FEEDS]);
    await setSetting(db, FEEDS_RSS_KEY, ['https://a.example/f', 'https://a.example/f', 'ftp://x', 'javascript:alert(1)', 5]);
    expect(await getFeedRssList(db)).toEqual(['https://a.example/f']);
    await setSetting(db, FEEDS_RSS_KEY, 'not a list');
    expect(await getFeedRssList(db)).toEqual([...DEFAULT_RSS_FEEDS]);
  });
});
