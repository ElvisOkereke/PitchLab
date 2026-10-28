import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '../../../src/db/client';
import { claims, knowledgeItems, knowledgeSources, signals } from '../../../src/db/schema';
import { upsertKnowledgeItem } from '../../../src/library/store';
import { runMaintenance } from '../../../src/maintenance';
import { resetThrottle } from '../../../src/research/http';
import {
  MAX_SEARCHES_PER_DAY, MAX_UNITS_PER_DAY, pacificDate, reserveQuota, YOUTUBE_QUOTA_WARNING, YOUTUBE_RATE_WARNING, youtubeSearch, type YoutubeState,
} from '../../../src/research/sources/youtube';
import { getSetting, setSetting } from '../../../src/validation/settings';
import { insertCase, insertIdea, insertRun, testDb, unit } from '../../helpers/db';
import { defaultRunConfig } from '../../../src/pipeline/types';

const NOW = new Date('2026-10-28T20:00:00Z'); // 13:00 Pacific, 28 Oct
const KEY = 'AIzaSECRETKEY123';
const DAY = 86_400_000;

type Route = { body: unknown; status?: number };
function api(routes: (path: string, params: URLSearchParams) => Route) {
  const calls: { path: string; params: URLSearchParams; url: string }[] = [];
  const impl = (async (u: string | URL | Request) => {
    const url = new URL(String(u));
    const path = url.pathname.replace('/youtube/v3/', '');
    calls.push({ path, params: url.searchParams, url: String(u) });
    const r = routes(path, url.searchParams);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}
const quotaErr = (reason: string) => ({ status: 403, body: { error: { code: 403, errors: [{ reason, domain: 'youtube.quota' }] } } });

const VIDEOS = [
  { id: 'vid00000001', title: 'Why invoicing hurts small shops', description: 'We talk about chasing unpaid invoices every week.', publishedAt: '2026-09-01T00:00:00Z' },
  { id: 'vid00000002', title: 'Quoting jobs by hand', description: 'A how-to on quoting for crews.', publishedAt: '2026-09-02T00:00:00Z' },
];
const comment = (text: string) => ({
  id: 'Ugx_COMMENT_ID',
  snippet: {
    videoId: 'x', canReplyDirectly: true, totalReplyCount: 0,
    topLevelComment: {
      id: 'Ugx_COMMENT_ID',
      snippet: {
        textDisplay: text, textOriginal: text, authorDisplayName: 'Jane Plumber', authorChannelId: { value: 'UC_SECRET_CHANNEL' },
        authorProfileImageUrl: 'https://yt3.example/jane.jpg', authorChannelUrl: 'http://www.youtube.com/channel/UC_SECRET_CHANNEL',
        publishedAt: '2026-09-03T00:00:00Z',
      },
    },
  },
});

function happyRoutes(over: Partial<Record<string, (p: URLSearchParams) => Route>> = {}) {
  return (path: string, p: URLSearchParams): Route => {
    if (over[path]) return over[path]!(p);
    if (path === 'search') return { body: { items: VIDEOS.map((v) => ({ id: { kind: 'youtube#video', videoId: v.id }, snippet: { channelTitle: 'Chan', title: 'x' } })) } };
    if (path === 'videos') {
      const ids = (p.get('id') ?? '').split(',');
      return { body: { items: VIDEOS.filter((v) => ids.includes(v.id)).map((v) => ({ id: v.id, snippet: { title: v.title, description: v.description, publishedAt: v.publishedAt, channelTitle: 'Chan', channelId: 'UC_SECRET_CHANNEL' } })) } };
    }
    if (path === 'commentThreads') {
      const v = p.get('videoId')!;
      return { body: { items: [comment(`Chasing unpaid invoices takes me six hours every week (${v}).`), comment(`I quote jobs by hand and lose bids (${v}).`)] } };
    }
    return { status: 404, body: {} };
  };
}

let db: Db;
beforeEach(async () => {
  resetThrottle();
  db = await testDb();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const opts = (f: typeof fetch, extra: Record<string, unknown> = {}) => ({ apiKey: KEY, db, fetch: f, now: () => NOW.getTime(), sleep: async () => {}, ...extra });

describe('youtubeSearch mapping', () => {
  it('returns the title/description plus one item per comment, plain video URLs, no author fields', async () => {
    const a = api(happyRoutes());
    const items = await youtubeSearch('invoicing pain', opts(a.impl, { regionCode: 'US' }));
    expect(items).toHaveLength(2 * 3); // per video: title+description, 2 comments
    expect(items.every((i) => i.source === 'youtube')).toBe(true);
    expect(new Set(items.map((i) => i.url))).toEqual(new Set(VIDEOS.map((v) => `https://www.youtube.com/watch?v=${v.id}`)));
    const meta = items.find((i) => i.url.endsWith('vid00000001') && i.text.includes('chasing unpaid invoices every week'))!;
    expect(meta.title).toBe(VIDEOS[0]!.title);
    expect(meta.text).toContain('Why invoicing hurts');
    expect(meta.publishedAt).toEqual(new Date('2026-09-01T00:00:00Z'));
    const comments = items.filter((i) => i.url.endsWith('vid00000002'));
    expect(comments.map((c) => c.text)).toContain('Chasing unpaid invoices takes me six hours every week (vid00000002).');
    const dump = JSON.stringify(items);
    for (const bad of ['Jane Plumber', 'UC_SECRET_CHANNEL', 'jane.jpg', 'Chan"', 'Ugx_COMMENT_ID', '&lc=']) expect(dump).not.toContain(bad);
  });

  it('calls search, videos (batched) and commentThreads with the documented parameters', async () => {
    const a = api(happyRoutes());
    await youtubeSearch('invoicing pain', opts(a.impl, { regionCode: 'CA', maxVideos: 2, commentsPerVideo: 50 }));
    expect(a.calls.map((c) => c.path)).toEqual(['search', 'videos', 'commentThreads', 'commentThreads']);
    const [s, v, c] = a.calls;
    expect(a.calls.every((x) => x.url.startsWith('https://www.googleapis.com/youtube/v3/'))).toBe(true);
    expect(s!.params.get('part')).toBe('snippet');
    expect(s!.params.get('type')).toBe('video');
    expect(s!.params.get('q')).toBe('invoicing pain');
    expect(s!.params.get('maxResults')).toBe('2');
    expect(s!.params.get('relevanceLanguage')).toBe('en');
    expect(s!.params.get('regionCode')).toBe('CA');
    expect(s!.params.get('key')).toBe(KEY);
    expect(v!.params.get('id')).toBe('vid00000001,vid00000002');
    expect(c!.params.get('order')).toBe('relevance');
    expect(c!.params.get('textFormat')).toBe('plainText');
    expect(c!.params.get('maxResults')).toBe('50');
    expect(c!.params.get('videoId')).toBe('vid00000001');
  });

  it('does not send a malformed regionCode', async () => {
    const a = api(happyRoutes());
    await youtubeSearch('q', opts(a.impl, { regionCode: 'canada?x=1' }));
    expect(a.calls[0]!.params.has('regionCode')).toBe(false);
  });

  it('without a key it returns [] and makes no request', async () => {
    const a = api(happyRoutes());
    expect(await youtubeSearch('q', { db, fetch: a.impl })).toEqual([]);
    expect(a.calls).toHaveLength(0);
    expect(await getSetting(db, `youtube.quota.${pacificDate(new Date())}`)).toBeNull();
  });

  it('errors never carry the key', async () => {
    const a = api(() => ({ status: 500, body: {} }));
    const err = await youtubeSearch('q', opts(a.impl)).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain(KEY);
    expect(JSON.stringify(err)).not.toContain(KEY);
  });
});

describe('quota guard', () => {
  it('keys the counter by Pacific date', () => {
    expect(pacificDate(new Date('2026-10-28T06:30:00Z'))).toBe('2026-10-27'); // 23:30 PDT the day before
    expect(pacificDate(new Date('2026-10-28T08:00:00Z'))).toBe('2026-10-28');
    expect(pacificDate(new Date('2026-12-01T07:59:00Z'))).toBe('2026-11-30'); // PST
  });

  it('counts a search, then the follow-up calls', async () => {
    const a = api(happyRoutes());
    await youtubeSearch('q', opts(a.impl));
    // 1 search; units: videos 1 + 2 comment calls
    expect(await getSetting(db, 'youtube.quota.2026-10-28')).toEqual({ searchCalls: 1, units: 3 });
  });

  it('stops at 90 searches a day without calling', async () => {
    await setSetting(db, 'youtube.quota.2026-10-28', { searchCalls: MAX_SEARCHES_PER_DAY, units: 10 });
    const a = api(happyRoutes());
    const warns: string[] = [];
    const state: YoutubeState = { searches: 0, stopped: false };
    expect(await youtubeSearch('q', opts(a.impl, { state, onWarn: (w: string) => warns.push(w) }))).toEqual([]);
    expect(a.calls).toHaveLength(0);
    expect(warns).toEqual([YOUTUBE_QUOTA_WARNING]);
    expect(state.stopped).toBe(true);
    expect(await getSetting(db, 'youtube.quota.2026-10-28')).toEqual({ searchCalls: MAX_SEARCHES_PER_DAY, units: 10 });
  });

  it('stops when the units cap is near, before searching', async () => {
    await setSetting(db, 'youtube.quota.2026-10-28', { searchCalls: 1, units: MAX_UNITS_PER_DAY - 3 });
    const a = api(happyRoutes());
    const warns: string[] = [];
    expect(await youtubeSearch('q', opts(a.impl, { onWarn: (w: string) => warns.push(w) }))).toEqual([]);
    expect(a.calls).toHaveLength(0);
    expect(warns).toEqual([YOUTUBE_QUOTA_WARNING]);
  });

  it('never lets the units counter pass the cap', async () => {
    await setSetting(db, 'youtube.quota.2026-10-28', { searchCalls: 1, units: MAX_UNITS_PER_DAY - 7 });
    const a = api(happyRoutes());
    await youtubeSearch('q', opts(a.impl, { maxVideos: 2 }));
    await youtubeSearch('q', opts(a.impl, { maxVideos: 2 }));
    const s = (await getSetting(db, 'youtube.quota.2026-10-28')) as { units: number };
    expect(s.units).toBeLessThanOrEqual(MAX_UNITS_PER_DAY);
  });

  it('allows at most 5 searches per mission, silently', async () => {
    const a = api(happyRoutes());
    const state: YoutubeState = { searches: 0, stopped: false };
    const warns: string[] = [];
    for (let i = 0; i < 7; i++) await youtubeSearch(`q${i}`, opts(a.impl, { state, onWarn: (w: string) => warns.push(w), maxVideos: 1 }));
    expect(a.calls.filter((c) => c.path === 'search')).toHaveLength(5);
    expect(warns).toEqual([]);
    expect(((await getSetting(db, 'youtube.quota.2026-10-28')) as { searchCalls: number }).searchCalls).toBe(5);
  });

  it('failed searches count toward the per-mission cap and the day bucket', async () => {
    const a = api(happyRoutes({ search: () => ({ status: 500, body: {} }) }));
    const state: YoutubeState = { searches: 0, stopped: false };
    for (let i = 0; i < 7; i++) await youtubeSearch(`q${i}`, opts(a.impl, { state, maxVideos: 1 })).catch(() => {});
    expect(a.calls.filter((c) => c.path === 'search')).toHaveLength(5);
    expect(((await getSetting(db, 'youtube.quota.2026-10-28')) as { searchCalls: number }).searchCalls).toBe(5);
  });

  it('rateLimitExceeded and 429 stop with a rate-limit warning, not the daily-quota one', async () => {
    for (const route of [() => quotaErr('rateLimitExceeded'), () => ({ status: 429, body: {} })]) {
      const a = api(happyRoutes({ videos: route }));
      const warns: string[] = [];
      const state: YoutubeState = { searches: 0, stopped: false };
      expect(await youtubeSearch('q', opts(a.impl, { state, onWarn: (w: string) => warns.push(w) }))).toEqual([]);
      expect(warns).toEqual([YOUTUBE_RATE_WARNING]);
      expect(YOUTUBE_RATE_WARNING).toBe('YouTube rate limit reached');
      expect(state.stopped).toBe(true);
    }
  });

  it('one failed commentThreads call skips that video and keeps the rest', async () => {
    const a = api(happyRoutes({
      commentThreads: (p) => (p.get('videoId') === 'vid00000001' ? { status: 500, body: {} } : { body: { items: [comment('Quoting jobs by hand loses us bids every month.')] } }),
    }));
    const warns: string[] = [];
    const items = await youtubeSearch('q', opts(a.impl, { onWarn: (w: string) => warns.push(w) }));
    expect(warns).toEqual([]);
    expect(items.filter((i) => i.url.endsWith('vid00000001'))).toHaveLength(1);
    expect(items.filter((i) => i.url.endsWith('vid00000002'))).toHaveLength(2);
  });

  it('quotaExceeded on commentThreads still stops and keeps what was gathered', async () => {
    const a = api(happyRoutes({ commentThreads: () => quotaErr('quotaExceeded') }));
    const warns: string[] = [];
    const items = await youtubeSearch('q', opts(a.impl, { onWarn: (w: string) => warns.push(w) }));
    expect(warns).toEqual([YOUTUBE_QUOTA_WARNING]);
    expect(items).toHaveLength(2);
  });

  it('a new Pacific day starts a fresh counter', async () => {
    await setSetting(db, 'youtube.quota.2026-10-27', { searchCalls: MAX_SEARCHES_PER_DAY, units: MAX_UNITS_PER_DAY });
    const a = api(happyRoutes());
    expect((await youtubeSearch('q', opts(a.impl))).length).toBeGreaterThan(0);
  });

  it('increments atomically under concurrent reservations', async () => {
    await setSetting(db, 'youtube.quota.2026-10-28', { searchCalls: 80, units: 0 });
    const results = await Promise.all(Array.from({ length: 25 }, () => reserveQuota(db, { searches: 1, units: 0 }, NOW)));
    expect(results.filter(Boolean)).toHaveLength(10);
    expect(await getSetting(db, 'youtube.quota.2026-10-28')).toEqual({ searchCalls: 90, units: 0 });
    const units = await Promise.all(Array.from({ length: 12 }, () => reserveQuota(db, { searches: 0, units: 1000 }, NOW)));
    expect(units.filter(Boolean)).toHaveLength(9);
    expect(await getSetting(db, 'youtube.quota.2026-10-28')).toEqual({ searchCalls: 90, units: 9000 });
  });

  it('a first reservation of the day creates the counter row', async () => {
    expect(await reserveQuota(db, { searches: 1, units: 0 }, NOW)).toBe(true);
    expect(await getSetting(db, 'youtube.quota.2026-10-28')).toEqual({ searchCalls: 1, units: 0 });
  });

  it('403 quotaExceeded stops YouTube for the mission with one warning, counters stay correct', async () => {
    const a = api(happyRoutes({ videos: () => quotaErr('quotaExceeded') }));
    const state: YoutubeState = { searches: 0, stopped: false };
    const warns: string[] = [];
    const o = opts(a.impl, { state, onWarn: (w: string) => warns.push(w) });
    expect(await youtubeSearch('q1', o)).toEqual([]);
    expect(warns).toEqual([YOUTUBE_QUOTA_WARNING]);
    expect(state.stopped).toBe(true);
    const before = a.calls.length;
    expect(await youtubeSearch('q2', o)).toEqual([]);
    expect(a.calls).toHaveLength(before); // no more requests this mission
    expect(warns).toHaveLength(1);
    expect(await getSetting(db, 'youtube.quota.2026-10-28')).toEqual({ searchCalls: 1, units: 1 });
  });

  it('403 quotaExceeded on search also stops', async () => {
    const a = api(happyRoutes({ search: () => quotaErr('quotaExceeded') }));
    const warns: string[] = [];
    expect(await youtubeSearch('q', opts(a.impl, { onWarn: (w: string) => warns.push(w) }))).toEqual([]);
    expect(warns).toEqual([YOUTUBE_QUOTA_WARNING]);
  });

  it('comments disabled on one video skips it quietly', async () => {
    const a = api(happyRoutes({
      commentThreads: (p) => (p.get('videoId') === 'vid00000001' ? quotaErr('commentsDisabled') : { body: { items: [comment('Quoting jobs by hand loses us bids every month.')] } }),
    }));
    const warns: string[] = [];
    const items = await youtubeSearch('q', opts(a.impl, { onWarn: (w: string) => warns.push(w) }));
    expect(warns).toEqual([]);
    expect(items.filter((i) => i.url.endsWith('vid00000001'))).toHaveLength(1); // title/description only
    expect(items.filter((i) => i.url.endsWith('vid00000002'))).toHaveLength(2);
  });

  it('other API failures throw (the mission warns per source) without the key', async () => {
    const a = api(happyRoutes({ videos: () => ({ status: 500, body: {} }) }));
    await expect(youtubeSearch('q', opts(a.impl))).rejects.toThrow(/youtube/);
  });
});

describe('30-day expiry end to end', () => {
  const YT_URL = 'https://www.youtube.com/watch?v=vid00000001';
  const draftFor = (quote: string) => ({
    kind: 'problem' as const, title: 'Chasing invoices', summary: 'Owner chases invoices', quote, audience: 'business' as const,
    countries: ['US'], industries: ['trades'], voice: 'operator' as const, facts: { persona: 'plumber' },
    source: { url: YT_URL, domain: 'www.youtube.com', sourceType: 'youtube', quote, quoteVerified: true },
  });

  it('collect, store with expiresAt, advance 31 days, maintenance removes the source and entry and redacts signals and claims', async () => {
    const a = api(happyRoutes());
    const items = await youtubeSearch('invoicing', opts(a.impl, { maxVideos: 1 }));
    const text = items.find((i) => i.text.startsWith('Chasing unpaid'))!.text;
    const stored = await upsertKnowledgeItem(db, draftFor(text), unit(1), { now: NOW });
    const [src] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.itemId, stored.itemId));
    expect(src!.sourceType).toBe('youtube');
    expect(src!.expiresAt!.getTime()).toBe(NOW.getTime() + 30 * DAY);
    expect(src!.fetchedAt.getTime()).toBe(NOW.getTime());

    const [sig] = await db.insert(signals).values({
      marketId: 'ca-us', source: 'youtube', url: YT_URL, title: 'Why invoicing hurts', quote: text, quoteHash: 'yt1',
      knowledgeItemId: stored.itemId, embedding: unit(2), createdAt: NOW,
    }).returning();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', ideaCount: 1, advanceCount: 1 }));
    const kase = await insertCase(db, (await insertIdea(db, run.id)).id, { createdAt: NOW });
    await db.insert(claims).values({ caseId: kase.id, section: 's', text: 't', sourceUrl: YT_URL, quote: text });

    // Day 29: nothing yet.
    const early = await runMaintenance(db, new Date(NOW.getTime() + 29 * DAY));
    expect(early).toMatchObject({ expiredSources: 0, deletedItems: 0, redactedSignals: 0, redactedClaims: 0 });

    const r = await runMaintenance(db, new Date(NOW.getTime() + 31 * DAY));
    expect(r).toMatchObject({ expiredSources: 1, deletedItems: 1, redactedSignals: 1, redactedClaims: 1, errors: [] });
    expect(await db.select().from(knowledgeSources)).toHaveLength(0);
    expect(await db.select().from(knowledgeItems)).toHaveLength(0);
    const s2 = (await db.select().from(signals).where(eq(signals.id, sig!.id)))[0]!;
    expect(s2.quote).toBe('[expired YouTube data]');
    expect(s2.knowledgeItemId).toBeNull();
    const c2 = (await db.select().from(claims))[0]!;
    expect(c2.quote).toBeNull();
  });

  it('a signal promoted 29 days after the fetch, and a claim on a case written then, are redacted at fetch + 31 days', async () => {
    const q = 'Chasing unpaid invoices takes me six hours every week for real.';
    const stored = await upsertKnowledgeItem(db, draftFor(q), unit(1), { now: NOW });
    const day29 = new Date(NOW.getTime() + 29 * DAY);
    const [sig] = await db.insert(signals).values({
      marketId: 'ca-us', source: 'youtube', url: YT_URL, title: 'Why invoicing hurts', quote: q, quoteHash: 'yt29',
      knowledgeItemId: stored.itemId, embedding: unit(2), createdAt: day29,
    }).returning();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', ideaCount: 1, advanceCount: 1 }));
    const kase = await insertCase(db, (await insertIdea(db, run.id)).id, { createdAt: day29 });
    await db.insert(claims).values({ caseId: kase.id, section: 'signal', text: 't', sourceUrl: YT_URL, quote: q });

    expect(await runMaintenance(db, new Date(NOW.getTime() + 29.5 * DAY))).toMatchObject({ redactedSignals: 0, redactedClaims: 0 });
    const r = await runMaintenance(db, new Date(NOW.getTime() + 31 * DAY));
    expect(r).toMatchObject({ expiredSources: 1, redactedSignals: 1, redactedClaims: 1, errors: [] });
    expect((await db.select().from(signals).where(eq(signals.id, sig!.id)))[0]!.quote).toBe('[expired YouTube data]');
    expect((await db.select().from(claims))[0]).toMatchObject({ quote: null, reviewNote: 'YouTube quote removed (YouTube data is kept for at most 30 days)' });
  });

  it('re-collecting the same video with a different comment does not refresh the stored comment\'s expiry', async () => {
    const qA = 'Chasing unpaid invoices takes me six hours every week for real.';
    const qB = 'A different comment on the same video about late payers.';
    const first = await upsertKnowledgeItem(db, draftFor(qA), unit(1), { now: NOW });
    const d = draftFor(qA);
    const again = await upsertKnowledgeItem(db, { ...d, source: { ...d.source, quote: qB } }, unit(1), { now: new Date(NOW.getTime() + 20 * DAY) });
    expect(again.itemId).toBe(first.itemId);
    const [src] = await db.select().from(knowledgeSources);
    expect(src!.quote).toBe(qA);
    expect(src!.fetchedAt.getTime()).toBe(NOW.getTime());
    expect(src!.expiresAt!.getTime()).toBe(NOW.getTime() + 30 * DAY);
  });

  it('an unverified-to-verified upgrade of the same video takes the new comment and restarts its 30 days', async () => {
    const q = 'Chasing unpaid invoices takes me six hours every week for real.';
    const d = draftFor(q);
    await upsertKnowledgeItem(db, { ...d, source: { ...d.source, quote: 'not verbatim', quoteVerified: false } }, unit(1), { now: NOW });
    const later = new Date(NOW.getTime() + 20 * DAY);
    await upsertKnowledgeItem(db, d, unit(1), { now: later });
    const [src] = await db.select().from(knowledgeSources);
    expect(src).toMatchObject({ quote: q, quoteVerified: true });
    expect(src!.expiresAt!.getTime()).toBe(later.getTime() + 30 * DAY);
  });

  it('re-collecting refreshes fetchedAt and expiresAt, so the source survives past the first expiry', async () => {
    const q = 'Chasing unpaid invoices takes me six hours every week for real.';
    const first = await upsertKnowledgeItem(db, draftFor(q), unit(1), { now: NOW });
    const later = new Date(NOW.getTime() + 20 * DAY);
    const again = await upsertKnowledgeItem(db, draftFor(q), unit(1), { now: later });
    expect(again.itemId).toBe(first.itemId);
    const [src] = await db.select().from(knowledgeSources);
    expect(src!.fetchedAt.getTime()).toBe(later.getTime());
    expect(src!.expiresAt!.getTime()).toBe(later.getTime() + 30 * DAY);
    const r = await runMaintenance(db, new Date(NOW.getTime() + 31 * DAY));
    expect(r.expiredSources).toBe(0);
    expect(await db.select().from(knowledgeSources)).toHaveLength(1);
  });

  it('non-YouTube sources keep expiresAt null and an unchanged fetchedAt on re-collect', async () => {
    const q = 'A hn quote that is long enough to count.';
    const d = { ...draftFor(q), source: { url: 'https://news.example/1', domain: 'news.example', sourceType: 'hn', quote: q, quoteVerified: true } };
    await upsertKnowledgeItem(db, d, unit(1), { now: NOW });
    await upsertKnowledgeItem(db, d, unit(1), { now: new Date(NOW.getTime() + 20 * DAY) });
    const [src] = await db.select().from(knowledgeSources);
    expect(src!.expiresAt).toBeNull();
    expect(src!.fetchedAt.getTime()).toBe(NOW.getTime());
  });
});
