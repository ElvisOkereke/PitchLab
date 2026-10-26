import { beforeEach, describe, expect, it } from 'vitest';
import { resetRobotsCache, robotsAllows } from '../../src/research/robots';

function mk(body: string, status = 200) {
  const calls: string[] = [];
  const impl = (async (u: string | URL | Request) => {
    calls.push(String(u));
    return new Response(body, { status });
  }) as typeof fetch;
  return { impl, calls };
}

beforeEach(() => resetRobotsCache());

describe('robotsAllows', () => {
  it('honours Disallow for *', async () => {
    const { impl } = mk('User-agent: *\nDisallow: /private\n');
    expect(await robotsAllows('https://a.test/private/x', { fetch: impl })).toBe(false);
    expect(await robotsAllows('https://a.test/public', { fetch: impl })).toBe(true);
  });
  it('longest match wins, Allow overrides a shorter Disallow', async () => {
    const { impl } = mk('User-agent: *\nDisallow: /docs\nAllow: /docs/open\n');
    expect(await robotsAllows('https://b.test/docs/secret', { fetch: impl })).toBe(false);
    expect(await robotsAllows('https://b.test/docs/open/a', { fetch: impl })).toBe(true);
  });
  it('prefers the pitchlab group over *', async () => {
    const { impl } = mk('User-agent: *\nDisallow: /\n\nUser-agent: pitchlab-research\nAllow: /\n');
    expect(await robotsAllows('https://c.test/x', { fetch: impl })).toBe(true);
  });
  it('supports wildcards and $', async () => {
    const { impl } = mk('User-agent: *\nDisallow: /*.pdf$\n');
    expect(await robotsAllows('https://w.test/a/b.pdf', { fetch: impl })).toBe(false);
    expect(await robotsAllows('https://w.test/a/b.pdf.html', { fetch: impl })).toBe(true);
  });
  it('caches per origin for 24h', async () => {
    const { impl, calls } = mk('User-agent: *\nDisallow:\n');
    let t = 1000;
    const now = () => t;
    await robotsAllows('https://d.test/a', { fetch: impl, now });
    await robotsAllows('https://d.test/b', { fetch: impl, now });
    expect(calls).toHaveLength(1);
    t += 25 * 3600 * 1000;
    await robotsAllows('https://d.test/c', { fetch: impl, now });
    expect(calls).toHaveLength(2);
  });
  it('404 allows', async () => {
    const { impl } = mk('nope', 404);
    expect(await robotsAllows('https://e.test/x', { fetch: impl })).toBe(true);
  });
  it('unreachable allows', async () => {
    const impl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await robotsAllows('https://f.test/x', { fetch: impl })).toBe(true);
  });
  it('5xx disallows', async () => {
    const { impl } = mk('err', 503);
    expect(await robotsAllows('https://g.test/x', { fetch: impl })).toBe(false);
  });
  it('timeout disallows', async () => {
    const impl = (async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as typeof fetch;
    expect(await robotsAllows('https://h.test/x', { fetch: impl })).toBe(false);
  });
});
