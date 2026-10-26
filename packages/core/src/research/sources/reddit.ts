import { cleanText, toDate, type RawItem } from '../../tools/sources/types';
import { request, SourceError, throttle, type HttpOpts } from '../http';

export const sourceType = 'reddit';
export const MIN_INTERVAL_MS = 1000;
const UA = 'pitchlab-research/0.1';
const COMMENT_POSTS = 3;
const COMMENTS_PER_POST = 3;

let token: { clientId: string; value: string; expiresAt: number } | null = null;
let warnedNoKeys = false;
export function resetRedditState(): void {
  token = null;
  warnedNoKeys = false;
}

export interface RedditOpts extends HttpOpts {
  clientId?: string;
  clientSecret?: string;
  limit?: number;
}

async function getToken(id: string, secret: string, opts: RedditOpts): Promise<string> {
  const now = (opts.now ?? Date.now)();
  if (token && token.clientId === id && token.expiresAt > now + 30_000) return token.value;
  await throttle('www.reddit.com', MIN_INTERVAL_MS, opts);
  const json = (await request(
    'reddit',
    'https://www.reddit.com/api/v1/access_token',
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${id}:${secret}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
      },
      body: 'grant_type=client_credentials',
    },
    opts,
  )) as { access_token?: string; expires_in?: number };
  if (!json?.access_token) throw new SourceError('auth', 'reddit');
  token = { clientId: id, value: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 };
  return token.value;
}

interface Child {
  data?: { id?: string; title?: string; selftext?: string; body?: string; permalink?: string; created_utc?: number };
}
const children = (j: unknown): Child[] => ((j as { data?: { children?: Child[] } })?.data?.children ?? []) as Child[];

/** Posts plus their top comments. Author fields are never read. */
export async function redditSearch(q: string, opts: RedditOpts = {}): Promise<RawItem[]> {
  if (!opts.clientId || !opts.clientSecret) {
    if (!warnedNoKeys) {
      warnedNoKeys = true;
      console.warn('[source:reddit] no REDDIT_CLIENT_ID/SECRET set; skipping');
    }
    return [];
  }
  const limit = opts.limit ?? 10;
  const tk = await getToken(opts.clientId, opts.clientSecret, opts);
  const headers = { Authorization: `Bearer ${tk}`, 'User-Agent': UA };
  const call = async (url: string) => {
    await throttle('oauth.reddit.com', MIN_INTERVAL_MS, opts);
    try {
      return await request('reddit', url, { headers }, opts);
    } catch (e) {
      if (e instanceof SourceError && e.code === 'auth') token = null; // expired or revoked: re-authenticate next time
      throw e;
    }
  };
  const search = await call(
    `https://oauth.reddit.com/search?q=${encodeURIComponent(q)}&sort=relevance&limit=${limit}&type=link&raw_json=1`,
  );
  const out: RawItem[] = [];
  const posts: string[] = [];
  for (const c of children(search)) {
    const d = c.data;
    if (!d?.permalink || !d.title) continue;
    out.push({
      source: 'reddit',
      url: `https://www.reddit.com${d.permalink}`,
      title: cleanText(d.title),
      text: cleanText(d.selftext) || cleanText(d.title),
      publishedAt: toDate(d.created_utc),
    });
    if (d.id) posts.push(d.id);
  }
  for (const id of posts.slice(0, COMMENT_POSTS)) {
    const j = await call(
      `https://oauth.reddit.com/comments/${encodeURIComponent(id)}?limit=${COMMENTS_PER_POST}&depth=1&sort=top&raw_json=1`,
    );
    const parent = out.find((o) => o.url.includes(`/comments/${id}/`));
    for (const c of children(Array.isArray(j) ? j[1] : null).slice(0, COMMENTS_PER_POST)) {
      const d = c.data;
      const text = cleanText(d?.body);
      if (!d?.permalink || !text) continue;
      out.push({
        source: 'reddit',
        url: `https://www.reddit.com${d.permalink}`,
        title: parent?.title ?? '',
        text,
        publishedAt: toDate(d.created_utc),
      });
    }
  }
  return out;
}
