import { describe, it, expect, vi } from 'vitest';
import { NEVER_FETCH_HOSTS, fetchPage as fetchPageReal, makeGuardedLookup } from '../../src/tools/fetch-page';
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

  it('returns the raw html of an html page, capped at 500 KB', async () => {
    const page = '<title>T</title><p>Mail <a href="mailto:a@b.com">us</a></p>';
    const r = await fetchPage('https://a.test', { fetchImpl: htmlFetch(page) });
    expect(r.html).toBe(page);
    expect(r.text).toContain('Mail');

    const big = `<p>${'é'.repeat(400_000)}</p>`; // ~800 KB of UTF-8, under the 2 MB fetch cap
    const capped = await fetchPage('https://a.test', { fetchImpl: htmlFetch(big) });
    expect(capped.ok).toBe(true);
    expect(Buffer.byteLength(capped.html!, 'utf8')).toBeLessThanOrEqual(500_000);
    expect(Buffer.byteLength(capped.html!, 'utf8')).toBeGreaterThan(499_990);
    expect(capped.html!.startsWith('<p>éé')).toBe(true);
    expect(capped.html).not.toContain(String.fromCharCode(0xfffd));
  });

  it('has no html for text/plain pages or failures', async () => {
    expect((await fetchPage('https://a.test', { fetchImpl: typedFetch('text/plain') })).html).toBeUndefined();
    expect((await fetchPage('https://a.test', { fetchImpl: statusFetch(500) })).html).toBeUndefined();
  });

  it('never fetches the owner pilot site or its subdomains, even via a redirect', async () => {
    expect(NEVER_FETCH_HOSTS).toContain('gamersgetaway.ca');
    const direct = htmlFetch('<p>x</p>');
    for (const url of ['https://gamersgetaway.ca/', 'http://WWW.GamersGetaway.ca./contact', 'https://shop.gamersgetaway.ca/x']) {
      expect((await fetchPage(url, { fetchImpl: direct })).reason, url).toBe('blocked_host');
    }
    expect(direct).not.toHaveBeenCalled();

    const redirecting = vi.fn(async (u: any) =>
      String(u) === 'https://a.test/'
        ? new Response(null, { status: 301, headers: { location: 'https://www.gamersgetaway.ca/' } })
        : respond('<p>should never be fetched</p>'),
    );
    const r = await fetchPage('https://a.test/', { fetchImpl: redirecting });
    expect(r).toMatchObject({ ok: false, reason: 'blocked_host', finalUrl: 'https://www.gamersgetaway.ca/' });
    expect(redirecting).toHaveBeenCalledTimes(1);
    for (const url of ['https://gamersgetaway.ca../', 'https://www..gamersgetaway.ca/', 'https://a..example.com/']) {
      expect((await fetchPage(url, { fetchImpl: direct })).reason, url).toBe('blocked_host');
    }
    expect(direct).not.toHaveBeenCalled();
    // A look-alike domain is not blocked.
    expect((await fetchPage('https://notgamersgetaway.ca/', { fetchImpl: htmlFetch('<p>ok</p>') })).ok).toBe(true);
  });

  it('blocks a redirect to an IP-literal host; an IP-literal entry url behaves as before (P3-R7)', async () => {
    for (const target of ['http://93.184.216.34/', 'http://[2001:4860:4860::8888]/']) {
      const f = vi.fn(async (u: any) =>
        String(u) === 'http://a.test/' ? new Response(null, { status: 302, headers: { location: target } }) : respond('<p>x</p>'),
      );
      const r = await fetchPage('http://a.test/', { fetchImpl: f });
      expect(r.reason, target).toBe('blocked_host');
      expect(f).toHaveBeenCalledTimes(1);
    }
    const entry = await fetchPage('http://93.184.216.34/', { fetchImpl: htmlFetch('<title>IP</title><p>ok</p>') });
    expect(entry.ok).toBe(true);
  });

  it('non-canonical IPv4 literals are normalised by the URL parser before the checks', async () => {
    for (const target of ['http://2130706433/', 'http://0x5db8d822/', 'http://0135.0270.0330.042/', 'http://93.184.55074/']) {
      const f = vi.fn(async (u: any) =>
        String(u) === 'http://a.test/' ? new Response(null, { status: 302, headers: { location: target } }) : respond('<p>x</p>'),
      );
      const r = await fetchPage('http://a.test/', { fetchImpl: f });
      expect(r.reason, target).toBe('blocked_host');
      expect(f, target).toHaveBeenCalledTimes(1);
    }
    // As entry urls they resolve to the canonical host and the allowed-IP rules apply.
    const entry = async (url: string) => {
      const f = htmlFetch('<p>ok</p>');
      const r = await fetchPage(url, { fetchImpl: f });
      return { r, requested: f.mock.calls.map((c) => String(c[0])) };
    };
    const loopback = await entry('http://2130706433/');
    expect(loopback.r.reason).toBe('blocked_host');
    expect(loopback.requested).toEqual([]);
    for (const [url, canonical] of [
      ['http://0x5db8d822/', 'http://93.184.216.34/'],
      ['http://0135.0270.0330.042/', 'http://93.184.216.34/'],
      ['http://93.184.55074/', 'http://93.184.215.34/'],
    ]) {
      const { r, requested } = await entry(url);
      expect(r.ok, url).toBe(true);
      expect(requested, url).toEqual([canonical]);
    }
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
    for (const u of ['http://169.254.169.254/', 'http://localhost:3000/', 'http://user:pass@example.com/', 'http://[::ffff:127.0.0.1]/', 'http://[::1]/', 'http://[::7f00:1]/', 'http://[::a00:1]/', 'http://[64:ff9b:1::7f00:1]/', 'http://2130706433/', 'http://foo.internal/']) {
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

describe('fetchPage allow-list and pinning', () => {
  it('blocks reserved/special addresses', async () => {
    for (const u of ['http://198.18.0.1/', 'http://224.0.0.1/', 'http://255.255.255.255/', 'http://192.0.2.1/', 'http://[64:ff9b::7f00:1]/', 'http://[2002:7f00:1::]/']) {
      const f = vi.fn(async () => respond('<p>x</p>'));
      expect((await fetchPage(u, { fetchImpl: f })).reason, u).toBe('blocked_host');
      expect(f).not.toHaveBeenCalled();
    }
  });
  it('blocks when any resolved address is private', async () => {
    const lookup = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }];
    expect((await fetchPage('https://mixed.test', { fetchImpl: htmlFetch('x'), lookup })).reason).toBe('blocked_host');
  });
  it('times out a hanging DNS lookup', async () => {
    const lookup = () => new Promise<never>(() => {});
    expect((await fetchPage('https://slow.test', { timeoutMs: 20, fetchImpl: htmlFetch('x'), lookup })).reason).toBe('timeout');
  });
  it('guardedLookup rejects private addresses with EBLOCKED and returns public ones', async () => {
    const bad = makeGuardedLookup(async () => [{ address: '10.0.0.5', family: 4 }]);
    const err: any = await new Promise((res) => bad('x.test', {}, (e) => res(e)));
    expect(err.code).toBe('EBLOCKED');
    const mixed = makeGuardedLookup(async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    expect(((await new Promise((res) => mixed('x.test', {}, (e) => res(e)))) as any).code).toBe('EBLOCKED');
    const good = makeGuardedLookup(async () => [{ address: '93.184.216.34', family: 4 }]);
    const out: any = await new Promise((res) => good('x.test', {}, (e, a, f) => res({ e, a, f })));
    expect(out).toEqual({ e: null, a: '93.184.216.34', f: 4 });
    const all: any = await new Promise((res) => good('x.test', { all: true }, (e, a) => res({ e, a })));
    expect(all).toEqual({ e: null, a: [{ address: '93.184.216.34', family: 4 }] });
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
