import type { RawItem } from '../../tools/sources/types';
import { request, throttle } from '../http';
import { httpOf } from '../sources/federalregister';
import { badResponse, list, makeItem, MAX_PER_QUERY, rec, str, type FeedOpts } from './common';

/** Trending models and spaces on Hugging Face. `q` is ignored (the lists are global). */
export const sourceType = 'huggingface';
export const MIN_INTERVAL_MS = 500;
const HOST = 'huggingface.co';
const ID = /^[A-Za-z0-9][\w.-]{0,95}(\/[\w.-]{1,96})?$/;

export async function huggingFaceFeed(_q: string, opts: FeedOpts = {}): Promise<RawItem[]> {
  const out: RawItem[] = [];
  for (const kind of ['models', 'spaces'] as const) {
    await throttle(HOST, MIN_INTERVAL_MS, { sleep: opts.sleep });
    const json = await request('huggingface', `https://${HOST}/api/${kind}?${new URLSearchParams({ sort: 'trendingScore', limit: '15' })}`, {}, httpOf(opts));
    if (!Array.isArray(json)) throw badResponse('huggingface', `${kind} response was not a list`);
    for (const r of list(json)) {
      const d = rec(r);
      const id = str(d.id) || str(d.modelId);
      if (!ID.test(id)) continue;
      const tags = list(d.tags).filter((t): t is string => typeof t === 'string').slice(0, 8).join(', ');
      const what = kind === 'models' ? `model${str(d.pipeline_tag) ? ` for ${str(d.pipeline_tag)}` : ''}` : `space${str(d.sdk) ? ` (${str(d.sdk)})` : ''}`;
      const stats = [Number(d.likes) ? `${Number(d.likes)} likes` : '', Number(d.downloads) ? `${Number(d.downloads)} downloads` : ''].filter(Boolean).join(', ');
      const it = makeItem(sourceType, `https://${HOST}/${kind === 'spaces' ? 'spaces/' : ''}${id}`, id,
        `${id}: trending Hugging Face ${what}.${tags ? ` Tags: ${tags}.` : ''}${stats ? ` ${stats}.` : ''}`, str(d.createdAt) || null);
      if (it) out.push(it);
    }
  }
  return out.slice(0, MAX_PER_QUERY);
}
