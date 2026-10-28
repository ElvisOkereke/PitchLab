import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { Db } from '../src/db/client';
import { cases, claims, knowledgeItems, knowledgeSources, pageFetches, settings, signals } from '../src/db/schema';
import { upsertKnowledgeItem } from '../src/library/store';
import { runMaintenance, runMaintenanceQuietly } from '../src/maintenance';
import { insertCase, insertIdea, insertRun, testDb, unit } from './helpers/db';
import { defaultRunConfig } from '../src/pipeline/types';
import { readFileSync } from 'node:fs';
import { computeNumbers } from '../src/calc/numbers';
import { EXPIRED_PLACEHOLDER, YOUTUBE_CLAIM_NOTE } from '../src/case/expired';

const FIXTURE = new URL('./helpers/fixtures/case-draft.json', import.meta.url);

const DAY = 86_400_000;
const NOW = new Date('2026-10-28T12:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const PLACEHOLDER = '[expired YouTube data]';

let n = 0;
async function item(db: Db, sourceType: string, url: string, expiresAt: Date | null, extra?: { url: string; sourceType: string }) {
  n++;
  const r = await upsertKnowledgeItem(db, {
    kind: 'problem', title: `T${n}`, summary: `S${n}`, quote: `q${n}`, audience: 'business', countries: ['US'], industries: ['x'],
    voice: 'neutral', facts: { persona: 'p' },
    source: { url, domain: 'a.example', sourceType, quote: `q${n}`, quoteVerified: true },
  }, unit(n), {});
  await db.update(knowledgeSources).set({ expiresAt }).where(eq(knowledgeSources.url, url));
  if (extra) {
    await db.insert(knowledgeSources).values({ itemId: r.itemId, url: extra.url, domain: 'b.example', sourceType: extra.sourceType });
  }
  return r.itemId;
}

/** A YouTube library source with this quote, fetched at `fetched` (expires 30 days later). */
async function ytSource(db: Db, url: string, quote: string, fetched: Date) {
  n++;
  return (await upsertKnowledgeItem(db, {
    kind: 'problem', title: `YT${n}`, summary: `YS${n}`, quote, audience: 'business', countries: ['US'], industries: ['x'],
    voice: 'operator', facts: { persona: 'p' },
    source: { url, domain: 'www.youtube.com', sourceType: 'youtube', quote, quoteVerified: true },
  }, unit(100 + n), { now: fetched })).itemId;
}

const sig = (db: Db, source: string, url: string, createdAt: Date, hash = 'h' + url) =>
  db.insert(signals).values({ marketId: 'ca-us', source, url, title: 'real title', quote: 'real quote text here', quoteHash: hash, embedding: unit(3), createdAt }).returning();

describe('runMaintenance', () => {
  it('uses the shared placeholder and a review note true for any YouTube URL', () => {
    expect(EXPIRED_PLACEHOLDER).toBe(PLACEHOLDER);
    expect(YOUTUBE_CLAIM_NOTE).toBe('YouTube quote removed (YouTube data is kept for at most 30 days)');
  });

  it('prunes page_fetches older than 90 days only', async () => {
    const db = await testDb();
    await db.insert(pageFetches).values([
      { urlDomain: 'a.example', outcome: 'ok', via: 'direct', at: ago(91) },
      { urlDomain: 'b.example', outcome: 'ok', via: 'direct', at: ago(89) },
    ]);
    const r = await runMaintenance(db, NOW);
    expect(r.prunedFetches).toBe(1);
    expect((await db.select().from(pageFetches)).map((x) => x.urlDomain)).toEqual(['b.example']);
  });

  it('prunes youtube.quota settings rows older than 7 days, keeps recent ones and other settings', async () => {
    const db = await testDb();
    await db.execute(sql`insert into settings (key, value) values
      ('youtube.quota.2026-10-10', '{"searchCalls":1,"units":1}'::jsonb),
      ('youtube.quota.2026-10-20', '{"searchCalls":1,"units":1}'::jsonb),
      ('youtube.quota.2026-10-21', '{"searchCalls":1,"units":1}'::jsonb),
      ('youtube.quota.2026-10-28', '{"searchCalls":1,"units":1}'::jsonb),
      ('youtube.quota.garbage', '{}'::jsonb),
      ('youtube.quotax.2026-01-01', '{}'::jsonb),
      ('youtubeXquotaX2026-01-01', '{}'::jsonb),
      ('other.2026-01-01', '{}'::jsonb)`);
    const r = await runMaintenance(db, NOW);
    expect(r.prunedQuotaRows).toBe(2);
    expect(r.errors).toEqual([]);
    const keys = (await db.select().from(settings)).map((x) => x.key).sort();
    expect(keys).toEqual(['other.2026-01-01', 'youtube.quota.2026-10-21', 'youtube.quota.2026-10-28', 'youtube.quota.garbage', 'youtube.quotax.2026-01-01', 'youtubeXquotaX2026-01-01']);
  });

  it('deletes expired sources, then entries left with no sources', async () => {
    const db = await testDb();
    const gone = await item(db, 'youtube', 'https://www.youtube.com/watch?v=aaaaaaaaaaa', ago(1));
    const kept = await item(db, 'hn', 'https://news.example/1', null, { url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', sourceType: 'youtube' });
    await db.update(knowledgeSources).set({ expiresAt: ago(1) }).where(eq(knowledgeSources.url, 'https://www.youtube.com/watch?v=bbbbbbbbbbb'));
    const future = await item(db, 'youtube', 'https://www.youtube.com/watch?v=ccccccccccc', new Date(NOW.getTime() + DAY));
    const r = await runMaintenance(db, NOW);
    expect(r).toMatchObject({ expiredSources: 2, deletedItems: 1 });
    const ids = (await db.select({ id: knowledgeItems.id }).from(knowledgeItems)).map((x) => x.id);
    expect(ids).not.toContain(gone);
    expect(ids).toEqual(expect.arrayContaining([kept, future]));
    expect(await db.select().from(knowledgeSources)).toHaveLength(2);
  });

  it('redacts YouTube signals older than 30 days, keeps (url, quote_hash) unique, leaves others', async () => {
    const db = await testDb();
    const [a] = await sig(db, 'youtube', 'https://www.youtube.com/watch?v=aaaaaaaaaaa', ago(31), 'same');
    const [b] = await sig(db, 'youtube', 'https://www.youtube.com/watch?v=aaaaaaaaaaa', ago(40), 'same2');
    await ytSource(db, 'https://www.youtube.com/watch?v=fresh', 'real quote text here', ago(5));
    const [fresh] = await sig(db, 'youtube', 'https://www.youtube.com/watch?v=fresh', ago(5));
    const [other] = await sig(db, 'web', 'https://other.example/x', ago(200));
    const r = await runMaintenance(db, NOW);
    expect(r.redactedSignals).toBe(2);
    const get = async (id: string) => (await db.select().from(signals).where(eq(signals.id, id)))[0]!;
    const ra = await get(a!.id);
    expect(ra).toMatchObject({ quote: PLACEHOLDER, title: PLACEHOLDER, embedding: null });
    expect(ra.quoteHash).toBe(createHash('sha256').update(PLACEHOLDER + a!.id).digest('hex'));
    expect((await get(b!.id)).quoteHash).not.toBe(ra.quoteHash);
    expect((await get(fresh!.id)).quote).toBe('real quote text here');
    const o = await get(other!.id);
    expect(o).toMatchObject({ quote: 'real quote text here', title: 'real title' });
    expect(o.embedding).not.toBeNull();
  });

  it('removes YouTube claim quotes for cases older than 30 days only', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', ideaCount: 1, advanceCount: 1 }));
    const oldCase = await insertCase(db, (await insertIdea(db, run.id)).id, { createdAt: ago(31) });
    const newCase = await insertCase(db, (await insertIdea(db, run.id)).id, { createdAt: ago(2), slug: 'new-case' });
    const mk = (caseId: string, sourceUrl: string, quote: string | null) => ({ caseId, section: 's', text: 't', sourceUrl, quote });
    await ytSource(db, 'https://www.youtube.com/watch?v=bbbbbbbbbbb', 'fresh case youtube quote long enough', ago(2));
    await db.insert(claims).values([
      mk(oldCase.id, 'https://www.youtube.com/watch?v=aaaaaaaaaaa', 'a youtube quote that is long enough'),
      mk(oldCase.id, 'https://youtu.be/aaaaaaaaaaa', 'another youtube quote that is long'),
      mk(oldCase.id, 'https://youtube.com/watch?v=aaaaaaaaaaa', null),
      mk(oldCase.id, 'https://news.example/a', 'a news quote that is long enough'),
      mk(oldCase.id, 'https://m.youtube.com/watch?v=aaaaaaaaaaa', 'mobile youtube quote long enough here'),
      mk(oldCase.id, 'https://notyoutube.com/a', 'lookalike host quote long enough'),
      mk(newCase.id, 'https://www.youtube.com/watch?v=bbbbbbbbbbb', 'fresh case youtube quote long enough'),
    ]);
    const r = await runMaintenance(db, NOW);
    expect(r.redactedClaims).toBe(3);
    const all = await db.select().from(claims);
    const byUrl = (u: string, c: string) => all.find((x) => x.sourceUrl === u && x.caseId === c)!;
    expect(byUrl('https://www.youtube.com/watch?v=aaaaaaaaaaa', oldCase.id)).toMatchObject({ quote: null, reviewNote: 'YouTube quote removed (YouTube data is kept for at most 30 days)' });
    expect(byUrl('https://youtu.be/aaaaaaaaaaa', oldCase.id).quote).toBeNull();
    expect(byUrl('https://news.example/a', oldCase.id)).toMatchObject({ quote: 'a news quote that is long enough', reviewNote: null });
    expect(byUrl('https://notyoutube.com/a', oldCase.id).quote).not.toBeNull();
    expect(byUrl('https://www.youtube.com/watch?v=bbbbbbbbbbb', newCase.id).quote).not.toBeNull();
  });

  it('deletes a YouTube-only entry that a signal was promoted from, redacting the signal, without throwing', async () => {
    const db = await testDb();
    const id = await item(db, 'youtube', 'https://www.youtube.com/watch?v=aaaaaaaaaaa', ago(1));
    const [s] = await db.insert(signals).values({
      marketId: 'ca-us', source: 'youtube', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', title: 't', quote: 'quote text', quoteHash: 'p1',
      knowledgeItemId: id, createdAt: ago(31),
    }).returning();
    const r = await runMaintenance(db, NOW);
    expect(r).toMatchObject({ deletedItems: 1, redactedSignals: 1, errors: [] });
    const row = (await db.select().from(signals).where(eq(signals.id, s!.id)))[0]!;
    expect(row).toMatchObject({ knowledgeItemId: null, quote: PLACEHOLDER });
    expect(await db.select().from(knowledgeItems)).toHaveLength(0);
  });

  it('an entry that survives a YouTube expiry takes its quote from a remaining verified source', async () => {
    const db = await testDb();
    const ytQuote = 'Chasing unpaid invoices eats my whole Friday every single week.';
    const webQuote = 'We lose about six hours a week chasing late invoices by phone.';
    const id = await ytSource(db, 'https://www.youtube.com/watch?v=mixmixmixmi', ytQuote, ago(31));
    await db.insert(knowledgeSources).values([
      { itemId: id, url: 'https://forum.example/t/0', domain: 'forum.example', sourceType: 'web', quote: 'An unverified forum line.', quoteVerified: false, fetchedAt: ago(40) },
      { itemId: id, url: 'https://forum.example/t/1', domain: 'forum.example', sourceType: 'web', quote: webQuote, quoteVerified: true, fetchedAt: ago(20) },
    ]);
    const r = await runMaintenance(db, NOW);
    expect(r).toMatchObject({ expiredSources: 1, deletedItems: 0, errors: [] });
    const [row] = await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, id));
    expect(row).toMatchObject({ quote: webQuote, quoteVerified: true });
    expect(JSON.stringify(row)).not.toContain('Friday');
  });

  it('an entry whose only verified quote was YouTube (adopted via merge) keeps no YouTube text', async () => {
    const db = await testDb();
    const ytQuote = 'Every quote I send by hand loses the job to a faster competitor.';
    const base = {
      kind: 'problem' as const, title: 'Slow quoting', summary: 'Quotes take too long', quote: 'model paraphrase of slow quotes',
      audience: 'business' as const, countries: ['US'], industries: ['x'], voice: 'neutral' as const, facts: { persona: 'p' },
    };
    const web = await upsertKnowledgeItem(db, { ...base, source: { url: 'https://blog.example/q', domain: 'blog.example', sourceType: 'web', quote: 'not verbatim', quoteVerified: false } }, unit(7), { now: ago(40) });
    const yt = await upsertKnowledgeItem(db, { ...base, source: { url: 'https://youtu.be/quotequote1', domain: 'youtu.be', sourceType: 'youtube', quote: ytQuote, quoteVerified: true } }, unit(7), { now: ago(31) });
    expect(yt).toEqual({ outcome: 'duplicate', itemId: web.itemId });
    expect((await db.select().from(knowledgeItems))[0]).toMatchObject({ quote: ytQuote, quoteVerified: true });
    const r = await runMaintenance(db, NOW);
    expect(r).toMatchObject({ expiredSources: 1, deletedItems: 0, errors: [] });
    const [row] = await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, web.itemId));
    expect(row).toMatchObject({ quote: null, quoteVerified: false, title: 'Slow quoting', summary: 'Quotes take too long' });
    expect(JSON.stringify(row)).not.toContain('competitor');
    expect(JSON.stringify(await db.select().from(knowledgeSources))).not.toContain('competitor');
    expect(await runMaintenance(db, NOW)).toMatchObject({ expiredSources: 0, deletedItems: 0, redactedSignals: 0, redactedClaims: 0 });
  });

  it('redacts a recent YouTube signal once no unexpired YouTube source has the same url and quote', async () => {
    const db = await testDb();
    const uA = 'https://www.youtube.com/watch?v=livelivelive';
    const uB = 'https://www.youtube.com/watch?v=expiredexpi';
    await ytSource(db, uA, 'Quoting  jobs by hand\nloses us bids every month.', ago(5));
    await ytSource(db, uB, 'Our scheduling app double books the crew weekly.', ago(31));
    const mk = (url: string, quote: string, hash: string, createdAt: Date) =>
      db.insert(signals).values({ marketId: 'ca-us', source: 'youtube', url, title: 'real title', quote, quoteHash: hash, embedding: unit(3), createdAt }).returning();
    // Library promotion stores the whitespace-collapsed source quote.
    const [backed] = await mk(uA, 'Quoting jobs by hand loses us bids every month.', 'a1', ago(1));
    const [expired] = await mk(uB, 'Our scheduling app double books the crew weekly.', 'b1', ago(1));
    const [otherComment] = await mk(uA, 'A different comment that was never stored.', 'a2', ago(1));
    const [web] = await sig(db, 'web', 'https://other.example/y', ago(1));
    const r = await runMaintenance(db, NOW);
    expect(r.errors).toEqual([]);
    expect(r.redactedSignals).toBe(2);
    const get = async (id: string) => (await db.select().from(signals).where(eq(signals.id, id)))[0]!;
    expect((await get(backed!.id)).quote).toBe('Quoting jobs by hand loses us bids every month.');
    expect(await get(expired!.id)).toMatchObject({ quote: PLACEHOLDER, title: PLACEHOLDER, embedding: null });
    expect((await get(otherComment!.id)).quote).toBe(PLACEHOLDER);
    expect((await get(web!.id)).quote).toBe('real quote text here');
    expect((await runMaintenance(db, NOW)).redactedSignals).toBe(0);
  });

  it('removes a recent case\'s YouTube claim quote once no unexpired YouTube source backs it', async () => {
    const db = await testDb();
    const uA = 'https://www.youtube.com/watch?v=livelivelive';
    const uB = 'https://www.youtube.com/watch?v=expiredexpi';
    await ytSource(db, uA, 'Quoting jobs by hand loses us bids every month, honestly.', ago(5));
    await ytSource(db, uB, 'Our scheduling app double books the crew weekly.', ago(31));
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', ideaCount: 1, advanceCount: 1 }));
    const kase = await insertCase(db, (await insertIdea(db, run.id)).id, { createdAt: ago(1) });
    const mk = (section: string, sourceUrl: string, quote: string) => ({ caseId: kase.id, section, text: 't', sourceUrl, quote });
    await db.insert(claims).values([
      mk('signal', uA, 'Quoting jobs by hand loses us bids every month, honestly.'),
      mk('evidence', uA, 'loses us bids every month'),
      mk('numbers', uA, 'a figure the source never said'),
      mk('competitor', uB, 'Our scheduling app double books the crew weekly.'),
    ]);
    const r = await runMaintenance(db, NOW);
    expect(r.errors).toEqual([]);
    expect(r.redactedClaims).toBe(2);
    const all = await db.select().from(claims);
    const by = (s: string) => all.find((c) => c.section === s)!;
    expect(by('signal').quote).toBe('Quoting jobs by hand loses us bids every month, honestly.');
    expect(by('evidence').quote).toBe('loses us bids every month');
    expect(by('numbers')).toMatchObject({ quote: null, reviewNote: 'YouTube quote removed (YouTube data is kept for at most 30 days)' });
    expect(by('competitor')).toMatchObject({ quote: null, reviewNote: 'YouTube quote removed (YouTube data is kept for at most 30 days)' });
    expect((await runMaintenance(db, NOW)).redactedClaims).toBe(0);
  });

  it('a failing step does not block the others', async () => {
    const db = await testDb();
    await sig(db, 'youtube', 'https://www.youtube.com/watch?v=aaaaaaaaaaa', ago(31));
    const real = db.transaction.bind(db);
    let calls = 0;
    (db as unknown as { transaction: unknown }).transaction = (fn: never) => (++calls === 2 ? Promise.reject(new Error('step 2 down')) : real(fn));
    const r = await runMaintenance(db, NOW);
    expect(r.errors).toEqual(['expire sources: step 2 down']);
    expect(r.redactedSignals).toBe(1);
  });

  it('is idempotent', async () => {
    const db = await testDb();
    await db.insert(pageFetches).values({ urlDomain: 'a.example', outcome: 'ok', via: 'direct', at: ago(100) });
    await item(db, 'youtube', 'https://www.youtube.com/watch?v=aaaaaaaaaaa', ago(1));
    await sig(db, 'youtube', 'https://www.youtube.com/watch?v=aaaaaaaaaaa', ago(31));
    expect(await runMaintenance(db, NOW)).toEqual({ prunedFetches: 1, prunedQuotaRows: 0, expiredSources: 1, deletedItems: 1, redactedSignals: 1, redactedClaims: 0, redactedCases: 0, errors: [] });
    expect(await runMaintenance(db, NOW)).toEqual({ prunedFetches: 0, prunedQuotaRows: 0, expiredSources: 0, deletedItems: 0, redactedSignals: 0, redactedClaims: 0, redactedCases: 0, errors: [] });
  });

  it('replaces the verbatim text of YouTube signal claims when unbacked or the case is old, once', async () => {
    const db = await testDb();
    const uA = 'https://www.youtube.com/watch?v=livelivelive';
    const uB = 'https://www.youtube.com/watch?v=expiredexpi';
    const qA = 'Quoting jobs by hand loses us bids every month, honestly.';
    const qB = 'Our scheduling app double books the crew weekly.';
    await ytSource(db, uA, qA, ago(5));
    await ytSource(db, uB, qB, ago(31));
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', ideaCount: 1, advanceCount: 1 }));
    const recent = await insertCase(db, (await insertIdea(db, run.id)).id, { createdAt: ago(1) });
    const old = await insertCase(db, (await insertIdea(db, run.id)).id, { createdAt: ago(31), slug: 'old-case' });
    const [backed, unbacked, oldBacked, web, quoteless] = await db.insert(claims).values([
      { caseId: recent.id, section: 'signal', text: qA, sourceUrl: uA, quote: qA },
      { caseId: recent.id, section: 'signal', text: qB, sourceUrl: uB, quote: qB },
      { caseId: old.id, section: 'signal', text: qA, sourceUrl: uA, quote: qA },
      { caseId: recent.id, section: 'signal', text: 'A web quote that stays put.', sourceUrl: 'https://web.example/a', quote: 'A web quote that stays put.' },
      { caseId: recent.id, section: 'signal', text: qB, sourceUrl: uB, quote: null },
    ]).returning();
    const r = await runMaintenance(db, NOW);
    expect(r.errors).toEqual([]);
    expect(r.redactedClaims).toBe(3);
    const get = async (id: string) => (await db.select().from(claims).where(eq(claims.id, id)))[0]!;
    expect(await get(backed!.id)).toMatchObject({ text: qA, quote: qA, reviewNote: null });
    expect(await get(unbacked!.id)).toMatchObject({ text: PLACEHOLDER, quote: null, reviewNote: 'YouTube quote removed (YouTube data is kept for at most 30 days)', section: 'signal', sourceUrl: uB });
    expect(await get(oldBacked!.id)).toMatchObject({ text: PLACEHOLDER, quote: null, reviewNote: 'YouTube quote removed (YouTube data is kept for at most 30 days)' });
    expect(await get(web!.id)).toMatchObject({ text: 'A web quote that stays put.', quote: 'A web quote that stays put.' });
    expect(await get(quoteless!.id)).toMatchObject({ text: PLACEHOLDER, quote: null, reviewNote: null });
    expect((await runMaintenance(db, NOW)).redactedClaims).toBe(0);
  });

  it('replaces YouTube quotes in case evidence signals when unbacked or the case is old, keeping everything else', async () => {
    const db = await testDb();
    const uA = 'https://www.youtube.com/watch?v=livelivelive';
    const uB = 'https://youtu.be/expiredexpi';
    const qA = 'Quoting jobs by hand loses us bids every month, honestly.';
    const qB = 'Our scheduling app double books the crew weekly.';
    await ytSource(db, uA, qA, ago(5));
    await ytSource(db, uB, qB, ago(31));
    const sections = (signals: { quote: string; url: string; sourceName: string; voice?: string }[]) =>
      ({ summary: { oneLiner: 'o' }, evidence: { signals, claims: [{ text: 'c', sourceUrl: 'https://web.example/c', quote: 'cq' }] } }) as never;
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', ideaCount: 1, advanceCount: 1 }));
    const recent = await insertCase(db, (await insertIdea(db, run.id)).id, {
      createdAt: ago(1),
      sections: sections([
        { quote: qA, url: uA, sourceName: 'YouTube', voice: 'operator' },
        { quote: qB, url: uB, sourceName: 'YouTube' },
        { quote: 'A web quote that stays put.', url: 'https://web.example/a', sourceName: 'web.example' },
      ]),
    });
    const old = await insertCase(db, (await insertIdea(db, run.id)).id, { createdAt: ago(31), slug: 'old-case', sections: sections([{ quote: qA, url: uA, sourceName: 'YouTube' }]) });
    const untouched = await insertCase(db, (await insertIdea(db, run.id)).id, { createdAt: ago(1), slug: 'no-evidence' });
    const r = await runMaintenance(db, NOW);
    expect(r.errors).toEqual([]);
    expect(r.redactedCases).toBe(2);
    const get = async (id: string) => (await db.select().from(cases).where(eq(cases.id, id)))[0]!.sections as unknown as { summary: unknown; evidence: { signals: unknown[]; claims: unknown[] } };
    const rs = await get(recent.id);
    expect(rs.evidence.signals).toEqual([
      { quote: qA, url: uA, sourceName: 'YouTube', voice: 'operator' },
      { quote: PLACEHOLDER, url: uB, sourceName: 'YouTube' },
      { quote: 'A web quote that stays put.', url: 'https://web.example/a', sourceName: 'web.example' },
    ]);
    expect(rs.evidence.claims).toEqual([{ text: 'c', sourceUrl: 'https://web.example/c', quote: 'cq' }]);
    expect(rs.summary).toEqual({ oneLiner: 'o' });
    expect((await get(old.id)).evidence.signals).toEqual([{ quote: PLACEHOLDER, url: uA, sourceName: 'YouTube' }]);
    expect(await get(untouched.id)).toEqual({ summary: { oneLiner: 'o' } });
    expect((await runMaintenance(db, NOW)).redactedCases).toBe(0);
  });

  it('replaces YouTube quotes in number inputs (nested) and evidence claims; numbers and other text are unchanged', async () => {
    const db = await testDb();
    const uA = 'https://www.youtube.com/watch?v=livelivelive';
    const uB = 'https://m.youtube.com/watch?v=expiredexpi';
    const { title: _t, usedSignalUrls: _u, ...draft } = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const build = () => {
      const s = structuredClone(draft);
      s.numbers.inputs.price.unitsPerBuyer.source.url = uA; // backed below
      s.numbers.inputs.problemCost[0].unitCost.source.url = uB; // expired source
      s.evidence.claims[1].sourceUrl = uB;
      s.evidence.signals = [];
      s.summary = { ...s.summary, gateFlags: [] };
      s.numbers = { inputs: s.numbers.inputs, results: computeNumbers(s.numbers.inputs) };
      return s;
    };
    const before = build();
    await ytSource(db, uA, `Intro words. ${before.numbers.inputs.price.unitsPerBuyer.source.quote} More words.`, ago(5));
    await ytSource(db, uB, before.numbers.inputs.problemCost[0].unitCost.source.quote, ago(31));
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', ideaCount: 1, advanceCount: 1 }));
    const recent = await insertCase(db, (await insertIdea(db, run.id)).id, { createdAt: ago(1), sections: build() });
    const old = await insertCase(db, (await insertIdea(db, run.id)).id, { createdAt: ago(31), slug: 'old-case', sections: build() });
    const r = await runMaintenance(db, NOW);
    expect(r.errors).toEqual([]);
    expect(r.redactedCases).toBe(2);
    const get = async (id: string) => (await db.select().from(cases).where(eq(cases.id, id)))[0]!.sections as unknown as typeof before;

    const expected = build();
    expected.numbers.inputs.problemCost[0].unitCost.source.quote = PLACEHOLDER;
    expected.evidence.claims[1].quote = PLACEHOLDER;
    const rs = await get(recent.id);
    expect(rs).toEqual(expected);
    expect(computeNumbers(rs.numbers.inputs)).toEqual(before.numbers.results);
    expect(rs.numbers.results).toEqual(before.numbers.results);

    const os = await get(old.id);
    expect(os.numbers.inputs.price.unitsPerBuyer.source.quote).toBe(PLACEHOLDER);
    expect(os.numbers.inputs.problemCost[0].unitCost.source.quote).toBe(PLACEHOLDER);
    expect(os.evidence.claims[1].quote).toBe(PLACEHOLDER);
    expect(os.evidence.claims[0]).toEqual(before.evidence.claims[0]);
    expect(os.numbers.results).toEqual(before.numbers.results);
    expect((await runMaintenance(db, NOW)).redactedCases).toBe(0);
  });

  it('deletes a source at exactly expires_at == now', async () => {
    const db = await testDb();
    await ytSource(db, 'https://www.youtube.com/watch?v=boundaryboun', 'A boundary comment long enough.', ago(30));
    const [src] = await db.select().from(knowledgeSources);
    expect(src!.expiresAt!.getTime()).toBe(NOW.getTime());
    expect(await runMaintenance(db, NOW)).toMatchObject({ expiredSources: 1, deletedItems: 1 });
  });
});

describe('runMaintenanceQuietly (used by openDb)', () => {
  it('logs one count line, nothing when idle, and never throws', async () => {
    const db = await testDb();
    const lines: string[] = [];
    await runMaintenanceQuietly(db, (l) => lines.push(l));
    expect(lines).toEqual([]);
    await db.insert(pageFetches).values({ urlDomain: 'a.example', outcome: 'ok', via: 'direct', at: new Date(Date.now() - 100 * DAY) });
    await runMaintenanceQuietly(db, (l) => lines.push(l));
    expect(lines).toEqual(['Maintenance: 1 old records cleaned up.']);
    await expect(runMaintenanceQuietly({ transaction: () => { throw new Error('boom'); } } as never, (l) => lines.push(l))).resolves.toBeUndefined();
    expect(lines[1]).toMatch(/step failed: .*boom/);
  });
});
