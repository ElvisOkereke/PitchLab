import { describe, expect, it } from 'vitest';
import { parseFacts } from '../../../src/library/kinds';
import { INDICATORS, worldBankMarket } from '../../../src/research/sources/worldbank';

const noSleep = async () => {};
const row = (year: number, value: number | null) => ({ indicator: { id: 'x' }, country: { id: 'CA', value: 'Canada' }, date: String(year), value });
const ok = (rows: unknown[]) => [{ page: 1, pages: 1, per_page: 6, total: rows.length }, rows];

function api(route: (code: string) => unknown, status = 200) {
  const urls: URL[] = [];
  const impl = (async (u: string | URL | Request) => {
    const url = new URL(String(u));
    urls.push(url);
    const code = url.pathname.split('/').pop()!;
    return new Response(JSON.stringify(route(code)), { status });
  }) as typeof fetch;
  return { impl, urls };
}
// Newest first, as the API returns it.
const GOOD = (code: string) =>
  code === 'SP.POP.TOTL' ? ok([row(2023, 40_000_000), row(2022, 39_000_000), row(2018, 36_000_000)]) : ok([row(2023, 60), row(2022, 55)]);
const run = (a: ReturnType<typeof api>, iso = 'CA', log?: (m: string) => void) => worldBankMarket(iso, { fetch: a.impl, sleep: noSleep, log });

describe('worldBankMarket', () => {
  it('reads the six indicators for the country with mrv=6', async () => {
    const a = api(GOOD);
    await run(a);
    expect(a.urls.map((u) => u.pathname.split('/').pop())).toEqual([
      'SP.POP.TOTL', 'NY.GDP.PCAP.CD', 'IT.NET.USER.ZS', 'IT.CEL.SETS.P2', 'IC.BUS.NDNS.ZS', 'SP.URB.TOTL.IN.ZS',
    ]);
    expect(INDICATORS).toHaveLength(6);
    for (const u of a.urls) {
      expect(u.host).toBe('api.worldbank.org');
      expect(u.pathname.startsWith('/v2/country/CA/indicator/')).toBe(true);
      expect(u.searchParams.get('format')).toBe('json');
      expect(u.searchParams.get('mrv')).toBe('6');
    }
  });

  it('builds a valid market draft with size and growth clues', async () => {
    const d = await run(api(GOOD));
    expect(d!.kind).toBe('market');
    expect(d!.countries).toEqual(['CA']);
    expect(d!.title).toContain('Canada');
    expect(d!.voice).toBe('neutral');
    expect(d!.source).toMatchObject({ sourceType: 'worldbank', quoteVerified: false });
    const f = parseFacts('market', d!.facts) as {
      sizeClues: { metric: string; value: string; year: string }[];
      growthClues: { metric: string; change: string; period: string }[];
      geography: string;
    };
    expect(f.geography).toBe('Canada');
    expect(f.sizeClues).toHaveLength(6);
    expect(f.sizeClues[0]).toMatchObject({ metric: 'Population', value: '40,000,000', year: '2023' });
    // growth is the change between the oldest and newest returned years: 36M to 40M
    expect(f.growthClues[0]).toEqual({ metric: 'Population', change: '+11.1%', period: '2018–2023' });
    expect(f.growthClues[1]).toEqual({ metric: 'GDP per person', change: '+9.1%', period: '2022–2023' });
  });

  it('gives the two percentage indicators their growth in percentage points', async () => {
    const d = await run(api((c) => (c === 'IT.NET.USER.ZS' ? ok([row(2023, 92.5), row(2018, 88.4)]) : c === 'SP.URB.TOTL.IN.ZS' ? ok([row(2023, 81.2), row(2022, 82)]) : GOOD(c))));
    const g = (d!.facts as { growthClues: { metric: string; change: string; period: string }[] }).growthClues;
    expect(g.find((x) => x.metric === 'Internet users')).toEqual({ metric: 'Internet users', change: '+4.1 points', period: '2018–2023' });
    expect(g.find((x) => x.metric === 'Urban population')).toEqual({ metric: 'Urban population', change: '-0.8 points', period: '2022–2023' });
    // Rates per 100 or per 1,000 people keep the relative change.
    expect(g.find((x) => x.metric === 'Mobile subscriptions')).toEqual({ metric: 'Mobile subscriptions', change: '+9.1%', period: '2022–2023' });
  });

  it('skips null values in a series', async () => {
    const d = await run(
      api((c) => (c === 'SP.POP.TOTL' ? ok([row(2023, null), row(2022, 110), row(2021, null), row(2020, 100)]) : ok([row(2023, null)]))),
    );
    const f = d!.facts as { sizeClues: unknown[]; growthClues: unknown[] };
    expect(f.sizeClues).toEqual([{ metric: 'Population', value: '110', unit: 'people', year: '2022' }]);
    expect(f.growthClues).toEqual([{ metric: 'Population', change: '+10.0%', period: '2020–2022' }]);
  });

  it('returns null for the error-object shape and logs', async () => {
    const logs: string[] = [];
    const a = api(() => [{ message: [{ id: '120', key: 'Invalid value', value: 'The provided parameter value is not valid' }] }]);
    expect(await run(a, 'ZZ', (m) => logs.push(m))).toBeNull();
    expect(logs.length).toBeGreaterThan(0);
  });

  it('keeps going when one indicator has the wrong shape', async () => {
    const d = await run(api((c) => (c === 'NY.GDP.PCAP.CD' ? [{ message: [] }] : GOOD(c))));
    expect((d!.facts as { sizeClues: unknown[] }).sizeClues).toHaveLength(5);
  });

  it('rejects a bad country code without a request', async () => {
    const a = api(GOOD);
    expect(await run(a, 'canada')).toBeNull();
    expect(await run(a, 'global')).toBeNull();
    expect(a.urls).toHaveLength(0);
  });

  it('maps 429 to rate_limited', async () => {
    await expect(run(api(() => ({}), 429))).rejects.toMatchObject({ code: 'rate_limited' });
  });
});
