import type { RawItem } from '../../tools/sources/types';
import { request, throttle } from '../http';
import { httpOf } from '../sources/federalregister';
import { badResponse, list, makeItem, MAX_PER_QUERY, rec, str, type FeedOpts } from './common';

/** Reddit's public .json endpoints (no account). At most one request every 2 seconds, with the PitchLab user agent. */
export const sourceType = 'reddit';
export const MIN_INTERVAL_MS = 2000;
const HOST = 'www.reddit.com';
const POSTS = 15;
/** Comments are fetched only for the top few posts of a query. */
export const COMMENT_POSTS = 3;
export const COMMENTS_PER_POST = 10;
const SUB = /^r\/[A-Za-z0-9_]{2,21}$/;

const childrenOf = (j: unknown): Record<string, unknown>[] =>
  list(rec(rec(j).data).children).map((c) => rec(rec(c).data));
/** A comment's permalink (/r/<sub>/comments/<post>/<slug>/<comment>/), not the post's. */
export const isRedditCommentUrl = (url: string): boolean =>
  /^https:\/\/(?:www\.|old\.)?reddit\.com\/r\/[A-Za-z0-9_]+\/comments\/[A-Za-z0-9]+\/[^/]*\/[A-Za-z0-9]+\/?(?:[?#].*)?$/.test(url);
const permalink = (p: unknown): string => (/^\/r\/[A-Za-z0-9_]+\/comments\/[A-Za-z0-9]+\//.test(str(p)) ? `https://${HOST}${str(p)}` : '');

/** `q` is a search query, or `r/<subreddit>` for that subreddit's weekly top. Author fields are never read. */
export async function redditFeed(q: string, opts: FeedOpts = {}): Promise<RawItem[]> {
  const http = httpOf(opts);
  const get = async (path: string): Promise<unknown> => {
    await throttle(HOST, MIN_INTERVAL_MS, { sleep: opts.sleep });
    return request('reddit', `https://${HOST}${path}`, {}, http);
  };
  const listing = SUB.test(q)
    ? await get(`/${q}/top.json?${new URLSearchParams({ t: 'week', limit: String(POSTS), raw_json: '1' })}`)
    : await get(`/search.json?${new URLSearchParams({ q, sort: 'new', t: 'week', limit: String(POSTS), raw_json: '1' })}`);
  if (!Array.isArray(rec(rec(listing).data).children)) throw badResponse('reddit', 'response had no post list');

  const out: RawItem[] = [];
  const top: { id: string; title: string }[] = [];
  for (const d of childrenOf(listing)) {
    const url = permalink(d.permalink);
    const title = str(d.title);
    const it = url && title ? makeItem(sourceType, url, title, str(d.selftext) || title, typeof d.created_utc === 'number' ? d.created_utc : null) : null;
    if (!it) continue;
    out.push(it);
    if (/^[A-Za-z0-9]{3,12}$/.test(str(d.id))) top.push({ id: str(d.id), title: it.title });
  }
  for (const p of top.slice(0, COMMENT_POSTS)) {
    if (out.length >= MAX_PER_QUERY) break;
    const j = await get(`/comments/${p.id}.json?${new URLSearchParams({ limit: String(COMMENTS_PER_POST), depth: '1', sort: 'top', raw_json: '1' })}`);
    if (!Array.isArray(j)) throw badResponse('reddit', 'comments response was not a list');
    for (const d of childrenOf(j[1]).slice(0, COMMENTS_PER_POST)) {
      const url = permalink(d.permalink);
      const it = url ? makeItem(sourceType, url, p.title, str(d.body), typeof d.created_utc === 'number' ? d.created_utc : null) : null;
      if (!it || it.text === it.title) continue;
      out.push(it);
      if (out.length >= MAX_PER_QUERY) break;
    }
  }
  return out.slice(0, MAX_PER_QUERY);
}
