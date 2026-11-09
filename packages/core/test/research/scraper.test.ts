// Scraping-service adapters with fetch mocked (no network, no real key).
import { describe, expect, it, vi } from 'vitest';
import { settings } from '../../src/db/schema';
import {
  buildProviderRequest, createScraperStep, DEFAULT_SCRAPER_MONTHLY_PAGES, PROVIDER_HOSTS, scrapeViaProvider, scraperMonthKey, SCRAPER_PROVIDERS,
} from '../../src/research/scraper';
import { getSetting, setSetting } from '../../src/validation/settings';
import { testDb } from '../helpers/db';

const KEY = 'sk_TEST_SECRET_9f8e7d';
const TARGET = 'https://www.g2.com/products/acme/reviews?page=2&x=a b';
const ARTICLE = `<html><head><title>Acme reviews</title></head><body><article>${Array.from({ length: 20 }, (_, i) => `<p>Review ${i}. ${'The invoicing tool keeps crashing on export. '.repeat(4)}</p>`).join('')}</article></body></html>`;

const htmlRes = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function capture(res: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return res();
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

describe('buildProviderRequest', () => {
  it('ScrapingBee: fixed host, JS rendering, key and target in the query', () => {
    const r = buildProviderRequest('scrapingbee', KEY, TARGET);
    const u = new URL(r.url);
    expect(u.origin).toBe('https://app.scrapingbee.com');
    expect(u.pathname).toBe('/api/v1/');
    expect(u.searchParams.get('api_key')).toBe(KEY);
    expect(u.searchParams.get('url')).toBe(TARGET);
    expect(u.searchParams.get('render_js')).toBe('true');
    expect(r.method).toBe('GET');
  });
  it('ZenRows: fixed host, JS rendering, key and target in the query', () => {
    const r = buildProviderRequest('zenrows', KEY, TARGET);
    const u = new URL(r.url);
    expect(u.origin).toBe('https://api.zenrows.com');
    expect(u.pathname).toBe('/v1/');
    expect(u.searchParams.get('apikey')).toBe(KEY);
    expect(u.searchParams.get('url')).toBe(TARGET);
    expect(u.searchParams.get('js_render')).toBe('true');
  });
  it('Apify: fixed host, key only in the Authorization header, one page with a browser crawler', () => {
    const r = buildProviderRequest('apify', KEY, TARGET);
    const u = new URL(r.url);
    expect(u.origin).toBe('https://api.apify.com');
    expect(u.pathname).toBe('/v2/acts/apify~website-content-crawler/run-sync-get-dataset-items');
    expect(r.url).not.toContain(KEY);
    expect(r.method).toBe('POST');
    expect(r.headers.Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(r.body!);
    expect(body.startUrls).toEqual([{ url: TARGET }]);
    expect(body.maxCrawlPages).toBe(1);
    expect(body.maxCrawlDepth).toBe(0);
    expect(String(body.crawlerType)).toMatch(/^playwright/);
  });
  it('every provider has exactly one fixed host', () => {
    expect(SCRAPER_PROVIDERS).toEqual(['scrapingbee', 'zenrows', 'apify']);
    for (const p of SCRAPER_PROVIDERS) expect(new URL(buildProviderRequest(p, KEY, TARGET).url).hostname).toBe(PROVIDER_HOSTS[p]);
  });
});

describe('scrapeViaProvider', () => {
  it.each(['scrapingbee', 'zenrows'] as const)('%s: returns the page text under the target url', async (provider) => {
    const net = capture(() => htmlRes(ARTICLE));
    const log = vi.fn();
    const r = await scrapeViaProvider(TARGET, { provider, key: KEY, fetch: net.fetch, log });
    expect(r).toMatchObject({ ok: true, status: 200, finalUrl: TARGET, title: 'Acme reviews' });
    expect(r.text).toContain('keeps crashing on export');
    expect(net.calls).toHaveLength(1);
    expect(new URL(net.calls[0]!.url).hostname).toBe(PROVIDER_HOSTS[provider]);
    expect(net.calls[0]!.init.redirect).toBe('manual');
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
  });

  it('apify: reads the dataset item text and title', async () => {
    const net = capture(() => jsonRes([{ url: TARGET, text: 'Acme review text '.repeat(80), metadata: { title: 'Acme reviews' } }]));
    const r = await scrapeViaProvider(TARGET, { provider: 'apify', key: KEY, fetch: net.fetch });
    expect(r).toMatchObject({ ok: true, finalUrl: TARGET, title: 'Acme reviews' });
    expect(r.text).toContain('Acme review text');
    expect(net.calls[0]!.url).not.toContain(KEY);
  });

  it('a provider error is a failed page; the key never appears in the result or the log', async () => {
    for (const status of [401, 403, 429, 500]) {
      const net = capture(() => htmlRes(`bad key ${KEY}`, status));
      const log = vi.fn();
      const r = await scrapeViaProvider(TARGET, { provider: 'scrapingbee', key: KEY, fetch: net.fetch, log });
      expect(r).toMatchObject({ ok: false, reason: 'http_error', status, finalUrl: TARGET });
      expect(JSON.stringify(r)).not.toContain(KEY);
      expect(JSON.stringify(log.mock.calls)).not.toContain(KEY);
    }
    const thrower = vi.fn(async (u: string) => { throw new Error(`connect failed ${u}`); });
    const log = vi.fn();
    const r = await scrapeViaProvider(TARGET, { provider: 'zenrows', key: KEY, fetch: thrower as never, log });
    expect(r).toMatchObject({ ok: false, reason: 'network' });
    expect(JSON.stringify([r, log.mock.calls])).not.toContain(KEY);
  });

  it('refuses banned, never-fetch, IP-literal and non-http targets without calling the provider', async () => {
    const net = capture(() => htmlRes(ARTICLE));
    for (const u of ['https://www.bing.com/search?q=x', 'https://gamersgetaway.ca/', 'https://shop.gamersgetaway.ca/x', 'http://127.0.0.1/', 'http://10.0.0.5/admin', 'file:///etc/passwd', 'not a url', 'http://localhost:8080/', 'https://x.internal/admin', 'http://intranet/']) {
      expect(await scrapeViaProvider(u, { provider: 'scrapingbee', key: KEY, fetch: net.fetch })).toMatchObject({ ok: false, reason: 'blocked_host' });
    }
    expect(net.calls).toHaveLength(0);
  });

  it('drops a page the provider says ended on a banned or never-fetch host', async () => {
    const net = capture(() => htmlRes(ARTICLE, 200, { 'spb-resolved-url': 'https://gamersgetaway.ca/landing' }));
    expect(await scrapeViaProvider(TARGET, { provider: 'scrapingbee', key: KEY, fetch: net.fetch })).toMatchObject({ ok: false, reason: 'blocked_host' });
    const z = capture(() => htmlRes(ARTICLE, 200, { 'zr-final-url': 'https://www.bing.com/x' }));
    expect(await scrapeViaProvider(TARGET, { provider: 'zenrows', key: KEY, fetch: z.fetch })).toMatchObject({ ok: false, reason: 'blocked_host' });
  });
});

describe('createScraperStep', () => {
  const NOW = new Date('2026-11-09T12:00:00Z');

  it('the month key', () => {
    expect(scraperMonthKey(NOW)).toBe('fetch.scraperPages.2026-11');
    expect(scraperMonthKey(new Date('2027-01-31T23:59:59Z'))).toBe('fetch.scraperPages.2027-01');
    expect(DEFAULT_SCRAPER_MONTHLY_PAGES).toBe(900);
  });

  it('skips (not configured) without a provider or a key and calls nothing', async () => {
    const db = await testDb();
    const net = capture(() => htmlRes(ARTICLE));
    for (const cfg of [{}, { provider: 'scrapingbee' as const }, { key: KEY }]) {
      const step = createScraperStep({ db, ...cfg, fetch: net.fetch, now: () => NOW });
      expect(step.configured).toBe(false);
      expect(await step.scrape(TARGET)).toEqual({ skipped: 'not_configured' });
    }
    expect(net.calls).toHaveLength(0);
  });

  it('counts each provider page against the month and stops at the budget', async () => {
    const db = await testDb();
    await setSetting(db, 'fetch.scraperMonthlyPages', 2);
    const net = capture(() => htmlRes(ARTICLE));
    const log = vi.fn();
    const step = createScraperStep({ db, provider: 'zenrows', key: KEY, fetch: net.fetch, now: () => NOW, log });
    expect(step.configured).toBe(true);
    expect(await step.scrape(TARGET)).toMatchObject({ ok: true });
    expect(await step.scrape(TARGET)).toMatchObject({ ok: true });
    expect(await step.scrape(TARGET)).toEqual({ skipped: 'budget' });
    expect(net.calls).toHaveLength(2);
    expect(await getSetting(db, 'fetch.scraperPages.2026-11')).toBe(2);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/scraper.*monthly/i));
    // Nothing secret is stored in settings.
    expect(JSON.stringify(await db.select().from(settings))).not.toContain(KEY);
  });

  it('uses the default 900 pages and a fresh count each month', async () => {
    const db = await testDb();
    await setSetting(db, 'fetch.scraperPages.2026-11', 900);
    const net = capture(() => htmlRes(ARTICLE));
    const nov = createScraperStep({ db, provider: 'scrapingbee', key: KEY, fetch: net.fetch, now: () => NOW });
    expect(await nov.scrape(TARGET)).toEqual({ skipped: 'budget' });
    const dec = createScraperStep({ db, provider: 'scrapingbee', key: KEY, fetch: net.fetch, now: () => new Date('2026-12-01T00:00:01Z') });
    expect(await dec.scrape(TARGET)).toMatchObject({ ok: true });
    expect(await getSetting(db, 'fetch.scraperPages.2026-12')).toBe(1);
  });

  it('a refused target does not spend budget', async () => {
    const db = await testDb();
    const net = capture(() => htmlRes(ARTICLE));
    const step = createScraperStep({ db, provider: 'scrapingbee', key: KEY, fetch: net.fetch, now: () => NOW });
    expect(await step.scrape('https://gamersgetaway.ca/')).toMatchObject({ ok: false, reason: 'blocked_host' });
    expect(await getSetting(db, 'fetch.scraperPages.2026-11')).toBeNull();
  });
});
