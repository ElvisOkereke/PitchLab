import { describe, expect, it } from 'vitest';
import { libraryFilter, libraryHref, parseLibraryQuery } from '@/lib/library-query';

const ID = '11111111-1111-4111-8111-111111111111';

describe('parseLibraryQuery', () => {
  it('defaults: no filters, active entries, page 1', () => {
    expect(parseLibraryQuery({})).toEqual({ q: '', status: 'active', page: 1 });
  });

  it('keeps valid values and drops invalid ones (allow-lists, uuid, clamped page)', () => {
    const q = parseLibraryQuery({ q: ' invoices ', kind: 'pricing', audience: 'consumer', voice: 'operator', country: 'ca', source: 'hn', age: '30', status: 'all', page: '3', item: ID });
    expect(q).toEqual({ q: 'invoices', kind: 'pricing', audience: 'consumer', voice: 'operator', country: 'CA', source: 'hn', age: 30, status: 'all', page: 3, item: ID });
    expect(parseLibraryQuery({ kind: 'nope', audience: 'x', voice: '<b>', country: 'Canada', age: '5', status: 'zzz', page: '-2', item: 'not-a-uuid', source: 'a b' })).toEqual({ q: '', status: 'active', page: 1 });
  });

  it('uses the first of repeated values and caps the search text', () => {
    expect(parseLibraryQuery({ kind: ['problem', 'pricing'] }).kind).toBe('problem');
    expect(parseLibraryQuery({ q: 'x'.repeat(500) }).q).toHaveLength(100);
  });
});

describe('libraryHref / libraryFilter', () => {
  it('builds a canonical URL without defaults and round-trips', () => {
    expect(libraryHref({ q: '', status: 'active', page: 1 })).toBe('/library');
    const q = { q: 'a b', kind: 'problem' as const, status: 'rejected' as const, page: 2, age: 7 as const, item: ID };
    expect(libraryHref(q)).toBe(`/library?q=a+b&kind=problem&age=7&status=rejected&page=2&item=${ID}`);
    expect(parseLibraryQuery(Object.fromEntries(new URL(libraryHref(q), 'http://x').searchParams))).toEqual(q);
  });

  it('maps to the core filter', () => {
    expect(libraryFilter({ q: 'x', kind: 'pricing', country: 'CA', source: 'hn', age: 90, status: 'all', page: 2 })).toEqual({
      text: 'x', kinds: ['pricing'], country: 'CA', sourceType: 'hn', maxAgeDays: 90, status: 'all', page: 2,
    });
  });
});
