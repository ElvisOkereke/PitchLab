import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../../src/config/env';
import {
  buildSources,
  createAppStoreSource,
  createGithubSource,
  createHnSource,
  createStackExchangeSource,
  createWordpressSource,
  DEFAULT_WP_SLUGS,
} from '../../src/tools/sources';
import { cleanText } from '../../src/tools/sources/types';

const fx = (name: string) =>
  readFileSync(new URL(`../helpers/fixtures/sources/${name}`, import.meta.url), 'utf8');

function fakeFetch(body: string, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status });
  }) as typeof fetch;
  return { impl, calls };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('cleanText', () => {
  it('strips tags and decodes entities', () => {
    expect(cleanText('<p>a &amp; b &lt;c&gt; &quot;d&quot; &#x27;e&#39;</p>')).toBe(`a & b <c> "d" 'e'`);
  });
});

describe('hn', () => {
  it('maps hits to items', async () => {
    const { impl, calls } = fakeFetch(fx('hn.json'));
    const items = await createHnSource().search('late invoices', { limit: 10, fetchImpl: impl });
    expect(items).toHaveLength(3);
    expect(items[0].url).toBe('https://news.ycombinator.com/item?id=111');
    expect(items[0].text).toBe('We lose hours every week on manual invoicing & chasing late payments.');
    expect(items[1].text).toBe(`No-shows cost our clinic 'thousands' a month.`);
    expect(items[2].text).toBe('Show HN: A spreadsheet tool');
    expect(items[0].publishedAt).toEqual(new Date('2026-03-01T10:00:00.000Z'));
    expect(calls[0].url).toContain('query=late%20invoices');
    expect(calls[0].url).toContain('hitsPerPage=10');
  });
  it('respects limit', async () => {
    const items = await createHnSource().search('x', { limit: 2, fetchImpl: fakeFetch(fx('hn.json')).impl });
    expect(items).toHaveLength(2);
  });
  it('returns [] and warns on 500', async () => {
    const items = await createHnSource().search('x', { limit: 5, fetchImpl: fakeFetch('err', 500).impl });
    expect(items).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('hn'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('500'));
  });
  it('returns [] on thrown fetch and bad JSON', async () => {
    const boom = (async () => {
      throw new Error('net down');
    }) as typeof fetch;
    expect(await createHnSource().search('x', { limit: 5, fetchImpl: boom })).toEqual([]);
    expect(await createHnSource().search('x', { limit: 5, fetchImpl: fakeFetch('not json').impl })).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('stackexchange', () => {
  it('queries each site, merges, builds urls', async () => {
    const { impl, calls } = fakeFetch(fx('stackexchange.json'));
    const src = createStackExchangeSource({ key: 'k1', sites: ['webmasters', 'wordpress'] });
    const items = await src.search('lost leads', { limit: 10, fetchImpl: impl });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('site=webmasters');
    expect(calls[1].url).toContain('site=wordpress');
    expect(calls[0].url).toContain('key=k1');
    expect(items).toHaveLength(4);
    expect(items[0].url).toBe('https://webmasters.stackexchange.com/q/1001');
    expect(items[2].url).toBe('https://wordpress.stackexchange.com/q/1001');
    expect(items[0].text).toBe('Customers say our contact form emails never arrive & we lose leads');
    expect(items[0].publishedAt).toEqual(new Date(1772000000 * 1000));
  });
  it('truncates to limit and omits key when unset', async () => {
    const { impl, calls } = fakeFetch(fx('stackexchange.json'));
    const items = await createStackExchangeSource().search('q', { limit: 3, fetchImpl: impl });
    expect(calls).toHaveLength(3);
    expect(calls[0].url).not.toContain('key=');
    expect(items).toHaveLength(3);
  });
  it('returns [] and warns on 500', async () => {
    const items = await createStackExchangeSource().search('q', { limit: 3, fetchImpl: fakeFetch('', 500).impl });
    expect(items).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stackexchange'));
  });
});

describe('github', () => {
  it('maps issues and sends bearer token', async () => {
    const { impl, calls } = fakeFetch(fx('github.json'));
    const items = await createGithubSource({ token: 'tok' }).search('manual invoicing', { limit: 5, fetchImpl: impl });
    expect(items).toHaveLength(2);
    expect(items[0].url).toBe('https://github.com/acme/billing/issues/12');
    expect(items[0].text).toBe('We waste <hours> each week reconciling invoices manually.');
    expect(items[1].text).toBe('No export for leads');
    expect(calls[0].url).toContain('q=manual%20invoicing+is:issue');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
  it('omits auth without token; truncates body to 2000 chars', async () => {
    const big = JSON.stringify({ items: [{ html_url: 'u', title: 't', body: 'a'.repeat(5000) }] });
    const { impl, calls } = fakeFetch(big);
    const items = await createGithubSource().search('q', { limit: 5, fetchImpl: impl });
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(items[0].text).toHaveLength(2000);
  });
  it('returns [] and warns on 500', async () => {
    expect(await createGithubSource().search('q', { limit: 5, fetchImpl: fakeFetch('', 500).impl })).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('github'));
  });
});

describe('wordpress', () => {
  it('parses RSS items using query as slug', async () => {
    const { impl, calls } = fakeFetch(fx('wordpress.xml'));
    const items = await createWordpressSource().search('contact-form-7', { limit: 10, fetchImpl: impl });
    expect(calls[0].url).toBe('https://wordpress.org/support/plugin/contact-form-7/feed/');
    expect(items).toHaveLength(2);
    expect(items[0].url).toBe('https://wordpress.org/support/topic/emails-not-being-sent/');
    expect(items[0].title).toBe('Emails not being sent');
    expect(items[0].text).toBe('Our form stopped sending & we are losing customers.');
    expect(items[0].publishedAt).toEqual(new Date('Mon, 02 Mar 2026 10:00:00 +0000'));
  });
  it('handles a single item and respects limit', async () => {
    const one = '<rss><channel><item><title>T</title><link>L</link><description>D</description></item></channel></rss>';
    expect(await createWordpressSource().search('s', { limit: 5, fetchImpl: fakeFetch(one).impl })).toHaveLength(1);
    const items = await createWordpressSource().search('s', { limit: 1, fetchImpl: fakeFetch(fx('wordpress.xml')).impl });
    expect(items).toHaveLength(1);
  });
  it('exports default slugs', () => {
    expect(DEFAULT_WP_SLUGS).toContain('contact-form-7');
    expect(DEFAULT_WP_SLUGS).toHaveLength(7);
  });
  it('returns [] on 500 and on non-RSS body', async () => {
    expect(await createWordpressSource().search('s', { limit: 5, fetchImpl: fakeFetch('', 500).impl })).toEqual([]);
    expect(await createWordpressSource().search('s', { limit: 5, fetchImpl: fakeFetch('<html></html>').impl })).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('appstore', () => {
  it('keeps <=3 star reviews, skips metadata entry, one request per country', async () => {
    const { impl, calls } = fakeFetch(fx('appstore.json'));
    const items = await createAppStoreSource({ countries: ['CA', 'US'] }).search('555', { limit: 10, fetchImpl: impl });
    expect(calls.map((c) => c.url)).toEqual([
      'https://itunes.apple.com/ca/rss/customerreviews/id=555/sortby=mostrecent/json',
      'https://itunes.apple.com/us/rss/customerreviews/id=555/sortby=mostrecent/json',
    ]);
    expect(items).toHaveLength(4);
    expect(items[0].url).toBe('https://apps.apple.com/ca/app/id555#review-9001');
    expect(items[2].url).toBe('https://apps.apple.com/us/app/id555#review-9001');
    expect(new Set(items.slice(0, 2).map((i) => i.url)).size).toBe(2);
    expect(items.map((i) => i.text)).toContain('Syncing fails and I lose hours of work');
    expect(items.some((i) => i.text === 'Love it')).toBe(false);
    expect(items[0].publishedAt).toEqual(new Date('2026-03-01T10:00:00-07:00'));
  });
  it('truncates to limit', async () => {
    const items = await createAppStoreSource({ countries: ['CA', 'US'] }).search('555', {
      limit: 3,
      fetchImpl: fakeFetch(fx('appstore.json')).impl,
    });
    expect(items).toHaveLength(3);
  });
  it('returns [] and warns on 500', async () => {
    expect(await createAppStoreSource({ countries: ['US'] }).search('1', { limit: 5, fetchImpl: fakeFetch('', 500).impl })).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('appstore'));
  });
});

describe('buildSources', () => {
  it('returns all five sources', () => {
    const env = loadEnv({ LLM_API_KEY: 'x' });
    expect(buildSources(env).map((s) => s.id)).toEqual(['hn', 'stackexchange', 'github', 'wordpress', 'appstore']);
    expect(buildSources(env, { countries: ['AU'] })).toHaveLength(5);
  });
});
