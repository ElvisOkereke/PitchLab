import { describe, expect, it } from 'vitest';
import { federalRegisterSearch } from '../../../src/research/sources/federalregister';
import { SourceError } from '../../../src/research/http';

const NOW = new Date('2026-10-29T12:00:00Z');
const noSleep = async () => {};
function api(body: unknown, status = 200) {
  const urls: URL[] = [];
  const impl = (async (u: string | URL | Request) => {
    urls.push(new URL(String(u)));
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, urls };
}
const doc = (i: number, extra: Record<string, unknown> = {}) => ({
  title: `Rule ${i}`,
  abstract: `Abstract <b>${i}</b> about heat pumps`,
  html_url: `https://www.federalregister.gov/documents/2026/05/01/${i}/rule-${i}`,
  effective_on: '2026-07-01',
  publication_date: '2026-05-01',
  type: 'Rule',
  ...extra,
});
const run = (a: ReturnType<typeof api>, q = 'x', log?: (m: string) => void) =>
  federalRegisterSearch(q, { fetch: a.impl, now: () => NOW, sleep: noSleep, log });

describe('federalRegisterSearch', () => {
  it('maps documents to text items with hints', async () => {
    const items = await run(api({ results: [doc(1), doc(2, { type: 'Proposed Rule', effective_on: null })] }), 'heat pumps');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      source: 'federalregister',
      title: 'Rule 1',
      url: 'https://www.federalregister.gov/documents/2026/05/01/1/rule-1',
      hints: { effectiveDate: '2026-07-01', publishedDate: '2026-05-01', status: 'final' },
    });
    expect(items[0]!.text).toBe('Rule 1. Abstract 1 about heat pumps');
    expect(items[0]!.publishedAt?.toISOString().slice(0, 10)).toBe('2026-05-01');
    expect(items[1]!.hints).toMatchObject({ effectiveDate: null, status: 'proposed' });
  });

  it('asks for rules and proposed rules from the last 24 months, 10 at most', async () => {
    const a = api({ results: [] });
    await run(a, 'heat pumps');
    const u = a.urls[0]!;
    expect(u.host).toBe('www.federalregister.gov');
    expect(u.searchParams.get('conditions[term]')).toBe('heat pumps');
    expect(u.searchParams.getAll('conditions[type][]')).toEqual(['RULE', 'PRORULE']);
    expect(u.searchParams.get('conditions[publication_date][gte]')).toBe('2024-10-29');
    expect(u.searchParams.get('per_page')).toBe('10');
    expect(u.searchParams.get('order')).toBe('newest');
  });

  it('returns at most 10 items', async () => {
    expect(await run(api({ results: Array.from({ length: 14 }, (_, i) => doc(i + 1)) }))).toHaveLength(10);
  });

  it('returns [] and logs when results is missing (HTTP 200, unexpected shape)', async () => {
    const logs: string[] = [];
    expect(await run(api({ count: 0 }), 'x', (m) => logs.push(m))).toEqual([]);
    expect(logs).toHaveLength(1);
  });

  it('stores a malformed or missing date as null', async () => {
    const items = await run(api({ results: [doc(1, { effective_on: '2026-13-45', publication_date: 'soon' }), doc(2, { effective_on: undefined })] }));
    expect(items[0]!.hints).toMatchObject({ effectiveDate: null, publishedDate: null });
    expect(items[0]!.publishedAt).toBeNull();
    expect(items[1]!.hints).toMatchObject({ effectiveDate: null, publishedDate: '2026-05-01' });
  });

  it('skips documents without a title or a federalregister.gov url', async () => {
    expect(await run(api({ results: [doc(1, { title: '' }), doc(2, { html_url: 'https://evil.example/x' }), doc(3)] }))).toHaveLength(1);
  });

  it('maps 429 to rate_limited', async () => {
    const p = run(api({}, 429));
    await expect(p).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(run(api({}, 429))).rejects.toBeInstanceOf(SourceError);
  });
});
