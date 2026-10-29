import { describe, it, expect } from 'vitest';
import { testDb, unit } from '../helpers/db';
import { upsertKnowledgeItem, rejectItem } from '../../src/library/store';
import type { KnowledgeDraft } from '../../src/library/kinds';
import { ideationContext, renderIdeationContext } from '../../src/library/context';
import { knowledgeSources } from '../../src/db/schema';

const near = (s: number, dim = 1): number[] => { const v = unit(0).map(() => 0); v[0] = s; v[dim] = Math.sqrt(1 - s * s); return v; };
let n = 0;
type Db = Awaited<ReturnType<typeof testDb>>;
async function add(db: Db, kind: 'startup' | 'pricing' | 'trend' | 'rule_change' | 'market', facts: unknown, vec: number[], o: Partial<KnowledgeDraft> = {}) {
  n++;
  const r = await upsertKnowledgeItem(db, {
    kind, title: `T${n} ${kind}`, summary: `S${n}`, quote: `q${n}`, audience: 'business', countries: ['US'], industries: [], facts,
    source: { url: `https://x${n}.example/p`, domain: `x${n}.example`, sourceType: 'web', quote: `q${n}`, quoteVerified: true },
    ...o,
  }, vec, {});
  return r.itemId;
}
const st = (name: string, outcome: string, why?: string) => ({ name, whatItDoes: `${name} does`, businessModel: 'saas', outcome, ...(why ? { why } : {}) });
const pr = (product: string) => ({ product, pricePoints: [{ amount: 9, currency: 'USD', unit: 'month' }], buyer: 'smb', complaints: [] });

describe('ideationContext', () => {
  it('classifies startups and pricing, orders by similarity, attaches url', async () => {
    const db = await testDb();
    const far = await add(db, 'startup', st('Far', 'active'), near(0.5));
    const close = await add(db, 'startup', st('Close', 'acquired'), near(0.9, 2));
    await add(db, 'startup', st('Pub', 'public'), near(0.7, 3));
    const dead = await add(db, 'startup', st('Dead', 'dead', 'ran out'), near(0.8, 4));
    await add(db, 'startup', st('Unk', 'unknown'), near(0.95, 5));
    const p = await add(db, 'pricing', pr('Tool'), near(0.6, 6), { quote: undefined, source: { url: 'https://p.example/x', domain: 'p.example', sourceType: 'web', quoteVerified: false } });
    const c = await ideationContext(db, unit(0), {});
    expect(c.alreadySold.map((s) => s.name)).toEqual(['Close', 'Pub', 'Far']);
    expect(c.alreadySold[0]).toMatchObject({ id: close, outcome: 'acquired', url: expect.stringContaining('https://x') });
    expect(c.alreadySold.map((s) => s.id)).toContain(far);
    expect(c.lessons).toEqual([expect.objectContaining({ id: dead, name: 'Dead', why: 'ran out' })]);
    expect(c.pricing).toEqual([expect.objectContaining({ id: p, product: 'Tool', buyer: 'smb', url: 'https://p.example/x' })]);
    expect(c.pricing[0]!.pricePoints[0]).toEqual({ amount: 9, currency: 'USD', unit: 'month' });
  });

  it('caps, excludes rejected and invalid facts, applies the country rule', async () => {
    const db = await testDb();
    for (let i = 0; i < 4; i++) await add(db, 'startup', st(`S${i}`, 'active'), near(0.9 - i * 0.1, i + 1));
    const rej = await add(db, 'startup', st('Rejected', 'active'), near(0.65, 9));
    await rejectItem(db, rej);
    await add(db, 'startup', { bad: true }, near(0.6, 10));
    await add(db, 'startup', st('DE', 'active'), near(0.97, 11), { countries: ['DE'] });
    await add(db, 'startup', st('Glob', 'active'), near(0.5, 12), { countries: ['global'] });
    await add(db, 'startup', st('Empty', 'active'), near(0.4, 13), { countries: [] });
    const capped = await ideationContext(db, unit(0), { alreadySoldMax: 2 });
    expect(capped.alreadySold.map((s) => s.name)).toEqual(['DE', 'S0']);
    const us = await ideationContext(db, unit(0), { countries: ['US'], alreadySoldMax: 50 });
    const names = us.alreadySold.map((s) => s.name);
    expect(names).not.toContain('DE');
    expect(names).not.toContain('Rejected');
    expect(names).toEqual(['S0', 'S1', 'S2', 'S3', 'Glob', 'Empty']);
  });

  it('prefers lessons with a why', async () => {
    const db = await testDb();
    await add(db, 'startup', st('NoWhy', 'dead'), near(0.9, 1));
    await add(db, 'startup', st('Why', 'dead', 'bad unit economics'), near(0.5, 2));
    const c = await ideationContext(db, unit(0), { lessonsMax: 1 });
    expect(c.lessons.map((l) => l.name)).toEqual(['Why']);
  });

  it('skips entries whose only sources have expired, and never links an expired source', async () => {
    const db = await testDb();
    const old = new Date(Date.now() - 40 * 864e5);
    const yt = (v: string) => ({ url: `https://www.youtube.com/watch?v=${v}`, domain: 'www.youtube.com', sourceType: 'youtube', quoteVerified: false });
    await upsertKnowledgeItem(db, { kind: 'startup', title: 'Gone', summary: 's', audience: 'business', countries: ['US'], industries: [], facts: st('Gone', 'active'), source: yt('gonegonegon') }, near(0.9, 1), { now: old });
    const mixed = await upsertKnowledgeItem(db, { kind: 'startup', title: 'Mixed', summary: 's', audience: 'business', countries: ['US'], industries: [], facts: st('Mixed', 'active'), source: yt('mixedmixedm') }, near(0.8, 2), { now: old });
    await db.insert(knowledgeSources).values({ itemId: mixed.itemId, url: 'https://mixed.example/', domain: 'mixed.example', sourceType: 'web' });
    const c = await ideationContext(db, unit(0), {});
    expect(c.alreadySold.map((s) => [s.name, s.url])).toEqual([['Mixed', 'https://mixed.example/']]);
  });
});

const tr = (topic: string, direction = 'rising') => ({ topic, direction, evidence: [{ metric: 'Wikipedia monthly views', value: '+34%', period: '2025-10 vs prior 12 months' }, { metric: 'other', value: '1', period: 'p' }], window: '36 months', basis: 'measured' });
const rc = (title: string, effectiveDate: string | null) => ({ title, change: `${title} changes`, whoIsAffected: 'sellers', jurisdiction: 'US', status: 'final', effectiveDate, publishedDate: '2026-01-05' });
const mk = (segment: string) => ({ segment, geography: 'US', sizeClues: [{ metric: 'Population', value: '330', unit: 'million', year: '2024' }, { metric: 'Internet users', value: '90', unit: '%', year: '2024' }, { metric: 'third', value: '1', unit: 'u', year: '2024' }], growthClues: [] });
const NOW = new Date('2026-10-29T00:00:00Z');
const addB = (db: Db, kind: 'trend' | 'rule_change' | 'market', facts: unknown, vec: number[], o: Partial<KnowledgeDraft> = {}) => add(db, kind, facts, vec, o);

describe('ideationContext: changing and markets (Slice B)', () => {
  it('classifies trends and rule changes with their key facts, and markets with size clues', async () => {
    const db = await testDb();
    const t = await addB(db, 'trend', tr('Home solar'), near(0.9, 1));
    const r = await addB(db, 'rule_change', rc('Label rule', '2026-12-01'), near(0.8, 2));
    const m = await addB(db, 'market', mk('Renters'), near(0.7, 3));
    await add(db, 'startup', st('S', 'active'), near(0.95, 4));
    const c = await ideationContext(db, unit(0), { now: NOW });
    expect(c.changing).toEqual([
      expect.objectContaining({ id: r, kind: 'rule_change', keyFact: 'final, effective 2026-12-01, US', url: expect.stringContaining('https://x') }),
      expect.objectContaining({ id: t, kind: 'trend', gist: 'Home solar', keyFact: 'rising: Wikipedia monthly views +34% (2025-10 vs prior 12 months)' }),
    ]);
    expect(c.markets).toEqual([expect.objectContaining({ id: m, segment: 'Renters', geography: 'US', keyFact: 'Population 330 million (2024); Internet users 90 % (2024)' })]);
    expect(c.alreadySold).toHaveLength(1);
  });

  it('puts rule changes effective within 18 months of now first (past or future), then the rest by similarity', async () => {
    const db = await testDb();
    const far = await addB(db, 'rule_change', rc('Far', '2031-01-01'), near(0.9, 1));
    const trend = await addB(db, 'trend', tr('T'), near(0.6, 2));
    const past = await addB(db, 'rule_change', rc('Past', '2025-06-01'), near(0.5, 3));
    const soon = await addB(db, 'rule_change', rc('Soon', '2027-03-01'), near(0.4, 4));
    const old = await addB(db, 'rule_change', rc('Old', '2024-01-01'), near(0.8, 5));
    const nodate = await addB(db, 'rule_change', rc('NoDate', null), near(0.7, 6));
    const c = await ideationContext(db, unit(0), { now: NOW });
    expect(c.changing.map((x) => x.id)).toEqual([past, soon, far, old, nodate, trend]);
    expect(c.changing[4]!.keyFact).toBe('final, published 2026-01-05, US');
  });

  it('keeps in-window rule changes first even when the cap is tight', async () => {
    const db = await testDb();
    await addB(db, 'trend', tr('Closest'), near(0.99, 1));
    const soon = await addB(db, 'rule_change', rc('Soon', '2027-03-01'), near(0.2, 2));
    const c = await ideationContext(db, unit(0), { now: NOW, changingMax: 1 });
    expect(c.changing.map((x) => x.id)).toEqual([soon]);
  });

  it('caps changing at 10 and markets at 6 by default, and honours the options', async () => {
    const db = await testDb();
    for (let i = 0; i < 12; i++) await addB(db, 'trend', tr(`T${i}`), near(0.9 - i * 0.02, i + 1));
    for (let i = 0; i < 8; i++) await addB(db, 'market', mk(`M${i}`), near(0.9 - i * 0.02, i + 20));
    const d = await ideationContext(db, unit(0), { now: NOW });
    expect(d.changing).toHaveLength(10);
    expect(d.markets).toHaveLength(6);
    const o = await ideationContext(db, unit(0), { now: NOW, changingMax: 3, marketsMax: 2 });
    expect([o.changing.length, o.markets.length]).toEqual([3, 2]);
  });

  it('a section set to 0 issues no query', async () => {
    const db = await testDb();
    await addB(db, 'trend', tr('T'), near(0.9, 1));
    await addB(db, 'market', mk('M'), near(0.9, 2));
    let selects = 0;
    const counted = new Proxy(db, {
      get(t, p, r) {
        if (p === 'select') selects++;
        return Reflect.get(t, p, r);
      },
    });
    const c = await ideationContext(counted, unit(0), { now: NOW, alreadySoldMax: 15, lessonsMax: 0, pricingMax: 0, changingMax: 0, marketsMax: 0 });
    expect(selects).toBe(1);
    expect([c.changing, c.markets, c.lessons, c.pricing]).toEqual([[], [], [], []]);
  });

  it('applies the country rule, and leaves out rejected, expired and invalid entries', async () => {
    const db = await testDb();
    await addB(db, 'trend', tr('DE only'), near(0.97, 1), { countries: ['DE'] });
    const glob = await addB(db, 'trend', tr('Global'), near(0.5, 2), { countries: ['global'] });
    const us = await addB(db, 'market', mk('US'), near(0.6, 3));
    await addB(db, 'market', mk('DE'), near(0.9, 4), { countries: ['DE'] });
    const rej = await addB(db, 'trend', tr('Rejected'), near(0.9, 5));
    await rejectItem(db, rej);
    await addB(db, 'trend', { bad: true }, near(0.8, 6));
    await addB(db, 'rule_change', rc('Bad date', 'soon'), near(0.85, 7));
    const old = new Date(Date.now() - 40 * 864e5);
    await upsertKnowledgeItem(db, { kind: 'trend', title: 'Gone', summary: 's', audience: 'business', countries: ['US'], industries: [], facts: tr('Gone'), source: { url: 'https://www.youtube.com/watch?v=gonegonegon', domain: 'www.youtube.com', sourceType: 'youtube', quoteVerified: false } }, near(0.92, 8), { now: old });
    const c = await ideationContext(db, unit(0), { countries: ['US'], now: NOW });
    expect(c.changing.map((x) => x.id)).toEqual([glob]);
    expect(c.markets.map((x) => x.id)).toEqual([us]);
  });

  it('is empty when the library has no Slice B entries', async () => {
    const db = await testDb();
    await add(db, 'startup', st('S', 'active'), near(0.9, 1));
    const c = await ideationContext(db, unit(0), { now: NOW });
    expect([c.changing, c.markets]).toEqual([[], []]);
  });
});

describe('renderIdeationContext', () => {
  it('renders none found when empty', () => {
    expect(renderIdeationContext({ alreadySold: [], lessons: [], pricing: [], changing: [], markets: [] })).toEqual({
      alreadySold: 'none found', lessons: 'none found', pricing: 'none found', changing: 'none found', markets: 'none found',
    });
  });
  it('renders changing and markets as capped single lines with id, gist, key fact and url', () => {
    const long = 'y'.repeat(5000);
    const r = renderIdeationContext({
      alreadySold: [], lessons: [], pricing: [],
      changing: [
        { id: 'c1', kind: 'trend', gist: 'Solar\nup', keyFact: 'rising: views +34% (2025)', url: 'https://u/1' },
        { id: 'c2', kind: 'rule_change', gist: long, keyFact: long, url: long },
        ...Array.from({ length: 100 }, (_, i) => ({ id: `n${i}`, kind: 'trend' as const, gist: long, keyFact: long, url: long })),
      ],
      markets: [{ id: 'm1', segment: long, geography: long, keyFact: 'Population 330 million (2024)', url: 'https://u/2' }],
    });
    expect(r.changing).toContain('[c1] trend: Solar up | rising: views +34% (2025) | https://u/1');
    expect(r.changing).toContain('[c2] rule change:');
    expect(r.changing.length).toBeLessThanOrEqual(6000);
    for (const line of [...r.changing.split('\n'), ...r.markets.split('\n')]) expect(line.length).toBeLessThanOrEqual(400);
    expect(r.markets).toContain('[m1]');
  });
  it('renders capped single lines', () => {
    const long = 'x'.repeat(5000);
    const r = renderIdeationContext({
      alreadySold: Array.from({ length: 100 }, (_, i) => ({ id: `id${i}`, name: long, whatItDoes: 'a\nb', outcome: 'active', url: 'https://u' })),
      lessons: [{ id: 'l1', name: 'N', whatItDoes: 'W', outcome: 'dead', why: 'because', url: 'https://u' }],
      pricing: [{ id: 'p1', product: 'P', pricePoints: [{ amount: 9, currency: 'USD', unit: 'month' }], buyer: 'smb', url: 'https://u' }],
      changing: [], markets: [],
    });
    expect(r.alreadySold.length).toBeLessThanOrEqual(6000);
    for (const line of r.alreadySold.split('\n')) expect(line.length).toBeLessThanOrEqual(400);
    expect(r.lessons).toContain('l1');
    expect(r.lessons).toContain('because');
    expect(r.pricing).toContain('9 USD/month');
  });
});
