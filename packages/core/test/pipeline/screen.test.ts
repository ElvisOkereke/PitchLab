import { describe, expect, it } from 'vitest';
import { CRITERIA } from '../../src/case/schema';
import { loadPrompt } from '../../src/llm/prompts';
import * as screenModule from '../../src/pipeline/screen';
import { barrierScore, MAX_KILLED_SIMILARITY, MAX_PER_BUSINESS_MODEL, moneyBand, screen, weightedScreenTotal } from '../../src/pipeline/screen';
import { defaultRunConfig, type StageDeps } from '../../src/pipeline/types';
import { getIdea, insertCase, insertIdea, insertRun, testDb, unit } from '../helpers/db';
import { fakeRouter } from '../helpers/fake-router';

const scores = (v: number, opts: { novelty?: number } = {}) =>
  Object.fromEntries(CRITERIA.map((c) => [c, { value: c === 'novelty' && opts.novelty !== undefined ? opts.novelty : v, note: 'n' }]));
/** What screen stores for an idea with no money or barrier data: the model's scores plus moneyCase 2 and barrier 3. */
const stored = (s: unknown) => ({ ...(s as object), moneyCase: expect.objectContaining({ value: 2 }), barrier: expect.objectContaining({ value: 3 }) });
const deps = (db: unknown, router: unknown) => ({ db, router, log: () => {} }) as unknown as StageDeps;
/** A unit vector whose cosine with unit(axis) is exactly `sim` (the rest goes on an otherwise unused axis). */
const atSimilarity = (sim: number, axis = 0, spare = 5) => {
  const v = Array<number>(1536).fill(0);
  v[axis] = sim;
  v[spare] = Math.sqrt(1 - sim * sim);
  return v;
};

describe('screen', () => {
  it('advances the top N by mean score, ties by input order', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 2 }));
    const [a, b, c] = [await insertIdea(db, run.id), await insertIdea(db, run.id), await insertIdea(db, run.id)];
    const router = fakeRouter({ structured: { screen: [scores(3), scores(5), scores(3)] } });
    const out = await screen(deps(db, router), run, { ideaIds: [a.id, b.id, c.id] });
    expect(out.ideaIds).toEqual([b.id, a.id]);
    expect((await getIdea(db, a.id)).status).toBe('advanced');
    expect((await getIdea(db, b.id)).status).toBe('advanced');
    expect((await getIdea(db, c.id)).status).toBe('screened_out');
    expect((await getIdea(db, b.id)).screenTotal).toBeCloseTo((7 * 5 + 5 + 2 + 3) / 10);
    expect((await getIdea(db, b.id)).screenScores).toEqual(stored(scores(5)));
  });

  it('skips a winner too similar (cosine > 0.8) to an already-advanced idea', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 2 }));
    const nearA = unit(0);
    nearA[1] = 0.1; // cosine with unit(0) ≈ 0.995
    const a = await insertIdea(db, run.id, { embedding: unit(0) });
    const b = await insertIdea(db, run.id, { embedding: nearA });
    const c = await insertIdea(db, run.id, { embedding: unit(1) });
    const router = fakeRouter({ structured: { screen: [scores(5), scores(4), scores(3)] } });
    const out = await screen(deps(db, router), run, { ideaIds: [a.id, b.id, c.id] });
    expect(out.ideaIds).toEqual([a.id, c.id]);
    expect((await getIdea(db, b.id)).status).toBe('screened_out');
    expect((await getIdea(db, c.id)).status).toBe('advanced');
  });

  it('lets at most 2 generated ideas per business model through, filling the slots from the rest of the ranking', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 3 }));
    const mon = [];
    for (let i = 0; i < 4; i++) mon.push(await insertIdea(db, run.id, { title: `Mon ${i}`, businessModel: 'usage' }));
    const money = await insertIdea(db, run.id, { title: 'Money', businessModel: 'ads' });
    const logs: string[] = [];
    const router = fakeRouter({ structured: { screen: [scores(5), scores(5), scores(4), scores(4), scores(2)] } });
    const out = await screen({ db, router, log: (m: string) => logs.push(m) } as unknown as StageDeps, run, { ideaIds: [...mon.map((i) => i.id), money.id] });
    expect(out.ideaIds).toEqual([mon[0]!.id, mon[1]!.id, money.id]);
    expect((await getIdea(db, mon[2]!.id)).status).toBe('screened_out');
    expect((await getIdea(db, mon[3]!.id)).status).toBe('screened_out');
    expect((await getIdea(db, money.id)).status).toBe('advanced');
    expect(logs.some((l) => l.includes('Mon 2') && l.includes('usage'))).toBe(true);
  });

  it('never caps ideas without a business model', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 3 }));
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await insertIdea(db, run.id, { businessModel: null })).id);
    const router = fakeRouter({ structured: { screen: [scores(5), scores(4), scores(3)] } });
    const out = await screen(deps(db, router), run, { ideaIds: ids });
    expect(out.ideaIds).toEqual(ids);
  });

  it('skips a candidate too similar (cosine >= 0.82) to an idea from any run that already has a case', async () => {
    const db = await testDb();
    const past = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const written = await insertIdea(db, past.id, { embedding: unit(0), status: 'advanced' });
    await insertCase(db, written.id);
    await insertIdea(db, past.id, { embedding: unit(1), status: 'screened_out' }); // no case: does not block
    await insertIdea(db, past.id, { embedding: Array<number>(1536).fill(0), status: 'advanced' }).then((z) => insertCase(db, z.id)); // NaN similarity: ignored

    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 1 }));
    const copy = unit(0);
    copy[2] = 0.5; // cosine with unit(0) ≈ 0.894
    const regenerated = await insertIdea(db, run.id, { title: 'Regenerated', embedding: copy });
    const fresh = await insertIdea(db, run.id, { title: 'Fresh', embedding: unit(1) });
    const logs: string[] = [];
    const router = fakeRouter({ structured: { screen: [scores(5), scores(3)] } });
    const out = await screen({ db, router, log: (m: string) => logs.push(m) } as unknown as StageDeps, run, { ideaIds: [regenerated.id, fresh.id] });
    expect(out.ideaIds).toEqual([fresh.id]);
    expect((await getIdea(db, regenerated.id)).status).toBe('screened_out');
    expect(logs.some((l) => l.includes('Regenerated') && l.includes('case'))).toBe(true);
  });

  it('does not skip a candidate below the 0.82 similarity to a past case idea', async () => {
    const db = await testDb();
    const past = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const written = await insertIdea(db, past.id, { embedding: unit(0), status: 'advanced' });
    await insertCase(db, written.id);
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 1 }));
    const near = unit(0);
    near[2] = 0.75; // cosine ≈ 0.8
    const idea = await insertIdea(db, run.id, { embedding: near });
    const out = await screen(deps(db, fakeRouter({ structured: { screen: [scores(4)] } })), run, { ideaIds: [idea.id] });
    expect(out.ideaIds).toEqual([idea.id]);
  });

  it('leaves owner ideas alone: never capped or skipped, and they use no business-model slot', async () => {
    const db = await testDb();
    const past = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const written = await insertIdea(db, past.id, { embedding: unit(0), status: 'advanced' });
    await insertCase(db, written.id);
    const run = await insertRun(db, defaultRunConfig({ seedType: 'idea', advanceCount: 2 }));
    const owner = await insertIdea(db, run.id, { origin: 'owner', businessModel: 'usage', embedding: unit(0) });
    const g1 = await insertIdea(db, run.id, { businessModel: 'usage', embedding: unit(3) });
    const g2 = await insertIdea(db, run.id, { businessModel: 'usage', embedding: unit(4) });
    const out = await screen(deps(db, fakeRouter({ structured: { screen: [scores(4), scores(3)] } })), run, { ideaIds: [owner.id, g1.id, g2.id] });
    expect(out.ideaIds).toEqual([owner.id, g1.id, g2.id]);
    expect((await getIdea(db, owner.id)).status).toBe('advanced');
  });

  it('caps idea fields and collapses newlines before they reach the prompt', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 1 }));
    const idea = await insertIdea(db, run.id, { title: 'Line one\nLine two', problem: 'p'.repeat(5000) });
    const router = fakeRouter({ structured: { screen: [scores(3)] } });
    await screen(deps(db, router), run, { ideaIds: [idea.id] });
    const prompt = router.calls[0]!.prompt;
    expect(prompt).toContain('Title: Line one Line two\n');
    expect(prompt).toContain('p'.repeat(2000));
    expect(prompt).not.toContain('p'.repeat(2001));
  });

  describe('ranking: novelty weight, no crowd penalty, money and barrier (screen.v4)', () => {
    it('weightedScreenTotal counts novelty twice: (sum of the 7 criteria + novelty) / 8', () => {
      expect(weightedScreenTotal(scores(3, { novelty: 5 }) as never)).toBeCloseTo((6 * 3 + 5 + 5) / 8);
      expect(weightedScreenTotal(scores(4) as never)).toBe(4);
      const full = { ...scores(3, { novelty: 5 }), moneyCase: { value: 5, note: 'n' }, barrier: { value: 1, note: 'n' } };
      expect(weightedScreenTotal(full as never)).toBeCloseTo((6 * 3 + 5 + 5 + 5 + 1) / 10);
    });

    it('no longer exports a crowd penalty, and screen.v4 asks for no competitor list', () => {
      expect('crowdPenalty' in screenModule).toBe(false);
      const p = loadPrompt('screen');
      expect(p.version).toBe('screen.v4');
      const text = p.render({ idea: '<idea>x</idea>', computed: 'Money case: 2 of 5' });
      expect(text).not.toContain('knownCompetitors');
      expect(text).not.toMatch(/competitor/i);
      for (const c of CRITERIA) expect(text).toContain(`- ${c}:`);
    });

    it('ranks by the weighted score alone and stores it as the screen total', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 2 }));
      const ideasIn = [await insertIdea(db, run.id, { title: 'Low' }), await insertIdea(db, run.id, { title: 'High' }), await insertIdea(db, run.id, { title: 'Mid' })];
      const given = [scores(2, { novelty: 4 }), scores(4, { novelty: 3 }), scores(3, { novelty: 3 })];
      const logs: string[] = [];
      const router = fakeRouter({ structured: { screen: given.map((s) => ({ ...s })) } });
      const out = await screen({ db, router, log: (m: string) => logs.push(m) } as unknown as StageDeps, run, { ideaIds: ideasIn.map((i) => i.id) });
      expect(out.ideaIds).toEqual([ideasIn[1]!.id, ideasIn[2]!.id]);
      for (const [i, idea] of ideasIn.entries()) {
        const row = await getIdea(db, idea.id);
        expect(row.screenTotal).toBeCloseTo(weightedScreenTotal({ ...given[i], moneyCase: { value: 2, note: '' }, barrier: { value: 3, note: '' } } as never));
        expect(row.screenScores).toEqual(stored(given[i]));
      }
      expect(logs.some((l) => l.includes('"High"') && l.includes('total 3.50'))).toBe(true);
      expect(logs.some((l) => l.includes('penalty'))).toBe(false);
    });

    it('ties on equal raw scores go to input order', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 2 }));
      const ids = [];
      for (let i = 0; i < 4; i++) ids.push((await insertIdea(db, run.id)).id);
      const router = fakeRouter({ structured: { screen: [scores(3), scores(3), scores(3), scores(3)] } });
      const out = await screen(deps(db, router), run, { ideaIds: ids });
      expect(out.ideaIds).toEqual([ids[0], ids[1]]);
    });

    it('ignores a stray knownCompetitors list in a model response (old screen.v2 shape)', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 1 }));
      const idea = await insertIdea(db, run.id);
      const router = fakeRouter({ structured: { screen: [{ ...scores(4), knownCompetitors: ['A', 'B', 'C', 'D'] }] } });
      await screen(deps(db, router), run, { ideaIds: [idea.id] });
      const row = await getIdea(db, idea.id);
      expect(row.screenTotal).toBeCloseTo((7 * 4 + 4 + 2 + 3) / 10);
      expect(row.screenScores).toEqual(stored(scores(4)));
    });

    it('ranks novelty 5 above novelty 1 when everything else is equal', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 1 }));
      const plain = await insertIdea(db, run.id);
      const novel = await insertIdea(db, run.id);
      const router = fakeRouter({ structured: { screen: [scores(3, { novelty: 1 }), scores(3, { novelty: 5 })] } });
      const out = await screen(deps(db, router), run, { ideaIds: [plain.id, novel.id] });
      expect(out.ideaIds).toEqual([novel.id]);
      expect((await getIdea(db, plain.id)).screenTotal).toBeCloseTo((6 * 3 + 1 + 1 + 2 + 3) / 10); // 2.5
      expect((await getIdea(db, novel.id)).screenTotal).toBeCloseTo((6 * 3 + 5 + 5 + 2 + 3) / 10); // 3.3
    });
  });

  describe('past-kill skip', () => {
    it('skips a candidate at similarity 0.76 to a gated_out idea, but not at 0.70', async () => {
      expect(MAX_KILLED_SIMILARITY).toBe(0.75);
      const db = await testDb();
      const past = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
      const killed = await insertIdea(db, past.id, { embedding: unit(0), status: 'gated_out' });
      await insertIdea(db, past.id, { embedding: Array<number>(1536).fill(0), status: 'gated_out' }); // NaN similarity: ignored
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 2 }));
      const copy = await insertIdea(db, run.id, { title: 'Copy', embedding: atSimilarity(0.76) });
      const distinct = await insertIdea(db, run.id, { title: 'Distinct', embedding: atSimilarity(0.7) });
      const logs: string[] = [];
      const router = fakeRouter({ structured: { screen: [scores(5), scores(4)] } });
      const out = await screen({ db, router, log: (m: string) => logs.push(m) } as unknown as StageDeps, run, { ideaIds: [copy.id, distinct.id] });
      expect(out.ideaIds).toEqual([distinct.id]);
      expect((await getIdea(db, copy.id)).status).toBe('screened_out');
      expect(logs.some((l) => l.includes('Copy') && l.includes(`similarity 0.760 to idea ${killed.id}, which the gate already killed`))).toBe(true);
    });

    it('never skips a candidate without an embedding', async () => {
      const db = await testDb();
      const past = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
      await insertIdea(db, past.id, { embedding: unit(0), status: 'gated_out' });
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 1 }));
      const idea = await insertIdea(db, run.id, { embedding: null });
      const out = await screen(deps(db, fakeRouter({ structured: { screen: [scores(4)] } })), run, { ideaIds: [idea.id] });
      expect(out.ideaIds).toEqual([idea.id]);
    });

    it('does not mistake a re-screened killed idea for itself, but does see another killed idea in the same run', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 2 }));
      // A re-run of screen: this idea was already killed by the gate; it must not match its own row.
      const self = await insertIdea(db, run.id, { title: 'Self', embedding: unit(0), status: 'gated_out' });
      const sibling = await insertIdea(db, run.id, { title: 'Sibling', embedding: unit(1), status: 'gated_out' });
      const nearSibling = await insertIdea(db, run.id, { title: 'Near sibling', embedding: atSimilarity(0.9, 1, 7) });
      const logs: string[] = [];
      const router = fakeRouter({ structured: { screen: [scores(5), scores(4)] } });
      const out = await screen({ db, router, log: (m: string) => logs.push(m) } as unknown as StageDeps, run, { ideaIds: [self.id, nearSibling.id] });
      expect(out.ideaIds).toEqual([self.id]);
      expect((await getIdea(db, nearSibling.id)).status).toBe('screened_out');
      expect(logs.some((l) => l.includes('Near sibling') && l.includes(sibling.id))).toBe(true);
    });

    it('leaves owner ideas untouched even when they match a killed idea', async () => {
      const db = await testDb();
      const past = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
      await insertIdea(db, past.id, { embedding: unit(0), status: 'gated_out' });
      const run = await insertRun(db, defaultRunConfig({ seedType: 'idea', advanceCount: 1 }));
      const owner = await insertIdea(db, run.id, { origin: 'owner', embedding: unit(0) });
      const router = fakeRouter({ structured: { screen: [] } });
      const out = await screen(deps(db, router), run, { ideaIds: [owner.id] });
      expect(out.ideaIds).toEqual([owner.id]);
      expect(router.calls).toHaveLength(0);
      expect((await getIdea(db, owner.id)).status).toBe('advanced');
    });
  });

  it('advances owner ideas without scoring or using a slot', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'idea', advanceCount: 1 }));
    const owner = await insertIdea(db, run.id, { origin: 'owner' });
    const g1 = await insertIdea(db, run.id);
    const g2 = await insertIdea(db, run.id);
    const router = fakeRouter({ structured: { screen: [scores(2), scores(4)] } });
    const out = await screen(deps(db, router), run, { ideaIds: [owner.id, g1.id, g2.id] });
    expect(router.calls).toHaveLength(2);
    expect(out.ideaIds).toEqual([owner.id, g2.id]);
    expect((await getIdea(db, owner.id)).status).toBe('advanced');
    expect((await getIdea(db, g1.id)).status).toBe('screened_out');
  });

  describe('screen.v4: money case and barrier', () => {
    const value = { kind: 'save' as const, amountPerYear: 1200, basis: 'b' };
    const price = (amount: number, unit: string) => ({ amount, unit, basis: 'b' });
    const barriers = (toStart: number, toCopy: number) => ({ toStart, toStartWhy: 'w', toCopy, toCopyWhy: 'w', soloBuildable: true });

    it('moneyBand follows the value multiple bands; null is band 2', () => {
      expect([20, 10, 9.99, 5, 4.99, 3, 2.99, 1.5, 1.49, 0.2].map(moneyBand)).toEqual([5, 5, 4, 4, 3, 3, 2, 2, 1, 1]);
      expect(moneyBand(null)).toBe(2);
    });

    it('barrierScore = round(((6 - toStart) + toCopy) / 2), clamped 1-5; null is 3', () => {
      expect(barrierScore(barriers(1, 5))).toBe(5);
      expect(barrierScore(barriers(5, 1))).toBe(1);
      expect(barrierScore(barriers(2, 4))).toBe(4);
      expect(barrierScore(barriers(3, 3))).toBe(3);
      expect(barrierScore(barriers(4, 3))).toBe(3); // 2.5 rounds up
      expect(barrierScore(null)).toBe(3);
    });

    it('computes both scores in code, stores them, ranks on them, and ignores model overrides', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 1 }));
      const poor = await insertIdea(db, run.id, { title: 'Poor', valueToUser: value, priceHint: price(1200, 'year'), barriers: barriers(5, 1) }); // 1x -> band 1, barrier 1
      const rich = await insertIdea(db, run.id, { title: 'Rich', valueToUser: value, priceHint: price(10, 'month'), barriers: barriers(1, 5) }); // 10x -> band 5, barrier 5
      const router = fakeRouter({ structured: { screen: [
        { ...scores(4), moneyCase: { value: 5, note: 'model says' }, barrier: { value: 5, note: 'model says' } },
        scores(4),
      ] } });
      const out = await screen(deps(db, router), run, { ideaIds: [poor.id, rich.id] });
      expect(out.ideaIds).toEqual([rich.id]);
      const p = (await getIdea(db, poor.id)).screenScores as Record<string, { value: number }>;
      const r = (await getIdea(db, rich.id)).screenScores as Record<string, { value: number }>;
      expect([p.moneyCase!.value, p.barrier!.value, r.moneyCase!.value, r.barrier!.value]).toEqual([1, 1, 5, 5]);
      expect((await getIdea(db, poor.id)).screenTotal).toBeCloseTo((7 * 4 + 4 + 1 + 1) / 10);
      expect((await getIdea(db, rich.id)).screenTotal).toBeCloseTo((7 * 4 + 4 + 5 + 5) / 10);
      expect(router.calls[0]!.prompt).toMatch(/Money case \(computed[^\n]*\): 1 of 5/);
      expect(router.calls[1]!.prompt).toMatch(/Money case \(computed[^\n]*\): 5 of 5/);
      expect(router.calls[1]!.prompt).toMatch(/Barrier \(computed[^\n]*\): 5 of 5/);
    });

    it('missing money or barrier data scores moneyCase 2 and barrier 3, and the null count is logged', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 2 }));
      const a = await insertIdea(db, run.id);
      const b = await insertIdea(db, run.id, { valueToUser: value, priceHint: price(5, 'per use') }); // cannot annualise
      const logs: string[] = [];
      const router = fakeRouter({ structured: { screen: [scores(3), scores(3)] } });
      await screen({ db, router, log: (m: string) => logs.push(m) } as unknown as StageDeps, run, { ideaIds: [a.id, b.id] });
      for (const i of [a, b]) {
        const sc = (await getIdea(db, i.id)).screenScores as Record<string, { value: number }>;
        expect([sc.moneyCase!.value, sc.barrier!.value]).toEqual([2, 3]);
      }
      expect(logs.some((l) => l.includes('2 of 2') && l.includes('no value multiple'))).toBe(true);
    });

    it('caps gate entrants at 2 per business model; a null model is not capped', async () => {
      expect(MAX_PER_BUSINESS_MODEL).toBe(2);
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 4 }));
      const subs = [];
      for (let i = 0; i < 4; i++) subs.push(await insertIdea(db, run.id, { title: `Sub ${i}`, businessModel: 'subscription' }));
      const ads = await insertIdea(db, run.id, { title: 'Ads', businessModel: 'ads' });
      const nulls = [await insertIdea(db, run.id, { businessModel: null }), await insertIdea(db, run.id, { businessModel: null })];
      const logs: string[] = [];
      const router = fakeRouter({ structured: { screen: [scores(5), scores(5), scores(4), scores(4), scores(3), scores(2), scores(2)] } });
      const out = await screen({ db, router, log: (m: string) => logs.push(m) } as unknown as StageDeps, run, { ideaIds: [...subs, ads, ...nulls].map((i) => i.id) });
      expect(out.ideaIds).toEqual([subs[0]!.id, subs[1]!.id, ads.id, nulls[0]!.id]);
      expect(logs.some((l) => l.includes('Sub 2') && l.includes('subscription'))).toBe(true);
    });

    it('swaps the lowest-ranked business entrant for a consumer idea that passes the thresholds', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 2 }));
      const b1 = await insertIdea(db, run.id, { title: 'B1', audience: 'business', businessModel: 'subscription' });
      const b2 = await insertIdea(db, run.id, { title: 'B2', audience: 'business', businessModel: 'usage' });
      const c1 = await insertIdea(db, run.id, { title: 'C1', audience: 'consumer', businessModel: 'ads' });
      const c2 = await insertIdea(db, run.id, { title: 'C2', audience: 'both', businessModel: 'affiliate' });
      const router = fakeRouter({ structured: { screen: [scores(5), scores(4), scores(3), scores(2)] } });
      const out = await screen(deps(db, router), run, { ideaIds: [b1.id, b2.id, c1.id, c2.id] });
      expect(out.ideaIds).toEqual([b1.id, c1.id]);
      expect((await getIdea(db, b2.id)).status).toBe('screened_out');
      expect((await getIdea(db, c1.id)).status).toBe('advanced');
    });

    it('does not swap when the consumer candidate fails a threshold, or none is needed', async () => {
      const db = await testDb();
      const past = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
      await insertIdea(db, past.id, { embedding: unit(0), status: 'gated_out' });
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 2 }));
      const b1 = await insertIdea(db, run.id, { audience: 'business', embedding: unit(1) });
      const b2 = await insertIdea(db, run.id, { audience: 'business', embedding: unit(2) });
      const killedCopy = await insertIdea(db, run.id, { audience: 'consumer', embedding: atSimilarity(0.9) });
      const router = fakeRouter({ structured: { screen: [scores(5), scores(4), scores(3)] } });
      const out = await screen(deps(db, router), run, { ideaIds: [b1.id, b2.id, killedCopy.id] });
      expect(out.ideaIds).toEqual([b1.id, b2.id]);
    });
  });
});
