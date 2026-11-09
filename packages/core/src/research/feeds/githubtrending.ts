import { cleanText, type RawItem } from '../../tools/sources/types';
import { requestText, throttle } from '../http';
import { httpOf } from '../sources/federalregister';
import { badResponse, makeItem, MAX_PER_QUERY, type FeedOpts } from './common';

/** GitHub's weekly trending page (HTML; no API exists). `q` is ignored. */
export const sourceType = 'githubtrending';
export const MIN_INTERVAL_MS = 1000;
const HOST = 'github.com';

export async function githubTrendingFeed(_q: string, opts: FeedOpts = {}): Promise<RawItem[]> {
  await throttle(HOST, MIN_INTERVAL_MS, { sleep: opts.sleep });
  const html = await requestText('githubtrending', `https://${HOST}/trending?since=weekly`, { headers: { Accept: 'text/html' } }, httpOf(opts));
  const blocks = html.split(/<article\b/i).slice(1);
  if (blocks.length === 0) throw badResponse('githubtrending', 'page had no repository rows (layout changed?)');
  const out: RawItem[] = [];
  for (const b of blocks) {
    const repo = /<h2[^>]*>[\s\S]*?<a[^>]*href="\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)"/i.exec(b)?.[1];
    if (!repo) continue;
    const desc = cleanText(/<p[^>]*>([\s\S]*?)<\/p>/i.exec(b)?.[1]);
    const lang = cleanText(/itemprop="programmingLanguage"[^>]*>([\s\S]*?)</i.exec(b)?.[1]);
    const stars = /([\d,]+)\s+stars?\s+(?:this week|today|this month)/i.exec(cleanText(b))?.[1];
    const text = `${repo}: ${desc || 'no description'}.${lang ? ` Language: ${lang}.` : ''}${stars ? ` ${stars} stars this week.` : ''}`;
    const it = makeItem(sourceType, `https://${HOST}/${repo}`, repo, text);
    if (it) out.push(it);
    if (out.length >= MAX_PER_QUERY) break;
  }
  return out;
}
