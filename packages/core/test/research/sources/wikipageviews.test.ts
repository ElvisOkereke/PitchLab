import { describe, expect, it } from 'vitest';
import { parseFacts } from '../../../src/library/kinds';
import { pageviewWindow, trendDirection, wikiTrend } from '../../../src/research/sources/wikipageviews';

const NOW = new Date('2026-10-29T12:00:00Z');
const noSleep = async () => {};

/** 36 monthly rows from Oct 2023 to Sep 2026: `first` a month for months 0-11, `prev` for 12-23, `last` for 24-35. */
function series(first: number, prev: number, last: number) {
  const items: { timestamp: string; views: number }[] = [];
  for (let i = 0; i < 36; i++) {
    const d = new Date(Date.UTC(2023, 9 + i, 1));
    items.push({
      timestamp: `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}0100`,
      views: i < 12 ? first : i < 24 ? prev : last,
    });
  }
  return { items };
}
function api(opensearch: unknown, views: unknown, viewsStatus = 200) {
  const urls: URL[] = [];
  const impl = (async (u: string | URL | Request) => {
    const url = new URL(String(u));
    urls.push(url);
    if (url.host === 'en.wikipedia.org') return new Response(JSON.stringify(opensearch));
    return new Response(JSON.stringify(views), { status: viewsStatus });
  }) as typeof fetch;
  return { impl, urls };
}
const OPEN = (t: string) => ['heat pump', [t], [''], [`https://en.wikipedia.org/wiki/${t}`]];
const run = (a: ReturnType<typeof api>, topic = 'heat pump', log?: (m: string) => void) =>
  wikiTrend(topic, { fetch: a.impl, now: () => NOW, sleep: noSleep, log });

describe('trendDirection', () => {
  it('uses the 20% thresholds (exactly +20% rising, exactly -20% falling)', () => {
    expect(trendDirection(100, 120)).toBe('rising');
    expect(trendDirection(100, 80)).toBe('falling');
    expect(trendDirection(100, 119)).toBe('steady');
    expect(trendDirection(100, 81)).toBe('steady');
    expect(trendDirection(100, 105)).toBe('steady');
  });
  it('handles a zero previous period', () => {
    expect(trendDirection(0, 5)).toBe('rising');
    expect(trendDirection(0, 0)).toBe('steady');
  });
});

describe('pageviewWindow', () => {
  it('covers the 36 full months before now', () => {
    expect(pageviewWindow(NOW)).toMatchObject({ start: '2023100100', end: '2026093000' });
    expect(pageviewWindow(new Date('2026-01-05T00:00:00Z'))).toMatchObject({ start: '2023010100', end: '2025123100' });
  });
});

describe('wikiTrend', () => {
  it('resolves via OpenSearch, requests the 36-month window and builds a valid trend draft', async () => {
    const a = api(OPEN('Heat pump'), series(100, 100, 134));
    const d = await run(a);
    expect(d).not.toBeNull();
    const o = a.urls[0]!;
    expect(o.searchParams.get('action')).toBe('opensearch');
    expect(o.searchParams.get('limit')).toBe('1');
    expect(o.searchParams.get('search')).toBe('heat pump');
    expect(a.urls[1]!.host).toBe('wikimedia.org');
    expect(a.urls[1]!.pathname).toBe(
      '/api/rest_v1/metrics/pageviews/per-article/en.wikipedia.org/all-access/user/Heat_pump/monthly/2023100100/2026093000',
    );
    expect(d!.kind).toBe('trend');
    expect(d!.title).toContain('Heat pump');
    expect(d!.summary).toBe("Wikipedia views of 'Heat pump' rose 34% (last 12 months vs the 12 before)");
    expect(d!.voice).toBe('neutral');
    expect(d!.source).toMatchObject({
      domain: 'en.wikipedia.org',
      sourceType: 'wikipedia',
      quoteVerified: false,
      url: 'https://en.wikipedia.org/wiki/Heat_pump',
    });
    expect(() => parseFacts('trend', d!.facts)).not.toThrow();
    expect(d!.facts).toMatchObject({ topic: 'Heat pump', direction: 'rising', basis: 'measured', window: 'last 36 full months' });
  });

  it('names the resolved article, not the request (a mismatch is visible)', async () => {
    const d = await run(api(OPEN('Mercury (element)'), series(100, 100, 100)), 'mercury');
    expect(d!.title).toContain('Mercury (element)');
    expect((d!.facts as { topic: string }).topic).toBe('Mercury (element)');
  });

  it('encodes the article path', async () => {
    const a = api(OPEN('AC/DC: Live & loud'), series(100, 100, 100));
    await run(a);
    expect(a.urls[1]!.pathname).toContain('/user/AC%2FDC%3A_Live_%26_loud/monthly/');
  });

  it('gives the direction for +25%, -25% and +5%', async () => {
    expect((await run(api(OPEN('A'), series(0, 100, 125))))!.facts).toMatchObject({ direction: 'rising' });
    const down = await run(api(OPEN('A'), series(0, 100, 75)));
    expect(down!.facts).toMatchObject({ direction: 'falling' });
    expect(down!.summary).toBe("Wikipedia views of 'A' fell 25% (last 12 months vs the 12 before)");
    const flat = await run(api(OPEN('A'), series(0, 100, 105)));
    expect(flat!.facts).toMatchObject({ direction: 'steady' });
    expect(flat!.summary).toContain('held steady');
  });

  it('skips a disambiguation page', async () => {
    const a = api(OPEN('Mercury (disambiguation)'), series(100, 100, 100));
    expect(await run(a, 'mercury')).toBeNull();
    expect(a.urls).toHaveLength(1);
  });

  it('rejects an article title made only of dots, with no pageview request', async () => {
    for (const t of ['..', '.', '...']) {
      const a = api(OPEN(t), series(100, 100, 100));
      expect(await run(a, 'dots')).toBeNull();
      expect(a.urls).toHaveLength(1);
    }
  });

  it('caps the title, summary and topic of a long article name', async () => {
    const d = await run(api(OPEN(`Heat ${'x'.repeat(400)}`), series(100, 100, 134)));
    expect(d!.title.length).toBeLessThanOrEqual(200);
    expect(d!.summary.length).toBeLessThanOrEqual(300);
    expect((d!.facts as { topic: string }).topic.length).toBeLessThanOrEqual(200);
    expect(() => parseFacts('trend', d!.facts)).not.toThrow();
  });

  it('skips a thin series (under 1,000 views in the window)', async () => {
    expect(await run(api(OPEN('Tiny'), series(1, 1, 1)))).toBeNull(); // 36 views
    expect(await run(api(OPEN('Edge'), series(0, 0, 83)))).toBeNull(); // 996
    expect(await run(api(OPEN('Edge'), series(0, 0, 84)))).not.toBeNull(); // 1,008
  });

  it('returns null when nothing resolves, when the article has no data, or the shape is unexpected', async () => {
    const logs: string[] = [];
    expect(await run(api(['x', [], [], []], series(1, 1, 1)))).toBeNull();
    expect(await run(api(OPEN('Ghost'), { detail: 'no data' }, 404))).toBeNull();
    expect(await run(api(OPEN('Odd'), { nothing: true }), 'odd', (m) => logs.push(m))).toBeNull();
    expect(logs).toHaveLength(1);
  });

  it('maps 429 to rate_limited', async () => {
    await expect(run(api(OPEN('Heat pump'), {}, 429))).rejects.toMatchObject({ code: 'rate_limited' });
  });
});
