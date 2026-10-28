import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pageFetches } from '../../src/db/schema';
import { collectPage, THIN_TEXT_CHARS, type BrowserRenderer } from '../../src/research/collect';
import { SourceError } from '../../src/research/http';
import type { ArchiveClient } from '../../src/research/archive';
import type { PageResult } from '../../src/tools/fetch-page';
import { testDb } from '../helpers/db';

const URL_ = 'https://site.example/post';
const LONG = 'word '.repeat(300);
const okPage = (text = LONG, finalUrl = URL_): PageResult => ({ ok: true, status: 200, finalUrl, title: 'T', text });
const bad = (status: number, reason: PageResult['reason'] = 'http_error'): PageResult => ({ ok: false, status, finalUrl: URL_, title: '', text: '', reason });
const SNAP = { snapshotUrl: 'https://web.archive.org/web/20260101000000id_/https://site.example/post', timestamp: new Date('2026-01-01T00:00:00Z') };

async function setup(o: { direct?: PageResult; robots?: (u: string) => boolean; archive?: Partial<ArchiveClient>; browser?: BrowserRenderer | null; disabled?: boolean } = {}) {
  const db = await testDb();
  const fetchPage = vi.fn(async () => o.direct ?? okPage());
  const robotsAllows = vi.fn(async (u: string) => (o.robots ? o.robots(u) : true));
  const archive: ArchiveClient = {
    snapshot: vi.fn(async () => SNAP), fetch: vi.fn(async () => okPage('archived body '.repeat(100), SNAP.snapshotUrl)), ...o.archive,
  };
  const log = vi.fn();
  const state = { archiveDisabled: o.disabled ?? false };
  const ctx = { db, fetchPage: fetchPage as never, robotsAllows, archive, browser: o.browser, log, state };
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
    expect(s.fetchPage).toHaveBeenCalledWith(URL_, expect.objectContaining({ blockHosts: expect.arrayContaining(['reddit.com']) }));
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

  it('keeps the thin text as thin_text when the browser is null or declines', async () => {
    for (const browser of [null, undefined, { render: async () => null }]) {
      const s = await setup({ direct: okPage('tiny'), browser });
      expect(await collectPage(URL_, s.ctx)).toMatchObject({ text: 'tiny', via: 'direct' });
      expect(await s.rows()).toEqual(['direct:thin_text']);
    }
  });

  it('a browser that throws leaves the thin text', async () => {
    const s = await setup({ direct: okPage('tiny'), browser: { render: async () => { throw new Error('boom'); } } });
    expect(await collectPage(URL_, s.ctx)).toMatchObject({ text: 'tiny', via: 'direct' });
  });

  it('threshold is 800 characters', () => expect(THIN_TEXT_CHARS).toBe(800));

  it('re-checks robots and banned hosts after a redirect', async () => {
    const s = await setup({ direct: okPage(LONG, 'https://elsewhere.example/x'), robots: (u) => !u.includes('elsewhere') });
    expect(await collectPage(URL_, s.ctx)).toEqual({ failed: 'blocked_robots' });
    const t = await setup({ direct: okPage(LONG, 'https://www.reddit.com/r/x') });
    expect(await collectPage(URL_, t.ctx)).toEqual({ failed: 'blocked_host' });
  });
});
