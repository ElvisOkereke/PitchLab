import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { cleanText, toDate, type RawItem } from '../../tools/sources/types';
import { request, SourceError, type HttpOpts } from '../http';

/**
 * YouTube Data API v3 (official API only, key from YOUTUBE_API_KEY). Video titles and descriptions plus top-level
 * comments become raw items. Author fields (display name, channel id and url, avatar) are never read, and the item url
 * is the plain video url (no comment id).
 *
 * Quota guard: a per-Pacific-day counter in `settings` (`youtube.quota.<date>`), updated by one atomic statement.
 * Searches stop at 90 a day (their own 100/day bucket), other calls at 9,000 units a day, and a mission runs at most 5
 * searches. Calls are counted when reserved (before the request), so a failed or cancelled call still counts.
 * YouTube data may be kept for 30 days: the library store sets `expires_at` and maintenance deletes and redacts.
 */

export const sourceType = 'youtube';
export const MAX_SEARCHES_PER_DAY = 90;
export const MAX_UNITS_PER_DAY = 9000;
export const MAX_SEARCHES_PER_MISSION = 5;
export const YOUTUBE_QUOTA_WARNING = 'YouTube daily quota reached';
export const YOUTUBE_RATE_WARNING = 'YouTube rate limit reached';
const BASE = 'https://www.googleapis.com/youtube/v3/';
const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;
/** Lighter than the API maximum (100): in a mixed-source mission YouTube comments crowded the startup sources out of the evidence. */
export const DEFAULT_COMMENTS_PER_VIDEO = 40;
const REGION = /^[A-Za-z]{2}$/;
const DAILY_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded']);
const RATE_REASONS = new Set(['rateLimitExceeded']);

/** Per-mission state: how many searches it ran, and whether YouTube is switched off for the rest of it. */
export type YoutubeState = { searches: number; stopped: boolean };

export interface YoutubeOpts extends HttpOpts {
  apiKey?: string;
  regionCode?: string;
  maxVideos?: number;
  commentsPerVideo?: number;
  db: Db;
  /** For the caller's own bookkeeping (data calls are attributed through `onCall`). */
  missionId?: string;
  state?: YoutubeState;
  onWarn?: (w: string) => void;
}

/** The Pacific calendar day (YYYY-MM-DD) the YouTube quota resets on. */
export function pacificDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/**
 * Atomically reserves quota for today (Pacific): one INSERT .. ON CONFLICT DO UPDATE .. WHERE .. RETURNING, so two
 * concurrent callers can never both pass the cap. `headroom` units must remain free after this reservation (a search
 * needs room for the calls that follow it). Returns whether the reservation was made.
 */
export async function reserveQuota(db: Db, n: { searches: number; units: number; headroom?: number }, now: Date): Promise<boolean> {
  const key = `youtube.quota.${pacificDate(now)}`;
  const headroom = n.headroom ?? 0;
  const fresh = JSON.stringify({ searchCalls: n.searches, units: n.units });
  const rows = await db.execute(sql`
    insert into settings (key, value) values (${key}, ${fresh}::jsonb)
    on conflict (key) do update set value = jsonb_build_object(
      'searchCalls', (settings.value->>'searchCalls')::int + ${n.searches}::int,
      'units', (settings.value->>'units')::int + ${n.units}::int)
    where (settings.value->>'searchCalls')::int + ${n.searches}::int <= ${MAX_SEARCHES_PER_DAY}::int
      and (settings.value->>'units')::int + ${n.units}::int + ${headroom}::int <= ${MAX_UNITS_PER_DAY}::int
    returning key`);
  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
  return list.length > 0;
}

type Thing = Record<string, unknown>;
const arr = (v: unknown): Thing[] => (Array.isArray(v) ? (v as Thing[]) : []);
const obj = (v: unknown): Thing => (v && typeof v === 'object' ? (v as Thing) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Video titles and descriptions plus top comments for one query. Returns [] without a key (no request). */
export async function youtubeSearch(q: string, opts: YoutubeOpts): Promise<RawItem[]> {
  if (!opts.apiKey) return [];
  const state = opts.state ?? { searches: 0, stopped: false };
  if (state.stopped) return [];
  if (state.searches >= MAX_SEARCHES_PER_MISSION) return [];
  const now = () => new Date((opts.now ?? Date.now)());
  const maxVideos = Math.min(Math.max(opts.maxVideos ?? 5, 1), 50);
  const perVideo = Math.min(Math.max(opts.commentsPerVideo ?? DEFAULT_COMMENTS_PER_VIDEO, 1), 100);
  const key = opts.apiKey;

  const stop = (warning: string) => {
    if (!state.stopped) {
      state.stopped = true;
      opts.onWarn?.(warning);
    }
  };
  /** One counted API call. Throws QuotaStop when the guard refuses or the API says the quota is gone. */
  const call = async (endpoint: string, params: Record<string, string>, units: { searches: number; units: number; headroom?: number }) => {
    if (!(await reserveQuota(opts.db, units, now()))) throw new QuotaStop(YOUTUBE_QUOTA_WARNING);
    if (endpoint === 'search') state.searches++; // counted once reserved, so failed or cancelled searches still use the cap
    const qs = new URLSearchParams({ ...params, key });
    try {
      return await request('youtube', `${BASE}${endpoint}?${qs}`, { errorReason: true }, opts);
    } catch (e) {
      if (e instanceof SourceError) {
        if (e.reason !== undefined && DAILY_REASONS.has(e.reason)) throw new QuotaStop(YOUTUBE_QUOTA_WARNING);
        if (e.code === 'rate_limited' || (e.reason !== undefined && RATE_REASONS.has(e.reason))) throw new QuotaStop(YOUTUBE_RATE_WARNING);
      }
      throw e;
    }
  };

  const out: RawItem[] = [];
  try {
    const search = await call('search', {
      part: 'snippet', type: 'video', q, maxResults: String(maxVideos), relevanceLanguage: 'en',
      ...(opts.regionCode && REGION.test(opts.regionCode) ? { regionCode: opts.regionCode.toUpperCase() } : {}),
    }, { searches: 1, units: 0, headroom: 1 + maxVideos });
    const ids = [...new Set(arr(obj(search).items).map((i) => str(obj(i.id).videoId)).filter((id) => VIDEO_ID.test(id)))].slice(0, maxVideos);
    if (ids.length === 0) return out;

    const videos = await call('videos', { part: 'snippet', id: ids.join(',') }, { searches: 0, units: 1 });
    const found: { id: string; title: string; publishedAt: Date | null }[] = [];
    for (const v of arr(obj(videos).items)) {
      const id = str(v.id);
      if (!VIDEO_ID.test(id)) continue;
      const sn = obj(v.snippet);
      const title = cleanText(str(sn.title));
      const description = cleanText(str(sn.description));
      const publishedAt = toDate(str(sn.publishedAt));
      found.push({ id, title, publishedAt });
      const text = [title, description].filter(Boolean).join('\n\n');
      if (text) out.push({ source: sourceType, url: `https://www.youtube.com/watch?v=${id}`, title, text, publishedAt });
    }

    for (const v of found) {
      let threads: unknown;
      try {
        threads = await call('commentThreads', {
          part: 'snippet', videoId: v.id, maxResults: String(perVideo), order: 'relevance', textFormat: 'plainText',
        }, { searches: 0, units: 1 });
      } catch (e) {
        if (e instanceof QuotaStop) throw e;
        continue; // commentsDisabled, a 500 or any other failure: skip this video, keep what was gathered
      }
      for (const t of arr(obj(threads).items)) {
        // Only the comment text and its date are read; every author field is left alone.
        const sn = obj(obj(obj(t.snippet).topLevelComment).snippet);
        const text = cleanText(str(sn.textOriginal) || str(sn.textDisplay));
        if (!text) continue;
        out.push({ source: sourceType, url: `https://www.youtube.com/watch?v=${v.id}`, title: v.title, text, publishedAt: toDate(str(sn.publishedAt)) ?? v.publishedAt });
      }
    }
    return out;
  } catch (e) {
    if (e instanceof QuotaStop) {
      stop(e.warning);
      return out;
    }
    throw e;
  }
}

class QuotaStop extends Error {
  constructor(readonly warning: string) {
    super(warning);
  }
}
