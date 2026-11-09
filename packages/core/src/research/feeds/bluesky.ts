import type { RawItem } from '../../tools/sources/types';
import { request, SourceError, throttle } from '../http';
import { httpOf } from '../sources/federalregister';
import { badResponse, list, makeItem, MAX_PER_QUERY, rec, str, type FeedOpts } from './common';

/** Bluesky post search through the public AppView; a session is created only when it answers 401/403 and credentials are set. */
export const sourceType = 'bluesky';
export const MIN_INTERVAL_MS = 500;
const PUBLIC = 'https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts';
const PDS = 'https://bsky.social/xrpc/';
const URI = /^at:\/\/(did:[a-z]+:[A-Za-z0-9._:%-]+)\/app\.bsky\.feed\.post\/([A-Za-z0-9]+)$/;
const MIN_TEXT = 30;

export interface BlueskyOpts extends FeedOpts {
  handle?: string;
  appPassword?: string;
}

let session: { handle: string; jwt: string } | null = null;
export function resetBlueskyState(): void {
  session = null;
}

async function login(handle: string, password: string, opts: BlueskyOpts): Promise<string> {
  if (session && session.handle === handle) return session.jwt;
  await throttle('bsky.social', MIN_INTERVAL_MS, { sleep: opts.sleep });
  // The password goes only in the request body; request() never echoes bodies, headers or URLs into its errors.
  const json = rec(await request('bluesky', `${PDS}com.atproto.server.createSession`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: handle, password }),
  }, httpOf(opts)));
  const jwt = str(json.accessJwt);
  if (!jwt) throw new SourceError('auth', 'bluesky', 'bluesky: sign-in failed');
  session = { handle, jwt };
  return jwt;
}

const isAuth = (e: unknown): boolean => e instanceof SourceError && e.code === 'auth';

export async function blueskyFeed(q: string, opts: BlueskyOpts = {}): Promise<RawItem[]> {
  const qs = new URLSearchParams({ q, limit: String(MAX_PER_QUERY), sort: 'latest' });
  const http = httpOf(opts);
  let json: unknown;
  await throttle('public.api.bsky.app', MIN_INTERVAL_MS, { sleep: opts.sleep });
  try {
    json = await request('bluesky', `${PUBLIC}?${qs}`, {}, http);
  } catch (e) {
    if (!isAuth(e)) throw e;
    if (!opts.handle || !opts.appPassword) {
      throw new SourceError('auth', 'bluesky', 'bluesky: search needs sign-in (set BLUESKY_HANDLE and BLUESKY_APP_PASSWORD)');
    }
    const jwt = await login(opts.handle, opts.appPassword, opts);
    await throttle('bsky.social', MIN_INTERVAL_MS, { sleep: opts.sleep });
    try {
      json = await request('bluesky', `${PDS}app.bsky.feed.searchPosts?${qs}`, { headers: { Authorization: `Bearer ${jwt}` } }, http);
    } catch (e2) {
      if (isAuth(e2)) session = null; // expired or revoked: sign in again next time
      throw e2;
    }
  }
  if (!Array.isArray(rec(json).posts)) throw badResponse('bluesky', 'response had no post list');
  const out: RawItem[] = [];
  for (const p of list(rec(json).posts)) {
    const m = URI.exec(str(rec(p).uri));
    const record = rec(rec(p).record);
    const text = str(record.text);
    if (!m || text.length < MIN_TEXT) continue;
    // The url carries the author's did, never the handle; no author field is read.
    const it = makeItem(sourceType, `https://bsky.app/profile/${m[1]}/post/${m[2]}`, '', text, str(record.createdAt) || null);
    if (it) out.push(it);
    if (out.length >= MAX_PER_QUERY) break;
  }
  return out;
}
