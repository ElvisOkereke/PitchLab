import type { RawItem } from '../../tools/sources/types';
import { requestText, throttle } from '../http';
import { httpOf } from '../sources/federalregister';
import { badResponse, makeItem, MAX_PER_QUERY, type FeedOpts } from './common';
import { parseFeed, type FeedEntry } from './rss';

/**
 * Reddit's public Atom feeds (no account). Reddit answers its public .json endpoints with 403 to logged-out clients,
 * but still serves .rss; those are rate limited hard, so at most one request every 6 seconds.
 */
export const sourceType = 'reddit';
export const MIN_INTERVAL_MS = 6000;
const HOST = 'www.reddit.com';
const POSTS = 15;
/** Comments are fetched only for the top few posts of a query. */
export const COMMENT_POSTS = 3;
export const COMMENTS_PER_POST = 10;
const SUB = /^r\/[A-Za-z0-9_]{2,21}$/;
const POST_URL = /^https:\/\/(?:www\.|old\.)?reddit\.com\/r\/[A-Za-z0-9_]+\/comments\/([A-Za-z0-9]{1,12})\/[^/?#]*\/?(?:[?#].*)?$/;

/** A comment's permalink (/r/<sub>/comments/<post>/<slug>/<comment>/), not the post's. */
export const isRedditCommentUrl = (url: string): boolean =>
  /^https:\/\/(?:www\.|old\.)?reddit\.com\/r\/[A-Za-z0-9_]+\/comments\/[A-Za-z0-9]+\/[^/]*\/[A-Za-z0-9]+\/?(?:[?#].*)?$/.test(url);

/** Reddit's links, normalised to www.reddit.com over https; anything else is dropped. */
function redditUrl(v: string): string {
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' || !/^(?:www\.|old\.)?reddit\.com$/.test(u.hostname)) return '';
    return `https://${HOST}${u.pathname}`;
  } catch {
    return '';
  }
}

/** The entry body without Reddit's "submitted by /u/name [link] [comments]" footer or any /u/ handle. */
function bodyOf(e: FeedEntry): string {
  return e.text
    .replace(/(?:&#32;|\s)*submitted by[\s\S]*$/i, '')
    .replace(/&#32;/g, ' ')
    .replace(/(?:^|\s)\/?u\/[A-Za-z0-9_-]{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `q` is a search query, or `r/<subreddit>` for that subreddit's weekly top. Author fields are never read. */
export async function redditFeed(q: string, opts: FeedOpts = {}): Promise<RawItem[]> {
  const http = httpOf(opts);
  const get = async (path: string): Promise<FeedEntry[]> => {
    await throttle(HOST, MIN_INTERVAL_MS, { sleep: opts.sleep });
    const xml = await requestText('reddit', `https://${HOST}${path}`, { headers: { Accept: 'application/atom+xml' }, maxBytes: 1_500_000 }, http);
    return parseFeed('reddit', xml);
  };
  const entries = SUB.test(q)
    ? await get(`/${q}/top/.rss?${new URLSearchParams({ t: 'week', limit: String(POSTS) })}`)
    : await get(`/search.rss?${new URLSearchParams({ q, sort: 'new', t: 'week', limit: String(POSTS) })}`);

  const out: RawItem[] = [];
  const top: { id: string; title: string }[] = [];
  for (const e of entries) {
    const url = redditUrl(e.url);
    const m = POST_URL.exec(url);
    if (!m || !e.title) continue;
    const it = makeItem(sourceType, url, e.title, bodyOf(e) || e.title, e.published);
    if (!it) continue;
    out.push(it);
    top.push({ id: m[1]!, title: it.title });
  }
  if (entries.length && !out.length) throw badResponse('reddit', 'feed had no posts');
  for (const p of top.slice(0, COMMENT_POSTS)) {
    if (out.length >= MAX_PER_QUERY) break;
    const comments = await get(`/comments/${p.id}/.rss?${new URLSearchParams({ limit: String(COMMENTS_PER_POST), depth: '1', sort: 'top' })}`);
    let n = 0;
    for (const e of comments) {
      const url = redditUrl(e.url);
      if (!isRedditCommentUrl(url)) continue; // the feed's first entry is the post itself
      const it = makeItem(sourceType, url, p.title, bodyOf(e), e.published);
      if (!it || !it.text || it.text === it.title) continue;
      out.push(it);
      if (++n >= COMMENTS_PER_POST || out.length >= MAX_PER_QUERY) break;
    }
  }
  return out.slice(0, MAX_PER_QUERY);
}
