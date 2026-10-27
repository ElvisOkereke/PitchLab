import { describe, it, expect } from 'vitest';
import { testDb, unit } from '../helpers/db';
import { upsertKnowledgeItem, rejectItem } from '../../src/library/store';
import type { KnowledgeDraft } from '../../src/library/kinds';
import { ideationContext, renderIdeationContext } from '../../src/library/context';

const near = (s: number, dim = 1): number[] => { const v = unit(0).map(() => 0); v[0] = s; v[dim] = Math.sqrt(1 - s * s); return v; };
let n = 0;
type Db = Awaited<ReturnType<typeof testDb>>;
async function add(db: Db, kind: 'startup' | 'pricing', facts: unknown, vec: number[], o: Partial<KnowledgeDraft> = {}) {
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
});

describe('renderIdeationContext', () => {
  it('renders none found when empty', () => {
    expect(renderIdeationContext({ alreadySold: [], lessons: [], pricing: [] })).toEqual({
      alreadySold: 'none found', lessons: 'none found', pricing: 'none found',
    });
  });
  it('renders capped single lines', () => {
    const long = 'x'.repeat(5000);
    const r = renderIdeationContext({
      alreadySold: Array.from({ length: 100 }, (_, i) => ({ id: `id${i}`, name: long, whatItDoes: 'a\nb', outcome: 'active', url: 'https://u' })),
      lessons: [{ id: 'l1', name: 'N', whatItDoes: 'W', outcome: 'dead', why: 'because', url: 'https://u' }],
      pricing: [{ id: 'p1', product: 'P', pricePoints: [{ amount: 9, currency: 'USD', unit: 'month' }], buyer: 'smb', url: 'https://u' }],
    });
    expect(r.alreadySold.length).toBeLessThanOrEqual(6000);
    for (const line of r.alreadySold.split('\n')) expect(line.length).toBeLessThanOrEqual(400);
    expect(r.lessons).toContain('l1');
    expect(r.lessons).toContain('because');
    expect(r.pricing).toContain('9 USD/month');
  });
});
