import { describe, expect, it } from 'vitest';
import { parseFacts } from '../../../src/library/kinds';
import { hnTrend } from '../../../src/research/sources/hntrend';

const NOW = new Date('2026-10-29T12:00:00Z');
const noSleep = async () => {};
const sec = (y: number) => Math.floor(Date.UTC(y, 0, 1) / 1000);

function api(counts: unknown[], status = 200) {
  const urls: URL[] = [];
  let i = 0;
  const impl = (async (u: string | URL | Request) => {
    urls.push(new URL(String(u)));
    const c = counts[i++];
    return new Response(JSON.stringify(c === undefined ? {} : typeof c === 'number' ? { nbHits: c } : c), { status });
  }) as typeof fetch;
  return { impl, urls };
}
const run = (a: ReturnType<typeof api>, q = 'heat pump', log?: (m: string) => void) =>
  hnTrend(q, { fetch: a.impl, now: () => NOW, sleep: noSleep, log });

describe('hnTrend', () => {
  it('counts stories for each of the last 4 complete years with the right filters', async () => {
    const a = api([10, 12, 20, 30]);
    const d = await run(a);
    expect(a.urls).toHaveLength(4);
    [2022, 2023, 2024, 2025].forEach((y, i) => {
      const u = a.urls[i]!;
      expect(u.host).toBe('hn.algolia.com');
      expect(u.pathname).toBe('/api/v1/search_by_date');
      expect(u.searchParams.get('query')).toBe('heat pump');
      expect(u.searchParams.get('tags')).toBe('story');
      expect(u.searchParams.get('hitsPerPage')).toBe('0');
      expect(u.searchParams.get('numericFilters')).toBe(`created_at_i>=${sec(y)},created_at_i<${sec(y + 1)}`);
    });
    expect(d!.kind).toBe('trend');
    expect(d!.source).toMatchObject({ domain: 'hn.algolia.com', sourceType: 'hn', quoteVerified: false });
    expect(d!.source.url).toContain('hn.algolia.com');
    expect(d!.summary).toBe("Hacker News stories about 'heat pump' rose 50% (2025 vs 2024)");
    expect(d!.facts).toMatchObject({ direction: 'rising', basis: 'measured', topic: 'heat pump' });
    expect((d!.facts as { evidence: { value: string }[] }).evidence.map((e) => e.value)).toEqual(['10', '12', '20', '30']);
    expect(() => parseFacts('trend', d!.facts)).not.toThrow();
  });

  it('compares the last full year with the year before', async () => {
    expect((await run(api([50, 50, 100, 70])))!.facts).toMatchObject({ direction: 'falling' });
    expect((await run(api([50, 50, 100, 105])))!.facts).toMatchObject({ direction: 'steady' });
    expect((await run(api([5, 5, 0, 12])))!.facts).toMatchObject({ direction: 'rising' });
  });

  it('skips fewer than 20 stories in total', async () => {
    expect(await run(api([5, 5, 5, 4]))).toBeNull();
    expect(await run(api([5, 5, 5, 5]))).not.toBeNull();
  });

  it('returns null and logs when nbHits is missing', async () => {
    const logs: string[] = [];
    expect(await run(api([10, {}, 10, 10]), 'x', (m) => logs.push(m))).toBeNull();
    expect(logs).toHaveLength(1);
    expect(await run(api([10, 10, 10, { nbHits: '12' }]))).toBeNull();
  });

  it('maps 429 to rate_limited', async () => {
    await expect(run(api([1], 429))).rejects.toMatchObject({ code: 'rate_limited' });
  });
});
