import type { RawItem } from '../../tools/sources/types';
import { request, throttle } from '../http';
import { httpOf } from '../sources/federalregister';
import { badResponse, list, makeItem, MAX_PER_QUERY, rec, str, type FeedOpts } from './common';

/** Recent Show HN and Ask HN posts from the Algolia API. `q` may be empty (just the newest). Stored as source type `hn`. */
export const sourceType = 'hn';
export const MIN_INTERVAL_MS = 300;
const HOST = 'hn.algolia.com';
const PER_TAG = 13;

export async function hnShowFeed(q: string, opts: FeedOpts = {}): Promise<RawItem[]> {
  const out: RawItem[] = [];
  for (const tag of ['show_hn', 'ask_hn']) {
    const p = new URLSearchParams({ tags: tag, hitsPerPage: String(PER_TAG) });
    if (q.trim()) p.set('query', q.trim());
    await throttle(HOST, MIN_INTERVAL_MS, { sleep: opts.sleep });
    const json = rec(await request('hn', `https://${HOST}/api/v1/search_by_date?${p}`, {}, httpOf(opts)));
    if (!Array.isArray(json.hits)) throw badResponse('hn', 'response had no hits list');
    for (const h of list(json.hits)) {
      const d = rec(h);
      const id = str(d.objectID);
      if (!/^\d{1,12}$/.test(id)) continue;
      const meta = `${tag === 'show_hn' ? 'Show HN' : 'Ask HN'} post, ${Number(d.points) || 0} points, ${Number(d.num_comments) || 0} comments.`;
      const it = makeItem(sourceType, `https://news.ycombinator.com/item?id=${id}`, str(d.title), `${str(d.title)}. ${str(d.story_text)} ${meta}`, str(d.created_at) || null);
      if (it) out.push(it);
    }
  }
  return out.slice(0, MAX_PER_QUERY);
}
