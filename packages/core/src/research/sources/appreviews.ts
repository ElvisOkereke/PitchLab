import { reviewItems } from '../../tools/sources/appstore';
import type { RawItem } from '../../tools/sources/types';
import { request, SourceError, throttle, type HttpOpts } from '../http';

export const sourceType = 'appstore';
export const MIN_INTERVAL_MS = 500;
/** English-language storefronts only. */
export const COUNTRIES = ['us', 'ca', 'gb', 'au', 'nz', 'ie', 'in', 'za', 'sg'] as const;

/** Numeric id, or a search term resolved to the top iTunes match. Low-rated reviews only (existing appstore harvest behaviour). HTTP failures throw SourceError. */
export async function appReviews(
  appIdOrQuery: string,
  opts: { country?: string; limit?: number } & HttpOpts = {},
): Promise<RawItem[]> {
  const country = (opts.country ?? 'us').toLowerCase();
  if (!(COUNTRIES as readonly string[]).includes(country)) throw new SourceError('bad_response', 'appstore', 'appstore: unsupported country');
  let id = appIdOrQuery.trim();
  if (!/^\d+$/.test(id)) {
    await throttle('itunes.apple.com', MIN_INTERVAL_MS, opts);
    const r = (await request(
      'appstore',
      `https://itunes.apple.com/search?term=${encodeURIComponent(id)}&entity=software&country=${country}&limit=1`,
      {},
      opts,
    )) as { results?: { trackId?: number }[] } | null;
    const found = r?.results?.[0]?.trackId;
    if (!found) return [];
    id = String(found);
  }
  await throttle('itunes.apple.com', MIN_INTERVAL_MS, opts);
  const json = await request('appstore', `https://itunes.apple.com/${country}/rss/customerreviews/id=${id}/sortby=mostrecent/json`, {}, opts);
  return reviewItems(json, country, id).slice(0, opts.limit ?? 20);
}
