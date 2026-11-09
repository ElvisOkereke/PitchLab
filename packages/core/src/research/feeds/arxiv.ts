import type { RawItem } from '../../tools/sources/types';
import { requestText, throttle } from '../http';
import { httpOf } from '../sources/federalregister';
import { MAX_PER_QUERY, makeItem, type FeedOpts } from './common';
import { parseFeed } from './rss';

/** New arXiv papers for a capability query (Atom). arXiv asks for one request every 3 seconds. Author fields are never read. */
export const sourceType = 'arxiv';
export const MIN_INTERVAL_MS = 3000;
const HOST = 'export.arxiv.org';

/** `all:word AND all:word` for the first few words of the query (arXiv's own query syntax). */
export function arxivQuery(q: string): string {
  const words = q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1).slice(0, 5);
  return words.map((w) => `all:${w}`).join(' AND ');
}

export async function arxivFeed(q: string, opts: FeedOpts = {}): Promise<RawItem[]> {
  const search = arxivQuery(q);
  if (!search) return [];
  const p = new URLSearchParams({ search_query: search, sortBy: 'submittedDate', sortOrder: 'descending', max_results: String(MAX_PER_QUERY) });
  await throttle(HOST, MIN_INTERVAL_MS, { sleep: opts.sleep });
  const xml = await requestText('arxiv', `https://${HOST}/api/query?${p}`, { headers: { Accept: 'application/atom+xml' } }, httpOf(opts));
  const out: RawItem[] = [];
  for (const e of parseFeed('arxiv', xml)) {
    const m = /^https?:\/\/arxiv\.org\/abs\/([A-Za-z0-9./-]{3,40})$/.exec(e.url);
    const it = m ? makeItem(sourceType, `https://arxiv.org/abs/${m[1]}`, e.title, `${e.title}. ${e.text}`, e.published) : null;
    if (it) out.push(it);
    if (out.length >= MAX_PER_QUERY) break;
  }
  return out;
}
