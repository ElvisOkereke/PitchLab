import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pageFetches } from '../../src/db/schema';
import { collectPage, THIN_TEXT_CHARS, type BrowserRenderer, type ScraperStep } from '../../src/research/collect';
import { SourceError } from '../../src/research/http';
import type { ArchiveClient } from '../../src/research/archive';
import type { PageResult } from '../../src/tools/fetch-page';
import { testDb } from '../helpers/db';

const URL_ = 'https://site.example/post';
const LONG = 'word '.repeat(300);
const okPage = (text = LONG, finalUrl = URL_): PageResult => ({ ok: true, status: 200, finalUrl, title: 'T', text });
const bad = (status: number, reason: PageResult['reason'] = 'http_error'): PageResult => ({ ok: false, status, finalUrl: URL_, title: '', text: '', reason });
const SNAP = { snapshotUrl: 'https://web.archive.org/web/20260101000000id_/https://site.example/post', timestamp: new Date('2026-01-01T00:00:00Z') };

async function setup(o: {
  direct?: PageResult; robots?: (u: string) => boolean; archive?: Partial<ArchiveClient>; browser?: BrowserRenderer | null; disabled?: boolean;
  scraper?: ScraperStep | null; respectRobots?: boolean;
} = {}) {
  const db = await testDb();
  const fetchPage = vi.fn(async () => o.direct ?? okPage());
  const robotsAllows = vi.fn(async (u: string) => (o.robots ? o.robots(u) : true));
  const archive: ArchiveClient = {
    snapshot: vi.fn(async () => SNAP), fetch: vi.fn(async () => okPage('archived body '.repeat(100), SNAP.snapshotUrl)), ...o.archive,
  };
  const log = vi.fn();
  const state = { archiveDisabled: o.disabled ?? false };
  const ctx = { db, fetchPage: fetchPage as never, robotsAllows, archive, browser: o.browser, scraper: o.scraper, respectRobots: o.respectRobots, log, state };
  const rows = async () => (await db.select().from(pageFetches)).map((r) => `${r.via}:${r.outcome}`).sort();
  return { ctx, fetchPage, robotsAllows, archive, log, state, rows };
}

describe('collectPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a direct page and logs ok', async () => {
    const s = await setup();
    const r = await collectPage(URL_, s.ctx);
    expect(r).toMatchObject({ text: LONG, title: 'T', finalUrl: URL_, via: 'direct' });
    expect(await s.rows()).toEqual(['direct:ok']);
    expect(s.fetchPage).toHaveBeenCalledWith(URL_, expect.objectContaining({ blockHosts: expect.arrayContaining(['bing.com']) }));
  });

  it('robots deny: no fetch, no archive', async () => {
    const s = await setup({ robots: () => false });
    expect(await collectPage(URL_, s.ctx)).toEqual({ failed: 'blocked_robots' });
    expect(s.fetchPage).not.toHaveBeenCalled();
    expect(s.archive.snapshot).not.toHaveBeenCalled();
    expect(await s.rows()).toEqual(['direct:blocked_robots']);
  });

  it.each([[403], [404], [410], [503]])('a %i falls back to the archive', async (status) => {
    const s = await setup({ direct: bad(status) });
    const r = await collectPage(URL_, s.ctx);
    expect(r).toMatchObject({ via: 'archive', snapshotAt: SNAP.timestamp });
    expect('text' in r && r.text).toContain('archived body');
    expect(s.robotsAllows).toHaveBeenCalledWith(SNAP.snapshotUrl);
    expect((await s.rows()).filter((x) => x.startsWith('archive:'))).toEqual(['archive:ok']);
  });

  it('a timeout falls back to the archive', async () => {
    const s = await setup({ direct: bad(0, 'timeout') });
    expect(await collectPage(URL_, s.ctx)).toMatchObject({ via: 'archive' });
    expect(await s.rows()).toEqual(['archive:ok', 'direct:timeout']);
  });

  it('does not use the archive for a 400, not_html or network failure', async () => {
    for (const direct of [bad(400), bad(200, 'not_html'), bad(0, 'network')]) {
      const s = await setup({ direct });
      expect('failed' in (await collectPage(URL_, s.ctx))).toBe(true);
      expect(s.archive.snapshot).not.toHaveBeenCalled();
    }
  });

  it('fails with the direct outcome when there is no snapshot', async () => {
    const s = await setup({ direct: bad(404), archive: { snapshot: vi.fn(async () => null) } });
    expect(await collectPage(URL_, s.ctx)).toEqual({ failed: 'http_404' });
  });

  it('skips the archive when robots disallows the snapshot', async () => {
    const s = await setup({ direct: bad(404), robots: (u) => !u.includes('web.archive.org') });
    expect(await collectPage(URL_, s.ctx)).toEqual({ failed: 'http_404' });
    expect(s.archive.fetch).not.toHaveBeenCalled();
    expect(await s.rows()).toEqual(['archive:blocked_robots', 'direct:http_404']);
  });

  it('a 429 from the archive disables it with a warning', async () => {
    const s = await setup({ direct: bad(404), archive: { snapshot: vi.fn(async () => { throw new SourceError('rate_limited', 'archive'); }) } });
    expect(await collectPage(URL_, s.ctx)).toEqual({ failed: 'http_404' });
    expect(s.state.archiveDisabled).toBe(true);
    expect(s.log).toHaveBeenCalledWith(expect.stringContaining('archive'));
    await collectPage(URL_, s.ctx);
    expect(s.archive.snapshot).toHaveBeenCalledTimes(1);
  });

  it('a 429 while fetching a snapshot disables the archive too', async () => {
    const s = await setup({ direct: bad(404), archive: { fetch: vi.fn(async () => bad(429)) } });
    expect(await collectPage(URL_, s.ctx)).toEqual({ failed: 'http_404' });
    expect(s.state.archiveDisabled).toBe(true);
  });

  it('does not use a disabled archive', async () => {
    const s = await setup({ direct: bad(404), disabled: true });
    expect(await collectPage(URL_, s.ctx)).toEqual({ failed: 'http_404' });
    expect(s.archive.snapshot).not.toHaveBeenCalled();
  });

  it('sends a thin page to the browser when one is given', async () => {
    const browser: BrowserRenderer = { render: vi.fn(async () => ({ html: `<html><head><title>R</title></head><body><article>${Array.from({ length: 30 }, (_, i) => `<p>Paragraph ${i}. ${'readable sentence here. '.repeat(5)}</p>`).join('')}</article></body></html>`, finalUrl: URL_ })) };
    const s = await setup({ direct: okPage('tiny'), browser });
    const r = await collectPage(URL_, s.ctx);
    expect(r).toMatchObject({ via: 'browser', title: 'R' });
    expect(await s.rows()).toEqual(['browser:ok', 'direct:thin_text']);
  });

  it('keeps the thin text as thin_text when the browser is null or absent', async () => {
    for (const browser of [null, undefined]) {
      const s = await setup({ direct: okPage('tiny'), browser });
      expect(await collectPage(URL_, s.ctx)).toMatchObject({ text: 'tiny', via: 'direct' });
      expect(await s.rows()).toEqual(['direct:thin_text']);
    }
  });

  it('logs a browser that declines', async () => {
    const s = await setup({ direct: okPage('tiny'), browser: { render: async () => null } });
    expect(await collectPage(URL_, s.ctx)).toMatchObject({ text: 'tiny', via: 'direct' });
    expect(await s.rows()).toEqual(['browser:network', 'direct:thin_text']);
  });

  it('logs an archive lookup that finds no snapshot, and treats an empty archived page as a failure', async () => {
    const s = await setup({ direct: bad(404), archive: { snapshot: vi.fn(async () => null) } });
    await collectPage(URL_, s.ctx);
    expect(await s.rows()).toEqual(['archive:http_404', 'direct:http_404']);
    const e = await setup({ direct: bad(404), archive: { fetch: vi.fn(async () => okPage('  ', SNAP.snapshotUrl)) } });
    expect(await collectPage(URL_, e.ctx)).toEqual({ failed: 'http_404' });
    expect(await e.rows()).toEqual(['archive:thin_text', 'direct:http_404']);
  });

  it('logs every archive attempt under the original page\'s domain (archive.org never tops the failing domains)', async () => {
    const cases: Partial<ArchiveClient>[] = [
      {}, // fetched
      { snapshot: vi.fn(async () => null) },
      { fetch: vi.fn(async () => bad(503)) },
      { snapshot: vi.fn(async () => { throw new SourceError('rate_limited', 'archive'); }) },
      { snapshot: vi.fn(async () => { throw new Error('boom'); }) },
    ];
    for (const archive of cases) {
      const s = await setup({ direct: bad(404), archive });
      await collectPage(URL_, s.ctx);
      const rows = (await s.ctx.db.select().from(pageFetches)).filter((r) => r.via === 'archive');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.urlDomain).toBe('site.example');
    }
    const blocked = await setup({ direct: bad(404), robots: (u) => !u.includes('web.archive.org') });
    await collectPage(URL_, blocked.ctx);
    expect((await blocked.ctx.db.select().from(pageFetches)).map((r) => `${r.via}:${r.urlDomain}`).sort()).toEqual(['archive:site.example', 'direct:site.example']);
  });

  it('a browser that throws leaves the thin text', async () => {
    const s = await setup({ direct: okPage('tiny'), browser: { render: async () => { throw new Error('boom'); } } });
    expect(await collectPage(URL_, s.ctx)).toMatchObject({ text: 'tiny', via: 'direct' });
  });

  it('threshold is 800 characters', () => expect(THIN_TEXT_CHARS).toBe(800));

  it('re-checks robots and banned hosts after a redirect', async () => {
    const s = await setup({ direct: okPage(LONG, 'https://elsewhere.example/x'), robots: (u) => !u.includes('elsewhere') });
    expect(await collectPage(URL_, s.ctx)).toEqual({ failed: 'blocked_robots' });
    const t = await setup({ direct: okPage(LONG, 'https://www.bing.com/x') });
    expect(await collectPage(URL_, t.ctx)).toEqual({ failed: 'blocked_host' });
  });
});

describe('collectPage escalation (direct, real browser, scraping service, archive)', () => {
  beforeEach(() => vi.clearAllMocks());

  const ARTICLE = `<html><head><title>R</title></head><body><article>${Array.from({ length: 30 }, (_, i) => `<p>Paragraph ${i}. ${'readable sentence here. '.repeat(5)}</p>`).join('')}</article></body></html>`;
  const CHALLENGE = '<html><head><title>Just a moment...</title></head><body><div id="cf-chl-widget"></div></body></html>';
  const challengePage = (): PageResult => ({ ok: true, status: 200, finalUrl: URL_, title: 'Just a moment...', text: 'Checking your browser', html: CHALLENGE });
  const real = (impl: BrowserRenderer['render']): BrowserRenderer => ({ kind: 'real', render: vi.fn(impl) });
  const scraperOf = (impl: ScraperStep['scrape']): ScraperStep => ({ scrape: vi.fn(impl) });

  it('a 403 goes to the real browser, logged as real_browser', async () => {
    const scraper = scraperOf(async () => okPage());
    const s = await setup({ direct: bad(403), browser: real(async () => ({ html: ARTICLE, finalUrl: URL_, status: 200 })), scraper });
    expect(await collectPage(URL_, s.ctx)).toMatchObject({ via: 'real_browser', title: 'R' });
    expect(await s.rows()).toEqual(['direct:http_403', 'real_browser:ok']);
    expect(scraper.scrape).not.toHaveBeenCalled();
    expect(s.archive.snapshot).not.toHaveBeenCalled();
  });

  it('a challenge page from the direct fetch goes to the real browser', async () => {
    const s = await setup({ direct: challengePage(), browser: real(async () => ({ html: ARTICLE, finalUrl: URL_, status: 200 })) });
    expect(await collectPage(URL_, s.ctx)).toMatchObject({ via: 'real_browser' });
    expect(await s.rows()).toEqual(['direct:challenge', 'real_browser:ok']);
  });

  it('still blocked in the browser: the scraping service, logged as scraper', async () => {
    const scraper = scraperOf(async () => ({ ...okPage(), title: 'Scraped' }));
    const s = await setup({ direct: bad(403), browser: real(async () => ({ html: CHALLENGE, finalUrl: URL_, status: 403 })), scraper });
    expect(await collectPage(URL_, s.ctx)).toMatchObject({ via: 'scraper', title: 'Scraped', finalUrl: URL_ });
    expect(await s.rows()).toEqual(['direct:http_403', 'real_browser:challenge', 'scraper:ok']);
    expect(scraper.scrape).toHaveBeenCalledWith(URL_);
    expect(s.archive.snapshot).not.toHaveBeenCalled();
  });

  it('runs the steps in order: direct, real browser, scraper, archive', async () => {
    const order: string[] = [];
    const s = await setup({
      direct: bad(403),
      browser: real(async () => { order.push('browser'); return null; }),
      scraper: scraperOf(async () => { order.push('scraper'); return bad(500); }),
      archive: { snapshot: vi.fn(async () => { order.push('archive'); return SNAP; }) },
    });
    s.fetchPage.mockImplementation(async () => { order.push('direct'); return bad(403); });
    expect(await collectPage(URL_, s.ctx)).toMatchObject({ via: 'archive' });
    expect(order).toEqual(['direct', 'browser', 'scraper', 'archive']);
    expect(await s.rows()).toEqual(['archive:ok', 'direct:http_403', 'real_browser:network', 'scraper:http_5xx']);
  });

  it('no scraper key: the step is skipped, logged, and the archive is still tried', async () => {
    for (const scraper of [undefined, null, scraperOf(async () => ({ skipped: 'not_configured' as const }))]) {
      const s = await setup({ direct: bad(403), scraper });
      expect(await collectPage(URL_, s.ctx)).toMatchObject({ via: 'archive' });
      expect(await s.rows()).toEqual(['archive:ok', 'direct:http_403', 'scraper:skipped']);
    }
  });

  it('monthly scraper budget used up: skipped, logged, and the archive is still tried', async () => {
    const s = await setup({ direct: challengePage(), scraper: scraperOf(async () => ({ skipped: 'budget' as const })) });
    expect(await collectPage(URL_, s.ctx)).toMatchObject({ via: 'archive' });
    expect(await s.rows()).toEqual(['archive:ok', 'direct:challenge', 'scraper:skipped']);
  });

  it('a challenge page from the scraper is a failure, then the archive', async () => {
    const s = await setup({ direct: bad(403), scraper: scraperOf(async () => challengePage()) });
    expect(await collectPage(URL_, s.ctx)).toMatchObject({ via: 'archive' });
    expect(await s.rows()).toEqual(['archive:ok', 'direct:http_403', 'scraper:challenge']);
  });

  it('a blocked page with nothing left fails with the blocking outcome', async () => {
    const s = await setup({ direct: challengePage(), archive: { snapshot: vi.fn(async () => null) } });
    expect(await collectPage(URL_, s.ctx)).toEqual({ failed: 'challenge' });
  });

  it('thin text alone never spends a scraper page', async () => {
    const scraper = scraperOf(async () => okPage());
    const s = await setup({ direct: okPage('tiny'), browser: real(async () => ({ html: '<p>also tiny but longer</p>', finalUrl: URL_, status: 200 })), scraper });
    expect(await collectPage(URL_, s.ctx)).toMatchObject({ via: 'real_browser', text: 'also tiny but longer' });
    expect(scraper.scrape).not.toHaveBeenCalled();
    expect(await s.rows()).toEqual(['direct:thin_text', 'real_browser:thin_text']);
  });

  it('a real-browser error status counts as blocked unless the page then loaded (a challenge that cleared)', async () => {
    const blocked = await setup({ direct: bad(403), browser: real(async () => ({ html: '<h1>Forbidden</h1>', finalUrl: URL_, status: 403 })), scraper: scraperOf(async () => okPage()) });
    expect(await collectPage(URL_, blocked.ctx)).toMatchObject({ via: 'scraper' });
    expect(await blocked.rows()).toEqual(['direct:http_403', 'real_browser:http_403', 'scraper:ok']);
    const cleared = await setup({ direct: bad(403), browser: real(async () => ({ html: ARTICLE, finalUrl: URL_, status: 403 })) });
    expect(await collectPage(URL_, cleared.ctx)).toMatchObject({ via: 'real_browser' });
  });

  it('a 404 is not escalated to the browser or the scraper', async () => {
    const browser = real(async () => ({ html: ARTICLE, finalUrl: URL_, status: 200 }));
    const scraper = scraperOf(async () => okPage());
    const s = await setup({ direct: bad(404), browser, scraper });
    expect(await collectPage(URL_, s.ctx)).toMatchObject({ via: 'archive' });
    expect(browser.render).not.toHaveBeenCalled();
    expect(scraper.scrape).not.toHaveBeenCalled();
  });

  it('the headless renderer still logs as browser', async () => {
    const s = await setup({ direct: bad(403), browser: { kind: 'headless', render: async () => ({ html: ARTICLE, finalUrl: URL_ }) } });
    expect(await collectPage(URL_, s.ctx)).toMatchObject({ via: 'browser' });
    expect(await s.rows()).toEqual(['browser:ok', 'direct:http_403']);
  });
});

describe('collectPage: fetch.respectRobots and hosts that are never relaxed', () => {
  beforeEach(() => vi.clearAllMocks());

  it('respectRobots on (default): robots.txt is checked', async () => {
    const s = await setup({ robots: () => false });
    expect(await collectPage(URL_, s.ctx)).toEqual({ failed: 'blocked_robots' });
    const t = await setup({ robots: () => false, respectRobots: true });
    expect(await collectPage(URL_, t.ctx)).toEqual({ failed: 'blocked_robots' });
  });

  it('respectRobots off: robots.txt is not checked, for the page, redirects or the archive snapshot', async () => {
    const s = await setup({ robots: () => false, respectRobots: false });
    expect(await collectPage(URL_, s.ctx)).toMatchObject({ via: 'direct' });
    const a = await setup({ direct: bad(404), robots: () => false, respectRobots: false });
    expect(await collectPage(URL_, a.ctx)).toMatchObject({ via: 'archive' });
    expect(s.robotsAllows).not.toHaveBeenCalled();
    expect(a.robotsAllows).not.toHaveBeenCalled();
  });

  it('never-fetch and banned hosts are refused even with robots off, before any step', async () => {
    for (const u of ['https://gamersgetaway.ca/', 'https://shop.gamersgetaway.ca/p', 'https://www.bing.com/search?q=x', 'http://127.0.0.1/']) {
      const browser: BrowserRenderer = { kind: 'real', render: vi.fn(async () => ({ html: '<p>x</p>', finalUrl: u, status: 200 })) };
      const scraper: ScraperStep = { scrape: vi.fn(async () => okPage()) };
      const s = await setup({ respectRobots: false, browser, scraper });
      expect(await collectPage(u, s.ctx)).toEqual({ failed: 'blocked_host' });
      expect(s.fetchPage).not.toHaveBeenCalled();
      expect(browser.render).not.toHaveBeenCalled();
      expect(scraper.scrape).not.toHaveBeenCalled();
      expect(s.archive.snapshot).not.toHaveBeenCalled();
    }
  });

  it('a browser or scraper result that lands on a never-fetch host is dropped', async () => {
    const LONG_HTML = `<html><body><article>${'<p>text text text text text text text text.</p>'.repeat(60)}</article></body></html>`;
    const s = await setup({
      direct: bad(403), respectRobots: false,
      browser: { kind: 'real', render: async () => ({ html: LONG_HTML, finalUrl: 'https://gamersgetaway.ca/x', status: 200 }) },
      scraper: { scrape: async () => okPage(LONG, 'https://shop.gamersgetaway.ca/y') },
      archive: { snapshot: vi.fn(async () => null) },
    });
    expect(await collectPage(URL_, s.ctx)).toEqual({ failed: 'http_403' });
    expect(await s.rows()).toEqual(['archive:http_404', 'direct:http_403', 'real_browser:network', 'scraper:blocked_host']);
  });

  it('reddit, G2, Capterra and Trustpilot pages are fetched (terms-of-service bans lifted)', async () => {
    for (const u of ['https://www.reddit.com/r/smallbusiness/comments/1/x/', 'https://www.g2.com/products/x/reviews', 'https://www.capterra.com/p/1/x/', 'https://uk.trustpilot.com/review/acme.com']) {
      const s = await setup({ direct: okPage(LONG, u) });
      expect(await collectPage(u, s.ctx)).toMatchObject({ via: 'direct', finalUrl: u });
    }
  });
});
