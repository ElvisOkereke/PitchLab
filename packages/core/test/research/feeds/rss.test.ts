import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_RSS_FEEDS, parseFeed, rssFeed } from '../../../src/research/feeds/rss';
import type { FetchPageOpts, PageResult } from '../../../src/tools/fetch-page';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>News</title>
<item><title>Startup &amp; funding</title><link>https://example.com/a</link><pubDate>Mon, 03 Nov 2026 10:00:00 GMT</pubDate>
<description><![CDATA[<p>Raised <b>$5M</b> for invoicing.</p>]]></description></item>
<item><title>Second</title><link>https://example.com/b</link><description>Plain &lt;i&gt;text&lt;/i&gt;</description><content:encoded><![CDATA[<div>Full body here</div>]]></content:encoded></item>
<item><title>No link</title></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title>
<entry><title type="html">Launch &lt;b&gt;today&lt;/b&gt;</title><link rel="alternate" href="https://example.org/x"/><link rel="self" href="https://example.org/self"/><updated>2026-11-04T00:00:00Z</updated><summary>A new tool</summary></entry>
<entry><title>Entry two</title><link href="https://example.org/y"/><published>2026-11-05T00:00:00Z</published><content type="html">&lt;p&gt;Body two&lt;/p&gt;</content></entry>
</feed>`;

describe('parseFeed', () => {
  it('parses RSS 2.0 (CDATA, entities, content:encoded preferred)', () => {
    const e = parseFeed('rss', RSS);
    expect(e).toHaveLength(3);
    expect(e[0]).toMatchObject({ title: 'Startup & funding', url: 'https://example.com/a', text: 'Raised $5M for invoicing.', published: 'Mon, 03 Nov 2026 10:00:00 GMT' });
    expect(e[1]).toMatchObject({ url: 'https://example.com/b', text: 'Full body here' });
    expect(e[2]!.url).toBe('');
  });

  it('parses Atom (alternate link, html title and content, updated or published)', () => {
    const e = parseFeed('rss', ATOM);
    expect(e).toHaveLength(2);
    expect(e[0]).toMatchObject({ title: 'Launch today', url: 'https://example.org/x', text: 'A new tool', published: '2026-11-04T00:00:00Z' });
    expect(e[1]).toMatchObject({ url: 'https://example.org/y', text: 'Body two', published: '2026-11-05T00:00:00Z' });
  });

  it('rejects HTML and non-feed text as a bad response', () => {
    expect(() => parseFeed('rss', '<!doctype html><html><body>Hi</body></html>')).toThrowError(expect.objectContaining({ code: 'bad_response' }));
    expect(() => parseFeed('rss', 'just words')).toThrowError(expect.objectContaining({ code: 'bad_response' }));
  });
});

function pages(over: Partial<PageResult>) {
  const calls: { url: string; opts: FetchPageOpts }[] = [];
  const fetchPage = vi.fn(async (url: string, o: FetchPageOpts = {}): Promise<PageResult> => {
    calls.push({ url, opts: o });
    return { ok: true, status: 200, finalUrl: url, title: '', text: RSS, ...over };
  });
  return { fetchPage: fetchPage as never, calls };
}

describe('rssFeed', () => {
  it('goes through the guarded fetcher with the feed accept mode and the research identity, and returns clean items', async () => {
    const p = pages({});
    const items = await rssFeed('https://example.com/feed', { fetchPage: p.fetchPage });
    expect(p.calls[0]!.url).toBe('https://example.com/feed');
    expect(p.calls[0]!.opts).toMatchObject({ accept: 'feed', userAgent: 'pitchlab-research/0.1' });
    expect(p.calls[0]!.opts.blockHosts).toContain('bing.com');
    expect(items.map((i) => i.url)).toEqual(['https://example.com/a', 'https://example.com/b']);
    expect(items[0]).toMatchObject({ source: 'rss', title: 'Startup & funding' });
    expect(items[0]!.publishedAt).toEqual(new Date('2026-11-03T10:00:00Z'));
  });

  it('caps a feed at 25 items', async () => {
    const many = `<rss version="2.0"><channel>${Array.from({ length: 60 }, (_, i) => `<item><title>T${i}</title><link>https://e.com/${i}</link><description>d${i}</description></item>`).join('')}</channel></rss>`;
    expect(await rssFeed('https://example.com/feed', { fetchPage: pages({ text: many }).fetchPage })).toHaveLength(25);
  });

  it('maps 429, auth, non-feed content and an HTML page', async () => {
    await expect(rssFeed('https://example.com/f', { fetchPage: pages({ ok: false, status: 429, reason: 'http_error', text: '' }).fetchPage })).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(rssFeed('https://example.com/f', { fetchPage: pages({ ok: false, status: 403, reason: 'http_error', text: '' }).fetchPage })).rejects.toMatchObject({ code: 'auth' });
    await expect(rssFeed('https://example.com/f', { fetchPage: pages({ ok: false, status: 200, reason: 'not_html', text: '' }).fetchPage })).rejects.toMatchObject({ code: 'bad_response' });
    await expect(rssFeed('https://example.com/f', { fetchPage: pages({ text: 'Sign up to read our newsletter' }).fetchPage })).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('refuses a feed address that is not a web address', async () => {
    const p = pages({});
    await expect(rssFeed('file:///etc/passwd', { fetchPage: p.fetchPage })).rejects.toMatchObject({ code: 'bad_response' });
    expect(p.calls).toHaveLength(0);
  });

  it('defaults cover the eight named feeds, all https', () => {
    expect(DEFAULT_RSS_FEEDS).toHaveLength(8);
    expect(DEFAULT_RSS_FEEDS.every((u) => u.startsWith('https://'))).toBe(true);
  });
});
