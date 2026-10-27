import { reviewItems } from '../../tools/sources/appstore';
import type { RawItem } from '../../tools/sources/types';
import type { KnowledgeDraft } from '../../library/kinds';
import { request, SourceError, throttle, type HttpOpts } from '../http';

export const sourceType = 'appstore';
export const MIN_INTERVAL_MS = 500;
/** English-language storefronts only. */
export const COUNTRIES = ['us', 'ca', 'gb', 'au', 'nz', 'ie', 'in', 'za', 'sg'] as const;

/** What the iTunes Search API says about the resolved app (price is in the storefront's currency). */
export type AppInfo = {
  trackName?: string;
  price?: number;
  currency?: string;
  formattedPrice?: string;
  primaryGenreName?: string;
  trackViewUrl?: string;
  country?: string;
};

/** A paid app as a structured `pricing` draft (no model call); free or incomplete apps give null. */
export function appPriceToDraft(app: AppInfo): KnowledgeDraft | null {
  const { trackName, price, currency, trackViewUrl } = app;
  if (!trackName || !trackViewUrl || !currency || typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
  let domain = 'apps.apple.com';
  try {
    domain = new URL(trackViewUrl).hostname;
  } catch {
    return null;
  }
  const genre = app.primaryGenreName?.trim() || 'App Store';
  const shown = app.formattedPrice || `${price} ${currency}`;
  return {
    kind: 'pricing',
    title: `${trackName} App Store price`,
    summary: `${trackName} is a paid ${genre} app priced at ${shown} on the App Store.`,
    audience: 'consumer',
    countries: app.country ? [app.country.toUpperCase()] : [],
    industries: app.primaryGenreName ? [app.primaryGenreName.toLowerCase()] : [],
    voice: 'vendor',
    facts: { product: trackName, pricePoints: [{ amount: price, currency, unit: 'one-time' }], buyer: `${genre} app users`, complaints: [] },
    source: { url: trackViewUrl, domain, sourceType, quoteVerified: false, voice: 'vendor' },
  };
}

/** Numeric id, or a search term resolved to the top iTunes match. Low-rated reviews only (existing appstore harvest behaviour). HTTP failures throw SourceError. */
export async function appReviews(
  appIdOrQuery: string,
  opts: { country?: string; limit?: number; onApp?: (app: AppInfo) => void } & HttpOpts = {},
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
    )) as { results?: (AppInfo & { trackId?: number })[] } | null;
    const hit = r?.results?.[0];
    if (!hit?.trackId) return [];
    id = String(hit.trackId);
    opts.onApp?.({
      trackName: hit.trackName, price: hit.price, currency: hit.currency, formattedPrice: hit.formattedPrice,
      primaryGenreName: hit.primaryGenreName, trackViewUrl: hit.trackViewUrl, country,
    });
  }
  await throttle('itunes.apple.com', MIN_INTERVAL_MS, opts);
  const json = await request('appstore', `https://itunes.apple.com/${country}/rss/customerreviews/id=${id}/sortby=mostrecent/json`, {}, opts);
  return reviewItems(json, country, id).slice(0, opts.limit ?? 20);
}
