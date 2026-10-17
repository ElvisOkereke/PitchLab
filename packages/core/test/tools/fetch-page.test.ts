import { describe, it, expect, vi } from 'vitest';
import { fetchPage as fetchPageReal } from '../../src/tools/fetch-page';
import { logDataCall } from '../../src/tools/data-calls';
import { dataCalls } from '../../src/db/schema';
import { testDb } from '../helpers/db';

const respond = (body: string, status = 200, headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8' }) =>
  new Response(body, { status, headers });

const htmlFetch = (html: string) => vi.fn(async (_u: any, _i?: any) => respond(html));
const statusFetch = (status: number) => vi.fn(async (_u: any, _i?: any) => respond('nope', status));
const typedFetch = (type: string) => vi.fn(async (_u: any, _i?: any) => respond('data', 200, { 'content-type': type }));
const hangingFetch = () =>
  vi.fn(
    (_u: any, init?: any) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      }),
  );

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const real = fetchPageReal;
const fetchPage = ((url: string, opts: any = {}) => real(url, { lookup: publicLookup, ...opts })) as typeof real;

describe('fetchPage', () => {
  it('extracts readable text and title', async () => {
    const r = await fetchPage('https://a.test', {
      fetchImpl: htmlFetch('<title>T</title><article><p>Leads vanished after the update.</p></article>'),
    });
    expect(r.ok).toBe(true);
    expect(r.title).toBe('T');
    expect(r.text).toContain('Leads vanished');
  });

  it('reports http errors, timeouts, non-html, oversize and bad schemes without throwing', async () => {
    expect((await fetchPage('https://a.test', { fetchImpl: statusFetch(403) })).reason).toBe('http_error');
    expect((await fetchPage('https://a.test', { timeoutMs: 10, fetchImpl: hangingFetch() })).reason).toBe('timeout');
    expect((await fetchPage('https://a.test', { fetchImpl: typedFetch('application/pdf') })).reason).toBe('not_html');
    expect((await fetchPage('https://a.test', { maxBytes: 10, fetchImpl: htmlFetch('x'.repeat(100)) })).reason).toBe('too_large');
    expect((await fetchPage('file:///etc/passwd')).reason).toBe('blocked_scheme');
  });

  it('only ever sends GET with the user agent', async () => {
    const f = htmlFetch('<p>x</p>');
    await fetchPage('https://a.test', { fetchImpl: f });
    expect(f.mock.calls[0][1].method).toBe('GET');
    expect(f.mock.calls[0][1].headers['User-Agent']).toBe('BusinessCaseGen/0.1 (research; contact: owner)');
  });

  it('passes text/plain through', async () => {
    const r = await fetchPage('https://a.test', { fetchImpl: typedFetch('text/plain') });
    expect(r.ok).toBe(true);
    expect(r.text).toBe('data');
  });

  it('follows redirects, resolving relative Location, and reports finalUrl', async () => {
    const f = vi.fn(async (u: any) =>
      String(u) === 'https://a.test/'
        ? new Response(null, { status: 302, headers: { location: '/next' } })
        : respond('<article><p>arrived</p></article>'),
    );
    const r = await fetchPage('https://a.test/', { fetchImpl: f });
    expect(r.ok).toBe(true);
    expect(r.finalUrl).toBe('https://a.test/next');
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('blocks redirects to non-http schemes and caps hops at 5', async () => {
    const toFile = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'file:///etc/passwd' } }));
    expect((await fetchPage('https://a.test', { fetchImpl: toFile })).reason).toBe('blocked_scheme');
    const loop = vi.fn(async () => new Response(null, { status: 302, headers: { location: '/again' } }));
    const r = await fetchPage('https://a.test', { fetchImpl: loop });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('network');
    expect(loop).toHaveBeenCalledTimes(6);
  });

  it('maps thrown fetch errors to network', async () => {
    const f = vi.fn(async () => { throw new Error('boom'); });
    const r = await fetchPage('https://a.test', { fetchImpl: f });
    expect(r).toMatchObject({ ok: false, status: 0, reason: 'network', text: '', title: '' });
  });
});

describe('fetchPage SSRF guards', () => {
  const never = () => vi.fn(async () => respond('<p>x</p>'));
  it('blocks metadata IP, localhost, userinfo and mapped IPv6 without fetching', async () => {
    for (const u of ['http://169.254.169.254/', 'http://localhost:3000/', 'http://user:pass@example.com/', 'http://[::ffff:127.0.0.1]/', 'http://[::1]/', 'http://2130706433/', 'http://foo.internal/']) {
      const f = never();
      const r = await fetchPage(u, { fetchImpl: f });
      expect(r.reason, u).toBe('blocked_host');
      expect(r.ok).toBe(false);
      expect(f).not.toHaveBeenCalled();
    }
  });
  it('blocks hostnames resolving to private addresses, and maps lookup failure to network', async () => {
    const f = never();
    const r = await fetchPage('https://sneaky.test', { fetchImpl: f, lookup: async () => [{ address: '10.0.0.5', family: 4 }] });
    expect(r.reason).toBe('blocked_host');
    expect(f).not.toHaveBeenCalled();
    const r2 = await fetchPage('https://nx.test', { fetchImpl: f, lookup: async () => { throw new Error('ENOTFOUND'); } });
    expect(r2.reason).toBe('network');
  });
  it('blocks a redirect to an internal address', async () => {
    const f = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } }));
    const r = await fetchPage('https://a.test', { fetchImpl: f });
    expect(r.reason).toBe('blocked_host');
    expect(r.ok).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('blocks https to http downgrade on redirect', async () => {
    const f = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://b.test/' } }));
    expect((await fetchPage('https://a.test', { fetchImpl: f })).reason).toBe('blocked_scheme');
  });
});

describe('logDataCall', () => {
  it('inserts one row with cost defaulting to 0', async () => {
    const db = await testDb();
    await logDataCall(db, { runId: null, provider: 'fetch', endpoint: 'https://a.test', ok: true });
    const rows = await db.select().from(dataCalls);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'fetch', endpoint: 'https://a.test', ok: true });
    expect(Number(rows[0].costUsd)).toBe(0);
  });
});
