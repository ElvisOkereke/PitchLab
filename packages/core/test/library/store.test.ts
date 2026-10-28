import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb, unit } from '../helpers/db';
import { knowledgeItems, knowledgeSources } from '../../src/db/schema';
import type { KnowledgeDraft } from '../../src/library/kinds';
import {
  contentHash, upsertKnowledgeItem, rejectItem, restoreItem, searchLibrary, getLibraryItem, libraryCoverage, retrieveForRun,
} from '../../src/library/store';

/** Unit vector with cosine `s` to unit(0). */
const near = (s: number, dim = 1): number[] => { const v = unit(0).map(() => 0); v[0] = s; v[dim] = Math.sqrt(1 - s * s); return v; };

type Over = Partial<KnowledgeDraft> & { url?: string; domain?: string; publishedAt?: Date };
let n = 0;
function draft(o: Over = {}): KnowledgeDraft {
  n++;
  const { url, domain, publishedAt, ...rest } = o;
  return {
    kind: 'problem', title: `Title ${n}`, summary: `Summary ${n}`, quote: `quote ${n}`, audience: 'business',
    countries: ['US'], industries: ['retail'], voice: 'neutral', facts: { persona: 'p' },
    source: { url: url ?? `https://a.example/${n}`, domain: domain ?? 'a.example', sourceType: 'hn', publishedAt, quote: `quote ${n}`, quoteVerified: true },
    ...rest,
  };
}
const unverifiedSource = (url: string, domain: string, sourceType = 'hn') => ({ url, domain, sourceType, quoteVerified: false });

describe('contentHash', () => {
  it('ignores case and whitespace in the title, differs by kind', () => {
    const a = draft({ title: 'Hello  World' });
    expect(contentHash(a)).toBe(contentHash({ ...a, title: 'hello world' }));
    expect(contentHash(a)).not.toBe(contentHash({ ...a, kind: 'pricing' }));
  });
});

describe('upsertKnowledgeItem', () => {
  it('adds, then duplicates on same hash (new source added), then merges at similarity 0.95', async () => {
    const db = await testDb();
    const d = draft();
    const a = await upsertKnowledgeItem(db, d, unit(0), {});
    expect(a.outcome).toBe('added');
    const b = await upsertKnowledgeItem(db, { ...d, source: { ...d.source, url: 'https://b.example/x', domain: 'b.example' } }, unit(5), {});
    expect(b).toEqual({ outcome: 'duplicate', itemId: a.itemId });
    const c = await upsertKnowledgeItem(db, draft({ url: 'https://c.example/x', domain: 'c.example' }), near(0.95), {});
    expect(c).toEqual({ outcome: 'merged', itemId: a.itemId });
    const srcs = await db.select().from(knowledgeSources).where(eq(knowledgeSources.itemId, a.itemId));
    expect(srcs).toHaveLength(3);
    const it = await getLibraryItem(db, a.itemId);
    expect(it?.title).toBe(d.title);
    expect(it?.sourceCount).toBe(3);
  });
  it('getLibraryItem returns each source via, snapshotAt and expiresAt', async () => {
    const db = await testDb();
    const snap = new Date('2025-03-04T12:00:00Z');
    const a = await upsertKnowledgeItem(db, draft({ source: { url: 'https://a.example/1', domain: 'a.example', sourceType: 'web', quote: 'q one', quoteVerified: true, via: 'archive', snapshotAt: snap } }), unit(0), {});
    await upsertKnowledgeItem(db, draft({ source: { url: 'https://www.youtube.com/watch?v=abc', domain: 'youtube.com', sourceType: 'youtube', quote: 'q two', quoteVerified: true } }), near(0.95), {});
    const srcs = (await getLibraryItem(db, a.itemId))!.sources;
    const arch = srcs.find((s) => s.url === 'https://a.example/1')!;
    expect(arch.via).toBe('archive');
    expect(arch.snapshotAt?.toISOString()).toBe(snap.toISOString());
    expect(arch.expiresAt).toBeNull();
    const yt = srcs.find((s) => s.sourceType === 'youtube')!;
    expect(yt.via).toBe('direct');
    expect(yt.expiresAt).toBeInstanceOf(Date);
  });
  it('same url twice adds one source', async () => {
    const db = await testDb();
    const d = draft();
    const a = await upsertKnowledgeItem(db, d, unit(0), {});
    await upsertKnowledgeItem(db, d, unit(0), {});
    expect(await db.select().from(knowledgeSources).where(eq(knowledgeSources.itemId, a.itemId))).toHaveLength(1);
  });
  it('does not merge across kinds, nor below 0.90', async () => {
    const db = await testDb();
    const a = await upsertKnowledgeItem(db, draft(), unit(0), {});
    const b = await upsertKnowledgeItem(db, draft({ kind: 'pricing', facts: { product: 'p', pricePoints: [], buyer: 'b', complaints: [] } }), near(0.95), {});
    expect(b.outcome).toBe('added');
    const c = await upsertKnowledgeItem(db, draft(), near(0.85), {});
    expect(c.outcome).toBe('added');
    expect(new Set([a.itemId, b.itemId, c.itemId]).size).toBe(3);
  });
  it('voice moves only toward more independent', async () => {
    const db = await testDb();
    const a = await upsertKnowledgeItem(db, draft({ voice: 'vendor' }), unit(0), {});
    expect((await upsertKnowledgeItem(db, draft({ voice: 'operator' }), near(0.95), {})).outcome).toBe('merged');
    expect((await getLibraryItem(db, a.itemId))?.voice).toBe('operator');
    await upsertKnowledgeItem(db, draft({ voice: 'vendor' }), near(0.95), {});
    expect((await getLibraryItem(db, a.itemId))?.voice).toBe('operator');
  });
  it('adopts a verified quote when the existing one is unverified', async () => {
    const db = await testDb();
    const a = await upsertKnowledgeItem(db, draft({ quote: 'old', source: unverifiedSource('https://a.example/1', 'a.example') }), unit(0), {});
    expect((await getLibraryItem(db, a.itemId))?.quoteVerified).toBe(false);
    await upsertKnowledgeItem(db, draft({ quote: 'verified one', source: { url: 'https://b.example/1', domain: 'b.example', sourceType: 'hn', quote: 'verified one', quoteVerified: true } }), near(0.95), {});
    const it = await getLibraryItem(db, a.itemId);
    expect(it?.quote).toBe('verified one');
    expect(it?.quoteVerified).toBe(true);
  });
  it('a verified-quote upgrade of the same source also takes the incoming via and snapshotAt', async () => {
    const db = await testDb();
    const u = 'https://a.example/1';
    const a = await upsertKnowledgeItem(db, draft({ quote: 'old', source: unverifiedSource(u, 'a.example') }), unit(0), {});
    const snapshotAt = new Date('2026-01-01T00:00:00Z');
    await upsertKnowledgeItem(db, draft({ quote: 'new verified', source: { url: u, domain: 'a.example', sourceType: 'web', quote: 'new verified', quoteVerified: true, via: 'archive', snapshotAt } }), near(0.95), {});
    const [src] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.itemId, a.itemId));
    expect(src).toMatchObject({ via: 'archive', quoteVerified: true });
    expect(src!.snapshotAt?.toISOString()).toBe(snapshotAt.toISOString());
  });
  it('keeps the existing verified quote when both are verified', async () => {
    const db = await testDb();
    const a = await upsertKnowledgeItem(db, draft({ quote: 'first', source: { url: 'https://a.example/1', domain: 'a.example', sourceType: 'hn', quote: 'first', quoteVerified: true } }), unit(0), {});
    await upsertKnowledgeItem(db, draft({ quote: 'second', source: { url: 'https://b.example/1', domain: 'b.example', sourceType: 'hn', quote: 'second', quoteVerified: true } }), near(0.95), {});
    expect((await getLibraryItem(db, a.itemId))?.quote).toBe('first');
  });
  it('leaves quote unchanged when both are unverified', async () => {
    const db = await testDb();
    const a = await upsertKnowledgeItem(db, draft({ quote: 'first', source: unverifiedSource('https://a.example/1', 'a.example') }), unit(0), {});
    await upsertKnowledgeItem(db, draft({ quote: 'second', source: unverifiedSource('https://b.example/1', 'b.example') }), near(0.95), {});
    const it = await getLibraryItem(db, a.itemId);
    expect(it?.quote).toBe('first');
    expect(it?.quoteVerified).toBe(false);
  });
  it('stores the verified source quote, never an unchecked model quote', async () => {
    const db = await testDb();
    const a = await upsertKnowledgeItem(db, draft({ quote: 'model words', source: { url: 'https://a.example/1', domain: 'a.example', sourceType: 'hn', quote: 'page words', quoteVerified: true } }), unit(0), {});
    const it = await getLibraryItem(db, a.itemId);
    expect(it?.quote).toBe('page words');
    expect(it?.quoteVerified).toBe(true);
    const b = await upsertKnowledgeItem(db, draft({ quote: 'model only', source: { url: 'https://b.example/1', domain: 'b.example', sourceType: 'hn', quote: 'page', quoteVerified: false } }), unit(7), {});
    expect((await getLibraryItem(db, b.itemId))?.quoteVerified).toBe(false);
    // merge adopts the source quote, not d.quote
    await upsertKnowledgeItem(db, draft({ quote: 'other model words', source: { url: 'https://c.example/1', domain: 'c.example', sourceType: 'hn', quote: 'verified page words', quoteVerified: true } }), (() => { const v = unit(7); v[7] = 0.95; v[8] = Math.sqrt(1 - 0.95 * 0.95); return v; })(), {});
    const m = await getLibraryItem(db, b.itemId);
    expect(m?.quote).toBe('verified page words');
    expect(m?.quoteVerified).toBe(true);
  });
  it('duplicate path also upgrades voice and adopts a verified quote', async () => {
    const db = await testDb();
    const d = draft({ voice: 'vendor', source: unverifiedSource('https://a.example/1', 'a.example') });
    const a = await upsertKnowledgeItem(db, d, unit(0), {});
    const r = await upsertKnowledgeItem(db, { ...d, voice: 'operator', source: { url: 'https://b.example/1', domain: 'b.example', sourceType: 'hn', quote: d.quote!, quoteVerified: true } }, unit(0), {});
    expect(r.outcome).toBe('duplicate');
    const it = await getLibraryItem(db, a.itemId);
    expect(it?.voice).toBe('operator');
    expect(it?.quoteVerified).toBe(true);
  });
  it('non-finite search inputs fall back to defaults', async () => {
    const db = await testDb();
    await upsertKnowledgeItem(db, draft(), unit(0), {});
    expect((await searchLibrary(db, { page: NaN, maxAgeDays: Infinity })).rows).toHaveLength(1);
    expect((await searchLibrary(db, { page: Infinity, maxAgeDays: NaN })).total).toBe(1);
  });
  it('merging into a rejected entry keeps it rejected', async () => {
    const db = await testDb();
    const a = await upsertKnowledgeItem(db, draft(), unit(0), {});
    await rejectItem(db, a.itemId, 'spam');
    const m = await upsertKnowledgeItem(db, draft(), near(0.95), {});
    expect(m).toEqual({ outcome: 'merged', itemId: a.itemId });
    expect((await getLibraryItem(db, a.itemId))?.status).toBe('rejected');
  });
});

describe('reject and restore', () => {
  it('toggles status and reports whether a row matched', async () => {
    const db = await testDb();
    const a = await upsertKnowledgeItem(db, draft(), unit(0), {});
    expect(await rejectItem(db, a.itemId, 'bad')).toBe(true);
    const [r] = await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, a.itemId));
    expect(r?.status).toBe('rejected');
    expect(r?.rejectReason).toBe('bad');
    expect(await restoreItem(db, a.itemId)).toBe(true);
    const [r2] = await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, a.itemId));
    expect(r2?.status).toBe('active');
    expect(r2?.rejectReason).toBeNull();
    expect(await rejectItem(db, '00000000-0000-0000-0000-000000000000')).toBe(false);
    expect(await restoreItem(db, '00000000-0000-0000-0000-000000000000')).toBe(false);
  });
});

describe('searchLibrary', () => {
  it('filters', async () => {
    const db = await testDb();
    await upsertKnowledgeItem(db, draft({ title: 'Invoice chaos', countries: ['CA'], industries: ['finance'], voice: 'operator' }), unit(0), {});
    await upsertKnowledgeItem(db, draft({ title: 'Cold chain', countries: ['US'], industries: ['food'], audience: 'consumer' }), unit(10), {});
    const old = await upsertKnowledgeItem(db, draft({ title: 'Ancient', url: 'https://o.example/1', domain: 'o.example', publishedAt: new Date('2015-01-01') }), unit(20), {});
    await db.update(knowledgeSources).set({ sourceType: 'reddit' }).where(eq(knowledgeSources.itemId, old.itemId));
    const all = (f: Parameters<typeof searchLibrary>[1]) => searchLibrary(db, f);
    expect((await all({ text: 'invoice' })).rows.map((r) => r.title)).toEqual(['Invoice chaos']);
    expect((await all({ text: '100%' })).total).toBe(0);
    expect((await all({ country: 'CA' })).total).toBe(1);
    expect((await all({ industry: 'food' })).total).toBe(1);
    expect((await all({ voice: 'operator' })).total).toBe(1);
    expect((await all({ audience: 'consumer' })).total).toBe(1);
    expect((await all({ kinds: ['pricing'] })).total).toBe(0);
    expect((await all({ sourceType: 'reddit' })).rows[0]?.id).toBe(old.itemId);
    expect((await all({ maxAgeDays: 365 })).total).toBe(2);
    await rejectItem(db, old.itemId);
    expect((await all({})).total).toBe(2);
    expect((await all({ status: 'rejected' })).total).toBe(1);
    expect((await all({ status: 'all' })).total).toBe(3);
  });
  it('orders by similarity when a query vector is given', async () => {
    const db = await testDb();
    await upsertKnowledgeItem(db, draft({ title: 'far' }), unit(10), {});
    await upsertKnowledgeItem(db, draft({ title: 'close' }), near(0.8), {});
    const { rows } = await searchLibrary(db, { queryVector: unit(0) });
    expect(rows.map((r) => r.title)).toEqual(['close', 'far']);
  });
  it('pages at 50 with a total', async () => {
    const db = await testDb();
    for (let i = 0; i < 51; i++) await upsertKnowledgeItem(db, draft({ title: `Row ${i}` }), unit(100 + i), {});
    const p1 = await searchLibrary(db, {});
    expect(p1.rows).toHaveLength(50);
    expect(p1.total).toBe(51);
    const p2 = await searchLibrary(db, { page: 2 });
    expect(p2.rows).toHaveLength(1);
  });
});

describe('libraryCoverage', () => {
  it('counts active entries', async () => {
    const db = await testDb();
    await upsertKnowledgeItem(db, draft({ voice: 'operator', countries: ['CA'], industries: ['a'] }), unit(0), {});
    await upsertKnowledgeItem(db, draft({ voice: 'vendor', quote: undefined, countries: ['US'], industries: ['b'], source: unverifiedSource('https://z.example/1', 'z.example', 'reddit') }), unit(1), {});
    const gone = await upsertKnowledgeItem(db, draft(), unit(2), {});
    await rejectItem(db, gone.itemId);
    const c = await libraryCoverage(db);
    expect(c.byKind).toEqual({ problem: 2 });
    expect(c.bySourceType).toEqual({ hn: 1, reddit: 1 });
    expect(c.byVoice).toEqual({ operator: 1, vendor: 1 });
    expect(c.problemIndependentShare).toBe(0.5);
    expect(c.verifiedQuoteShare).toBe(0.5);
    expect(c.countries).toEqual(['CA', 'US']);
    expect(c.industries).toEqual(['a', 'b']);
    expect(c.newest).toBeInstanceOf(Date);
    expect(c.oldest).toBeInstanceOf(Date);
  });
  it('socialShare is the share of active sources from social/community source types', async () => {
    const db = await testDb();
    await upsertKnowledgeItem(db, draft({ source: unverifiedSource('https://y.example/1', 'y.example', 'youtube') }), unit(0), {});
    await upsertKnowledgeItem(db, draft({ source: unverifiedSource('https://y.example/2', 'y.example', 'producthunt') }), unit(1), {});
    await upsertKnowledgeItem(db, draft({ source: unverifiedSource('https://y.example/3', 'y.example', 'web') }), unit(2), {});
    await upsertKnowledgeItem(db, draft({ source: unverifiedSource('https://y.example/4', 'y.example', 'reddit') }), unit(3), {});
    const gone = await upsertKnowledgeItem(db, draft({ source: unverifiedSource('https://y.example/5', 'y.example', 'hn') }), unit(4), {});
    await rejectItem(db, gone.itemId);
    expect((await libraryCoverage(db)).socialShare).toBe(0.5);
  });
  it('is null-safe when empty', async () => {
    const c = await libraryCoverage(await testDb());
    expect(c.socialShare).toBeNull();
    expect(c.problemIndependentShare).toBeNull();
    expect(c.verifiedQuoteShare).toBeNull();
    expect(c.newest).toBeNull();
  });
});

describe('retrieveForRun', () => {
  const yearsAgo = (y: number) => new Date(Date.now() - y * 365.25 * 864e5);
  it('excludes unverified, rejected and startup entries', async () => {
    const db = await testDb();
    const ok = await upsertKnowledgeItem(db, draft({ title: 'ok' }), unit(0), {});
    const unv = await upsertKnowledgeItem(db, draft({ title: 'unverified', source: unverifiedSource('https://u.example/1', 'u.example') }), near(0.7, 1), {});
    const rej = await upsertKnowledgeItem(db, draft({ title: 'rej', domain: 'r.example', url: 'https://r.example/1' }), near(0.6, 2), {});
    await rejectItem(db, rej.itemId);
    await upsertKnowledgeItem(db, draft({ title: 'startup', kind: 'startup', facts: { name: 'n', whatItDoes: 'x', businessModel: 'b', outcome: 'dead' } }), near(0.5, 3), {});
    // the unverified entry exists, is active and unverified, and would rank without the filter
    const u = await getLibraryItem(db, unv.itemId);
    expect(u?.status).toBe('active');
    expect(u?.quoteVerified).toBe(false);
    const visible = await searchLibrary(db, { queryVector: unit(0) });
    expect(visible.rows.map((r) => r.title)).toContain('unverified');
    expect(visible.rows.map((r) => r.title)).not.toContain('rej');
    const rows = await retrieveForRun(db, unit(0), { limit: 10 });
    expect(rows.map((r) => r.id)).toEqual([ok.itemId]);
  });
  it('applies voice bonus and age penalty', async () => {
    const db = await testDb();
    // vendor 0.90; operator 0.87 + 0.05 = 0.92; vendor 0.93 but 5 years old: 0.93 - 0.15 = 0.78
    await upsertKnowledgeItem(db, draft({ title: 'vendor', voice: 'vendor', domain: 'v.example', url: 'https://v.example/1', publishedAt: new Date() }), near(0.9, 2), {});
    await upsertKnowledgeItem(db, draft({ title: 'operator', voice: 'operator', domain: 'o.example', url: 'https://o.example/1', publishedAt: new Date() }), near(0.87, 3), {});
    await upsertKnowledgeItem(db, draft({ title: 'old', voice: 'vendor', domain: 'x.example', url: 'https://x.example/1', publishedAt: yearsAgo(5) }), near(0.93, 4), {});
    const rows = await retrieveForRun(db, unit(0), { limit: 10 });
    expect(rows.map((r) => r.title)).toEqual(['operator', 'vendor', 'old']);
  });
  it('penalises 0.05 per year beyond 2, nothing before', async () => {
    const db = await testDb();
    // 1.5y sim 0.80 -> 0.80; 3y sim 0.84 -> 0.79; fresh sim 0.70 -> 0.70.
    // (a per-year-from-zero formula would order them 1.5y, fresh, 3y)
    await upsertKnowledgeItem(db, draft({ title: 'fresh', voice: 'vendor', domain: 'f.example', url: 'https://f.example/1', publishedAt: new Date() }), near(0.7, 2), {});
    await upsertKnowledgeItem(db, draft({ title: 'y1.5', voice: 'vendor', domain: 'a.example', url: 'https://a1.example/1', publishedAt: yearsAgo(1.5) }), near(0.8, 3), {});
    await upsertKnowledgeItem(db, draft({ title: 'y3', voice: 'vendor', domain: 'b.example', url: 'https://b1.example/1', publishedAt: yearsAgo(3) }), near(0.84, 4), {});
    const rows = await retrieveForRun(db, unit(0), { limit: 10 });
    expect(rows.map((r) => r.title)).toEqual(['y1.5', 'y3', 'fresh']);
  });
  it('does not starve results when a few domains cluster', async () => {
    const db = await testDb();
    for (let i = 0; i < 20; i++) {
      await upsertKnowledgeItem(db, draft({ domain: 'one.example', url: `https://one.example/${i}` }), near(0.9 - i * 0.01, 10 + i), {});
      await upsertKnowledgeItem(db, draft({ domain: 'two.example', url: `https://two.example/${i}` }), near(0.9 - i * 0.01, 40 + i), {});
    }
    for (let i = 0; i < 10; i++) await upsertKnowledgeItem(db, draft({ domain: `o${i}.example`, url: `https://o${i}.example/1` }), near(0.3, 70 + i), {});
    expect(await retrieveForRun(db, unit(0), { limit: 30 })).toHaveLength(16);
  });
  it('treats non-finite limit as the default', async () => {
    const db = await testDb();
    await upsertKnowledgeItem(db, draft(), unit(0), {});
    expect(await retrieveForRun(db, unit(0), { limit: NaN })).toHaveLength(1);
    expect(await retrieveForRun(db, unit(0), { limit: Infinity })).toHaveLength(1);
  });
  it('caps 3 per domain and limit at 30', async () => {
    const db = await testDb();
    for (let i = 0; i < 5; i++) await upsertKnowledgeItem(db, draft({ domain: 'same.example', url: `https://same.example/${i}` }), unit(i), {});
    expect(await retrieveForRun(db, unit(0), { limit: 30 })).toHaveLength(3);
    for (let i = 0; i < 40; i++) await upsertKnowledgeItem(db, draft({ domain: `d${i}.example`, url: `https://d${i}.example/1` }), unit(50 + i), {});
    expect(await retrieveForRun(db, unit(200), { limit: 100 })).toHaveLength(30);
  });
  it('country filter keeps overlap, global and empty (L1)', async () => {
    const db = await testDb();
    await upsertKnowledgeItem(db, draft({ title: 'us', countries: ['US'] }), unit(0), {});
    await upsertKnowledgeItem(db, draft({ title: 'ca', countries: ['CA'], domain: 'c.example', url: 'https://c.example/1' }), unit(1), {});
    await upsertKnowledgeItem(db, draft({ title: 'glob', countries: ['global'], domain: 'g.example', url: 'https://g.example/1' }), unit(2), {});
    await upsertKnowledgeItem(db, draft({ title: 'any', countries: [], domain: 'e.example', url: 'https://e.example/1' }), unit(3), {});
    const rows = await retrieveForRun(db, unit(0), { limit: 10, countries: ['US'] });
    expect(rows.map((r) => r.title).sort()).toEqual(['any', 'glob', 'us']);
    expect(await retrieveForRun(db, unit(0), { limit: 10, kinds: ['pricing'] })).toHaveLength(0);
  });
});
