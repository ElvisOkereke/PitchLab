import { createAppStoreSource } from '../../tools/sources/appstore';
import { getJson, type RawItem } from '../../tools/sources/types';
import { throttle, type HttpOpts } from '../http';

export const sourceType = 'appstore';
export const MIN_INTERVAL_MS = 500;

/** Numeric id, or a search term resolved to the top iTunes match. Low-rated reviews only (existing appstore harvest behaviour). */
export async function appReviews(
  appIdOrQuery: string,
  opts: { country?: string; limit?: number } & Pick<HttpOpts, 'fetch' | 'sleep' | 'now'> = {},
): Promise<RawItem[]> {
  const country = (opts.country ?? 'us').toLowerCase();
  let id = appIdOrQuery.trim();
  if (!/^\d+$/.test(id)) {
    await throttle('itunes.apple.com', MIN_INTERVAL_MS, opts);
    const r = (await getJson(
      'appstore',
      `https://itunes.apple.com/search?term=${encodeURIComponent(id)}&entity=software&country=${country}&limit=1`,
      opts.fetch,
    )) as { results?: { trackId?: number }[] } | null;
    const found = r?.results?.[0]?.trackId;
    if (!found) return [];
    id = String(found);
  }
  await throttle('itunes.apple.com', MIN_INTERVAL_MS, opts);
  return createAppStoreSource({ countries: [country] }).search(id, { limit: opts.limit ?? 20, fetchImpl: opts.fetch });
}
