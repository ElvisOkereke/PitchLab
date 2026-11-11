import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb, unit } from '../helpers/db';
import { knowledgeItems, knowledgeSources } from '../../src/db/schema';
import type { KnowledgeDraft } from '../../src/library/kinds';
import { upsertKnowledgeItem } from '../../src/library/store';
import {
  computeStrength, countCorroboration, normalizeDirectness, parseAssessment, refreshAssessments, strengthLabel, OFFICIAL_SOURCE_TYPES,
} from '../../src/library/assessment';

const NOW = new Date('2026-11-10T12:00:00Z');
const DAY = 86_400_000;
const near = (s: number, dim = 1): number[] => { const v = unit(0).map(() => 0); v[0] = s; v[dim] = Math.sqrt(1 - s * s); return v; };

type In = Parameters<typeof computeStrength>[0];
const base: In = { voice: 'neutral', quoteVerified: false, corroboration: 0, fetchedAt: new Date(NOW.getTime() - 10 * DAY), sourceTypes: ['web'] };

describe('computeStrength', () => {
  const cases: [string, Partial<In>, number][] = [
    ['starts from 3', {}, 3],
    ['operator voice +1', { voice: 'operator' }, 4],
    ['customer voice +1', { voice: 'customer' }, 4],
    ['vendor voice -1', { voice: 'vendor' }, 2],
    ['null voice 0', { voice: null }, 3],
    ['verified quote +1', { quoteVerified: true }, 4],
    ['1 corroborating domain 0', { corroboration: 1 }, 3],
    ['2 corroborating domains +1', { corroboration: 2 }, 4],
    ['4 corroborating domains +1', { corroboration: 4 }, 4],
    ['5 corroborating domains +2', { corroboration: 5 }, 5],
    ['older than 730 days -1', { fetchedAt: new Date(NOW.getTime() - 731 * DAY) }, 2],
    ['exactly 730 days is not old', { fetchedAt: new Date(NOW.getTime() - 730 * DAY) }, 3],
    ['no date no penalty', { fetchedAt: null }, 3],
    ['federalregister +1', { sourceTypes: ['federalregister'] }, 4],
    ['worldbank +1', { sourceTypes: ['web', 'worldbank'] }, 4],
    ['yc +1 once even with two official types', { sourceTypes: ['yc', 'worldbank'] }, 4],
    ['clamps at 5', { voice: 'operator', quoteVerified: true, corroboration: 9, sourceTypes: ['yc'] }, 5],
    ['clamps at 1', { voice: 'vendor', fetchedAt: new Date(NOW.getTime() - 900 * DAY) }, 1],
    ['vendor and old stays at least 1', { voice: 'vendor', fetchedAt: new Date(NOW.getTime() - 900 * DAY), corroboration: 0 }, 1],
  ];
  for (const [name, over, want] of cases) it(name, () => expect(computeStrength({ ...base, ...over }, NOW)).toBe(want));
  it('official types are the three named ones', () => expect([...OFFICIAL_SOURCE_TYPES].sort()).toEqual(['federalregister', 'worldbank', 'yc']));
});

describe('strengthLabel, normalizeDirectness and parseAssessment', () => {
  it('labels strength and directness', () => {
    expect(strengthLabel({ directness: 'first_hand', bias: null, strength: 4, why: 'w', corroboration: 0 })).toBe('strength 4/5, first-hand');
    expect(strengthLabel({ directness: 'customer_review', bias: null, strength: 2, why: 'w', corroboration: 0 })).toBe('strength 2/5, customer review');
    expect(strengthLabel({ directness: 'unknown', bias: null, strength: 3, why: 'w', corroboration: 0 })).toBe('strength 3/5');
  });
  it('maps anything outside the enum to unknown', () => {
    expect(normalizeDirectness('vendor')).toBe('vendor');
    expect(normalizeDirectness('Press')).toBe('press');
    expect(normalizeDirectness('rumour')).toBe('unknown');
    expect(normalizeDirectness(null)).toBe('unknown');
    expect(normalizeDirectness(7)).toBe('unknown');
  });
  it('parses a stored assessment and rejects junk', () => {
    expect(parseAssessment({ directness: 'press', bias: 'sells ads', strength: 3, why: 'a', corroboration: 2 })).toEqual({ directness: 'press', bias: 'sells ads', strength: 3, why: 'a', corroboration: 2 });
    expect(parseAssessment(null)).toBeNull();
    expect(parseAssessment({ strength: 9, why: 'x' })).toBeNull();
    expect(parseAssessment('x')).toBeNull();
    expect(parseAssessment({ directness: 'bogus', strength: 3, why: 'x' })?.directness).toBe('unknown');
  });
});

let n = 0;
type Db = Awaited<ReturnType<typeof testDb>>;
async function add(db: Db, o: { vec: number[]; domain: string; voice?: 'operator' | 'vendor' }) {
  n++;
  const d: KnowledgeDraft = {
    kind: 'problem', title: `T${n}`, summary: `S${n}`, quote: `q${n}`, audience: 'business', countries: ['US'], industries: [], voice: o.voice ?? 'operator', facts: { persona: 'p' },
    source: { url: `https://${o.domain}/p${n}`, domain: o.domain, sourceType: 'web', quote: `q${n}`, quoteVerified: true },
  };
  const r = await upsertKnowledgeItem(db, d, o.vec, { now: NOW });
  return r.itemId;
}
/** A neighbour of another kind (so the near-duplicate merge never joins it) with one source on `domain`. */
async function neighbour(db: Db, domain: string, sim: number, dim: number, status?: 'rejected') {
  n++;
  const [row] = await db.insert(knowledgeItems).values({
    kind: 'pricing', title: `N${n}`, summary: 's', audience: 'business', countries: [], industries: [], facts: {}, embedding: near(sim, dim), contentHash: `h${n}`, ...(status ? { status } : {}),
  }).returning({ id: knowledgeItems.id });
  await db.insert(knowledgeSources).values({ itemId: row!.id, url: `https://${domain}/x${n}`, domain, sourceType: 'web', quoteVerified: false, fetchedAt: NOW });
  return row!.id;
}

describe('countCorroboration', () => {
  it('counts distinct registrable domains of similar active entries, not the same domain nor rejected entries', async () => {
    const db = await testDb();
    const self = await add(db, { vec: unit(0), domain: 'a.example.com' });
    await neighbour(db, 'www.b.example.org', 0.95, 2); // counts (registrable example.org)
    await neighbour(db, 'blog.c.co.uk', 0.92, 3); // counts (registrable c.co.uk)
    await neighbour(db, 'x.c.co.uk', 0.93, 8); // same registrable domain as the previous: counted once
    await neighbour(db, 'shop.example.com', 0.99, 5); // same registrable domain as self: ignored
    await neighbour(db, 'rejected.example.net', 0.97, 6, 'rejected'); // rejected: ignored
    await neighbour(db, 'far.example.io', 0.5, 7); // dissimilar: ignored
    expect(await countCorroboration(db, self)).toBe(2);
  });
  it('is 0 without neighbours', async () => {
    const db = await testDb();
    const id = await add(db, { vec: unit(3), domain: 'solo.example' });
    expect(await countCorroboration(db, id)).toBe(0);
  });
  it('reads at most 50 neighbour rows', async () => {
    const db = await testDb();
    const self = await add(db, { vec: unit(0), domain: 'self.example' });
    for (let i = 0; i < 55; i++) await neighbour(db, `d${i}.example.org`.replace('example.org', `site${i}.org`), 0.95, 1 + (i % 50));
    expect(await countCorroboration(db, self)).toBe(50);
  });
});

describe('refreshAssessments', () => {
  it('recomputes strength and corroboration without touching directness, bias or why', async () => {
    const db = await testDb();
    const id = await add(db, { vec: unit(0), domain: 'a.example.com', voice: 'operator' });
    await db.update(knowledgeItems).set({ assessment: { directness: 'first_hand', bias: 'none', strength: 1, why: 'kept as written', corroboration: 0 } }).where(eq(knowledgeItems.id, id));
    const unassessed = await add(db, { vec: unit(10), domain: 'u.example.com' });
    await db.update(knowledgeItems).set({ assessment: null }).where(eq(knowledgeItems.id, unassessed));
    await neighbour(db, 'b.org', 0.95, 2);
    await neighbour(db, 'c.org', 0.95, 3);
    const r = await refreshAssessments(db, NOW);
    expect(r.updated).toBe(1);
    const [row] = await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, id));
    // operator +1, verified quote +1, 2 corroborating domains +1 = 6, clamped to 5
    expect(row!.assessment).toEqual({ directness: 'first_hand', bias: 'none', strength: 5, why: 'kept as written', corroboration: 2 });
    const [u] = await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, unassessed));
    expect(u!.assessment).toBeNull();
    expect((await refreshAssessments(db, NOW)).updated).toBe(0); // idempotent
  });
});
