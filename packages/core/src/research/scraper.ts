import type { Db } from '../db/client';
import { isBannedSource } from '../tools/banned-sources';
import { extract, HTML_MAX_BYTES, type PageResult } from '../tools/fetch-page';
import { getSetting, setSetting } from '../validation/settings';
import { request, requestText, SourceError } from './http';

/**
 * Commercial scraping services, the third escalation step (after the direct fetch and the real browser): the provider
 * loads the page from its own network with JavaScript rendering. Used only when SCRAPER_PROVIDER and SCRAPER_API_KEY are
 * both set. The key goes only into the provider request (query or header, as each provider documents); it is never
 * logged, stored, put in an error or returned. Requests go through the fixed-host request helper, one fixed host per
 * provider, and the target must pass isBannedSource first (never-fetch hosts, banned domains and IP literals refused).
 */
export const SCRAPER_PROVIDERS = ['scrapingbee', 'zenrows', 'apify'] as const;
export type ScraperProvider = (typeof SCRAPER_PROVIDERS)[number];

export const PROVIDER_HOSTS: Record<ScraperProvider, string> = {
  scrapingbee: 'app.scrapingbee.com',
  zenrows: 'api.zenrows.com',
  apify: 'api.apify.com',
};

/** Default monthly page budget (setting `fetch.scraperMonthlyPages`); fits the providers' free tiers. */
export const DEFAULT_SCRAPER_MONTHLY_PAGES = 900;
export const SCRAPER_MONTHLY_PAGES_KEY = 'fetch.scraperMonthlyPages';
/** JS rendering is slow: the provider gets up to two minutes per page. */
const SCRAPE_TIMEOUT_MS = 120_000;
const MAX_BYTES = 4_000_000;
const SOURCE = 'scraper';
/** Apify's general-purpose crawler, run synchronously for one page with a real browser. */
const APIFY_ACTOR = 'apify~website-content-crawler';

export type ProviderRequest = { url: string; method: 'GET' | 'POST'; headers: Record<string, string>; body?: string };

/** The provider's documented endpoint for one page with JavaScript rendering. Pure; the key is placed only here. */
export function buildProviderRequest(provider: ScraperProvider, key: string, target: string): ProviderRequest {
  switch (provider) {
    case 'scrapingbee': {
      const u = new URL(`https://${PROVIDER_HOSTS.scrapingbee}/api/v1/`);
      u.searchParams.set('api_key', key);
      u.searchParams.set('url', target);
      u.searchParams.set('render_js', 'true');
      return { url: u.href, method: 'GET', headers: { Accept: 'text/html,*/*;q=0.1' } };
    }
    case 'zenrows': {
      const u = new URL(`https://${PROVIDER_HOSTS.zenrows}/v1/`);
      u.searchParams.set('apikey', key);
      u.searchParams.set('url', target);
      u.searchParams.set('js_render', 'true');
      return { url: u.href, method: 'GET', headers: { Accept: 'text/html,*/*;q=0.1' } };
    }
    case 'apify':
      return {
        url: `https://${PROVIDER_HOSTS.apify}/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items`,
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ startUrls: [{ url: target }], maxCrawlPages: 1, maxCrawlDepth: 0, crawlerType: 'playwright:firefox' }),
      };
  }
}

/** The provider's report of where the page ended up, if it gives one. */
const RESOLVED_HEADERS = ['spb-resolved-url', 'zr-final-url'];

const failed = (target: string, reason: NonNullable<PageResult['reason']>, status = 0): PageResult => ({ ok: false, status, finalUrl: target, title: '', text: '', reason });

/** A provider error as a failed page. SourceError messages carry only the source name and status (never the url or key). */
function fromError(target: string, e: unknown): PageResult {
  if (!(e instanceof SourceError)) return failed(target, 'network');
  if (e.code === 'rate_limited') return failed(target, 'http_error', 429);
  if (e.code === 'auth' || e.code === 'http_error') {
    const status = Number(/HTTP (\d{3})/.exec(e.message)?.[1] ?? 0);
    return failed(target, 'http_error', status || (e.code === 'auth' ? 401 : 500));
  }
  if (e.code === 'bad_response') return failed(target, /too large/.test(e.message) ? 'too_large' : 'network');
  return failed(target, /timed out/.test(e.message) ? 'timeout' : 'network');
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * One page through the provider, as a PageResult under the target's own address (the provider never becomes the
 * source). Never throws; failures are `{ ok: false }` with a reason. `log` gets short messages without the key or url.
 */
export async function scrapeViaProvider(
  target: string,
  o: { provider: ScraperProvider; key: string; fetch?: typeof fetch; log?: (m: string) => void },
): Promise<PageResult> {
  if (isBannedSource(target)) return failed(target, 'blocked_host');
  const req = buildProviderRequest(o.provider, o.key, target);
  const http = { fetch: o.fetch };
  try {
    if (o.provider === 'apify') {
      const items = await request(SOURCE, req.url, { method: req.method, headers: req.headers, body: req.body, timeoutMs: SCRAPE_TIMEOUT_MS, maxBytes: MAX_BYTES }, http);
      const first = rec(Array.isArray(items) ? items[0] : null);
      const text = typeof first.text === 'string' ? first.text.trim() : '';
      const title = typeof rec(first.metadata).title === 'string' ? String(rec(first.metadata).title).trim() : '';
      const landed = typeof first.url === 'string' ? first.url : target;
      if (isBannedSource(landed)) return failed(target, 'blocked_host');
      return { ok: true, status: 200, finalUrl: target, title, text };
    }
    const landed: { url: string | null } = { url: null };
    const html = await requestText(SOURCE, req.url, {
      headers: req.headers, timeoutMs: SCRAPE_TIMEOUT_MS, maxBytes: MAX_BYTES,
      onHeaders: (h) => { landed.url = RESOLVED_HEADERS.map((n) => h.get(n)).find((v): v is string => !!v) ?? null; },
    }, http);
    if (landed.url !== null && isBannedSource(landed.url)) return failed(target, 'blocked_host');
    const { title, text } = extract(html);
    return { ok: true, status: 200, finalUrl: target, title, text, html: html.length > HTML_MAX_BYTES ? html.slice(0, HTML_MAX_BYTES) : html };
  } catch (e) {
    const r = fromError(target, e);
    o.log?.(`scraper: ${o.provider} request failed (${r.status ? `HTTP ${r.status}` : r.reason})${r.status === 401 || r.status === 403 ? ', check SCRAPER_API_KEY' : ''}`);
    return r;
  }
}

/** The settings key that counts this month's provider pages (UTC month). */
export function scraperMonthKey(now: Date): string {
  return `fetch.scraperPages.${now.toISOString().slice(0, 7)}`;
}

export type ScrapeSkipped = { skipped: 'not_configured' | 'budget' };
export type ScraperStep = { configured: boolean; scrape(url: string): Promise<PageResult | ScrapeSkipped> };

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/**
 * The scraping step for collectPage: skips when the provider or key is missing, or when this month's page budget
 * (`fetch.scraperMonthlyPages`, default 900) is used up. Each provider request counts one page in
 * `fetch.scraperPages.<YYYY-MM>`, before it is sent (a failed page still costs a request). A target refused before
 * sending costs nothing. The worker runs one mission at a time, so a read-then-write count is enough.
 */
export function createScraperStep(o: {
  db: Db; provider?: ScraperProvider; key?: string; fetch?: typeof fetch; now?: () => Date; log?: (m: string) => void;
}): ScraperStep {
  const { db, provider, key } = o;
  const now = o.now ?? (() => new Date());
  const log = o.log ?? (() => {});
  let warnedBudget = false;
  if (!provider || !key) return { configured: false, scrape: async () => ({ skipped: 'not_configured' }) };
  return {
    configured: true,
    async scrape(url) {
      if (isBannedSource(url)) return failed(url, 'blocked_host');
      const monthKey = scraperMonthKey(now());
      const limitRaw = await getSetting(db, SCRAPER_MONTHLY_PAGES_KEY);
      const limit = typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw >= 0 ? Math.floor(limitRaw) : DEFAULT_SCRAPER_MONTHLY_PAGES;
      const used = count(await getSetting(db, monthKey));
      if (used >= limit) {
        if (!warnedBudget) log(`scraper: monthly page budget of ${limit} used up, skipped until next month`);
        warnedBudget = true;
        return { skipped: 'budget' };
      }
      await setSetting(db, monthKey, used + 1);
      return scrapeViaProvider(url, { provider, key, fetch: o.fetch, log });
    },
  };
}
