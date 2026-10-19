import { describe, expect, it } from 'vitest';
import { CRITERIA } from '../../src/case/schema';
import { loadPrompt } from '../../src/llm/prompts';
import * as screenModule from '../../src/pipeline/screen';
import { MAX_KILLED_SIMILARITY, screen, weightedScreenTotal } from '../../src/pipeline/screen';
import { defaultRunConfig, type StageDeps } from '../../src/pipeline/types';
import { getIdea, insertCase, insertIdea, insertRun, testDb, unit } from '../helpers/db';
import { fakeRouter } from '../helpers/fake-router';

const scores = (v: number, opts: { novelty?: number } = {}) =>
  Object.fromEntries(CRITERIA.map((c) => [c, { value: c === 'novelty' && opts.novelty !== undefined ? opts.novelty : v, note: 'n' }]));
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
    expect((await getIdea(db, b.id)).screenTotal).toBe(5);
    expect((await getIdea(db, b.id)).screenScores).toEqual(scores(5));
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

  it('lets at most 2 generated ideas per mechanism through, filling the slots from the rest of the ranking', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 3 }));
    const mon = [];
    for (let i = 0; i < 4; i++) mon.push(await insertIdea(db, run.id, { title: `Mon ${i}`, mechanism: 'monitoring' }));
    const money = await insertIdea(db, run.id, { title: 'Money', mechanism: 'money_recovery' });
    const logs: string[] = [];
    const router = fakeRouter({ structured: { screen: [scores(5), scores(5), scores(4), scores(4), scores(2)] } });
    const out = await screen({ db, router, log: (m: string) => logs.push(m) } as unknown as StageDeps, run, { ideaIds: [...mon.map((i) => i.id), money.id] });
    expect(out.ideaIds).toEqual([mon[0]!.id, mon[1]!.id, money.id]);
    expect((await getIdea(db, mon[2]!.id)).status).toBe('screened_out');
    expect((await getIdea(db, mon[3]!.id)).status).toBe('screened_out');
    expect((await getIdea(db, money.id)).status).toBe('advanced');
    expect(logs.some((l) => l.includes('Mon 2') && l.includes('monitoring'))).toBe(true);
  });

  it('never caps ideas without a mechanism', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 3 }));
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await insertIdea(db, run.id, { mechanism: null })).id);
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

  it('leaves owner ideas alone: never capped or skipped, and they use no mechanism slot', async () => {
    const db = await testDb();
    const past = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const written = await insertIdea(db, past.id, { embedding: unit(0), status: 'advanced' });
    await insertCase(db, written.id);
    const run = await insertRun(db, defaultRunConfig({ seedType: 'idea', advanceCount: 2 }));
    const owner = await insertIdea(db, run.id, { origin: 'owner', mechanism: 'monitoring', embedding: unit(0) });
    const g1 = await insertIdea(db, run.id, { mechanism: 'monitoring', embedding: unit(3) });
    const g2 = await insertIdea(db, run.id, { mechanism: 'monitoring', embedding: unit(4) });
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

  describe('ranking: novelty weight, no crowd penalty (screen.v3)', () => {
    it('weightedScreenTotal counts novelty twice: (sum of the 7 criteria + novelty) / 8', () => {
      expect(weightedScreenTotal(scores(3, { novelty: 5 }) as never)).toBeCloseTo((6 * 3 + 5 + 5) / 8);
      expect(weightedScreenTotal(scores(4) as never)).toBe(4);
    });

    it('no longer exports a crowd penalty, and screen.v3 asks for no competitor list', () => {
      expect('crowdPenalty' in screenModule).toBe(false);
      const p = loadPrompt('screen');
      expect(p.version).toBe('screen.v3');
      const text = p.render({ idea: '<idea>x</idea>' });
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
        expect(row.screenTotal).toBeCloseTo(weightedScreenTotal(given[i] as never));
        expect(row.screenScores).toEqual(given[i]);
      }
      expect(logs.some((l) => l.includes('"High"') && l.includes('total 3.75'))).toBe(true);
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
      expect(row.screenTotal).toBe(4);
      expect(row.screenScores).toEqual(scores(4));
    });

    it('ranks novelty 5 above novelty 1 when everything else is equal', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 1 }));
      const plain = await insertIdea(db, run.id);
      const novel = await insertIdea(db, run.id);
      const router = fakeRouter({ structured: { screen: [scores(3, { novelty: 1 }), scores(3, { novelty: 5 })] } });
      const out = await screen(deps(db, router), run, { ideaIds: [plain.id, novel.id] });
      expect(out.ideaIds).toEqual([novel.id]);
      expect((await getIdea(db, plain.id)).screenTotal).toBeCloseTo((6 * 3 + 1 + 1) / 8); // 2.5
      expect((await getIdea(db, novel.id)).screenTotal).toBeCloseTo((6 * 3 + 5 + 5) / 8); // 3.5
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
});
