import { beforeEach, describe, expect, it } from 'vitest';
import { matches, resetRobotsCache, robotsAllows } from '../../src/research/robots';

const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

function mk(body: string, status = 200) {
  const calls: string[] = [];
  const impl = (async (u: string | URL | Request) => {
    calls.push(String(u));
    return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
  }) as typeof fetch;
  return { fetch: impl, lookup, calls };
}

beforeEach(() => resetRobotsCache());

describe('robotsAllows', () => {
  it('honours Disallow for *', async () => {
    const o = mk('User-agent: *\nDisallow: /private\n');
    expect(await robotsAllows('https://a.test/private/x', o)).toBe(false);
    expect(await robotsAllows('https://a.test/public', o)).toBe(true);
  });
  it('longest match wins, Allow overrides a shorter Disallow', async () => {
    const o = mk('User-agent: *\nDisallow: /docs\nAllow: /docs/open\n');
    expect(await robotsAllows('https://b.test/docs/secret', o)).toBe(false);
    expect(await robotsAllows('https://b.test/docs/open/a', o)).toBe(true);
  });
  it('prefers the exact pitchlab group over *', async () => {
    const o = mk('User-agent: *\nDisallow: /\n\nUser-agent: pitchlab-research\nAllow: /\n');
    expect(await robotsAllows('https://c.test/x', o)).toBe(true);
  });
  it('does not substring-match other agents', async () => {
    const o = mk('User-agent: *\nDisallow: /\n\nUser-agent: pitchlab-research-evil\nAllow: /\n');
    expect(await robotsAllows('https://c2.test/x', o)).toBe(false);
  });
  it('supports wildcards and $', async () => {
    const o = mk('User-agent: *\nDisallow: /*.pdf$\n');
    expect(await robotsAllows('https://w.test/a/b.pdf', o)).toBe(false);
    expect(await robotsAllows('https://w.test/a/b.pdf.html', o)).toBe(true);
  });
  it('caches per origin for 24h', async () => {
    const o = mk('User-agent: *\nDisallow:\n');
    let t = 1000;
    const now = () => t;
    await robotsAllows('https://d.test/a', { ...o, now });
    await robotsAllows('https://d.test/b', { ...o, now });
    expect(o.calls).toHaveLength(1);
    t += 25 * 3600 * 1000;
    await robotsAllows('https://d.test/c', { ...o, now });
    expect(o.calls).toHaveLength(2);
  });
  it('caches failures for only 10 minutes', async () => {
    const o = mk('err', 503);
    let t = 0;
    const now = () => t;
    expect(await robotsAllows('https://fc.test/a', { ...o, now })).toBe(false);
    t += 5 * 60 * 1000;
    await robotsAllows('https://fc.test/a', { ...o, now });
    expect(o.calls).toHaveLength(1);
    t += 6 * 60 * 1000;
    await robotsAllows('https://fc.test/a', { ...o, now });
    expect(o.calls).toHaveLength(2);
  });
  it('404 allows', async () => {
    expect(await robotsAllows('https://e.test/x', mk('nope', 404))).toBe(true);
  });
  it('unreachable allows', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;
    expect(await robotsAllows('https://f.test/x', { fetch, lookup })).toBe(true);
  });
  it('5xx disallows', async () => {
    expect(await robotsAllows('https://g.test/x', mk('err', 503))).toBe(false);
  });
  it('timeout disallows', async () => {
    const fetchPage = async () => ({ ok: false, status: 0, finalUrl: '', title: '', text: '', reason: 'timeout' as const });
    expect(await robotsAllows('https://h.test/x', { fetchPage })).toBe(false);
  });
  it('private and loopback origins are denied with no network call', async () => {
    const o = mk('User-agent: *\nDisallow:\n');
    for (const u of ['http://10.0.0.5/x', 'http://localhost/x', 'http://169.254.169.254/latest', 'http://[::1]/x']) {
      expect(await robotsAllows(u, { fetch: o.fetch })).toBe(false);
    }
    expect(o.calls).toHaveLength(0);
  });
  it('a redirect to a private IP is denied', async () => {
    const calls: string[] = [];
    const fetch = (async (u: string | URL | Request) => {
      calls.push(String(u));
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/robots.txt' } });
    }) as typeof globalThis.fetch;
    expect(await robotsAllows('https://redir.test/x', { fetch, lookup })).toBe(false);
    expect(calls).toEqual(['https://redir.test/robots.txt']);
  });
});

describe('matches', () => {
  it('is linear on hostile patterns', () => {
    const t0 = Date.now();
    const pattern = '/' + '*a'.repeat(50) + 'b$';
    expect(matches('/' + 'a'.repeat(5000), pattern)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
  });
  it('handles basic globs', () => {
    expect(matches('/a/b/c.pdf', '/a/*/c.pdf$')).toBe(true);
    expect(matches('/a/b/c.pdf?x', '/a/*/c.pdf$')).toBe(false);
    expect(matches('/abc', '/a*c')).toBe(true);
  });
});
