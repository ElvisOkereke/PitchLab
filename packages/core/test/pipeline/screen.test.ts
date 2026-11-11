import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { CRITERIA } from '../../src/case/schema';
import { loadPrompt } from '../../src/llm/prompts';
import { StructuredOutputError } from '../../src/llm/router';
import { gate } from '../../src/pipeline/gate';
import * as screenModule from '../../src/pipeline/screen';
import { barrierScore, MAX_KILLED_SIMILARITY, MAX_PER_BUSINESS_MODEL, moneyBand, reviewBand, screen, weightedScreenTotal } from '../../src/pipeline/screen';
import { defaultRunConfig, type StageDeps } from '../../src/pipeline/types';
import { eq } from 'drizzle-orm';
import { ideas, knowledgeItems, signals, type SignalVoice } from '../../src/db/schema';
import { setSetting } from '../../src/validation/settings';
import { FLOOR_ESTIMATE, getIdea, insertCase, insertIdea as insertBareIdea, insertRun, testDb, unit } from '../helpers/db';
import { fakeRouter } from '../helpers/fake-router';

type TestDb = Awaited<ReturnType<typeof testDb>>;
let sigSeq = 0;
/** Inserts one signal per entry (voice, domain) and returns the ids. */
async function sigs(db: TestDb, list: { voice: SignalVoice | null; domain?: string; kind?: 'pain' | 'opportunity' }[]): Promise<string[]> {
  if (list.length === 0) return [];
  const rows = await db.insert(signals).values(list.map(({ voice, domain, kind }) => {
    const n = ++sigSeq;
    return {
      marketId: 'ca-us', source: 'web', url: `https://${domain ?? `d${n}.test`}/post/${n}`, title: 'T', quote: `q${n}`, quoteHash: `h${n}`, voice,
      ...(kind ? { kind } : {}),
    };
  })).returning({ id: signals.id });
  return rows.map((r) => r.id);
}
/** Evidence that meets the gate's rule at the default minSignals 3: three operator signals on distinct domains. */
const enough = (db: TestDb) => sigs(db, [{ voice: 'operator' }, { voice: 'operator' }, { voice: 'operator' }]);
/**
 * Like the shared helper, but an idea gets enough evidence unless the test passes its own signalIds, and clears the buyer
 * floor (FLOOR_ESTIMATE) unless the test passes its own scaleEstimate or scaleResult.
 */
const insertIdea: typeof insertBareIdea = async (db, runId, overrides = {}) =>
  insertBareIdea(db, runId, {
    ...(overrides.signalIds ? {} : { signalIds: await enough(db) }),
    ...('scaleEstimate' in overrides || 'scaleResult' in overrides ? {} : { scaleEstimate: FLOOR_ESTIMATE }),
    ...overrides,
  });

const scores = (v: number, opts: { novelty?: number } = {}) =>
  Object.fromEntries(CRITERIA.map((c) => [c, { value: c === 'novelty' && opts.novelty !== undefined ? opts.novelty : v, note: 'n' }]));
/**
 * What screen stores for an idea with no money, barrier, edge, scale or value data: the model's scores plus moneyCase 2,
 * barrier 3, edge and scale 2 and upside 3 (computed, screen.v6).
 */
const stored = (s: unknown) => ({
  ...(s as object), moneyCase: expect.objectContaining({ value: 2 }), barrier: expect.objectContaining({ value: 3 }),
  edge: expect.objectContaining({ value: 2 }), scale: expect.objectContaining({ value: 2 }), upside: expect.objectContaining({ value: 3 }),
});
type Vals = Record<string, { value: number }>;
type Extra = Partial<Record<'moneyCase' | 'barrier' | 'edge' | 'scale' | 'upside', number>>;
/**
 * The screen.v5 rank (stored v5 scores), pinned independently of the code: a weighted mean where every value weighs 1
 * except speed (0.5): (pain + roi + evidence + 0.5 speed + autonomy + novelty + reach + moneyCase + barrier + edge + scale) / 10.5.
 */
const total5 = (m: unknown, extra: Extra = {}) => {
  const v = m as Vals;
  const x = { moneyCase: 2, barrier: 3, edge: v.edge?.value ?? 2, scale: v.scale?.value ?? 2, ...extra };
  return (v.pain!.value + v.roi!.value + v.evidence!.value + 0.5 * v.speed!.value + v.autonomy!.value + v.novelty!.value + v.reach!.value
    + x.moneyCase + x.barrier + x.edge + x.scale) / 10.5;
};
/**
 * The screen.v6 rank, pinned independently of the code: the v5 values plus upside, all weighing 1 except speed (0.5),
 * over 11.5. Scale and upside are computed by code, so `extra` gives them (defaults: an idea with no data, scale 2,
 * upside 3); edge is the model's when it gives one.
 */
const total6 = (m: unknown, extra: Extra = {}) => {
  const v = m as Vals;
  const x = { moneyCase: 2, barrier: 3, edge: v.edge?.value ?? 2, scale: 2, upside: 3, ...extra };
  return (v.pain!.value + v.roi!.value + v.evidence!.value + 0.5 * v.speed!.value + v.autonomy!.value + v.novelty!.value + v.reach!.value
    + x.moneyCase + x.barrier + x.edge + x.scale + x.upside) / 11.5;
};
/** The ideate.v12 edge and scale, valid for ideaBlock. */
const EDGE = { kind: 'cost', claim: 'Half the price of Cass per invoice line', versus: 'Cass audit service', whyNow: 'PDF extraction got cheap' };
const SCALE = { buyers: '60,000 US freight brokers', basis: 'FMCSA broker registrations' };
/** The screen-stage calls (a v2 screen also makes review calls first). */
const screenCalls = (r: { calls: { stage: string; prompt: string }[] }) => r.calls.filter((c) => c.stage === 'screen');
/**
 * Stage deps. A v2 screen reviews first; a test that scripts no review answers (fakeRouter throws a plain Error) gets the
 * model failure it stands for (invalid output), so the screen carries on unreviewed. Plain errors from other stages pass through.
 */
const deps = (db: unknown, router: unknown, log: (m: string) => void = () => {}) => {
  const r = router as { structured: (stage: string, ...rest: unknown[]) => Promise<unknown> };
  const wrapped = Object.create(r) as typeof r;
  wrapped.structured = async (stage, ...rest) => {
    try {
      return await r.structured(stage, ...rest);
    } catch (err) {
      if (stage === 'review' && err instanceof Error && err.message.startsWith('fakeRouter: no scripted')) throw new StructuredOutputError('review: not scripted', 'n/a');
      throw err;
    }
  };
  return { db, router: wrapped, log } as unknown as StageDeps;
};
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
    expect((await getIdea(db, b.id)).screenTotal).toBeCloseTo(total6(scores(5)));
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
    const out = await screen(deps(db, router, (m: string) => logs.push(m)), run, { ideaIds: [...mon.map((i) => i.id), money.id] });
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
    const out = await screen(deps(db, router, (m: string) => logs.push(m)), run, { ideaIds: [regenerated.id, fresh.id] });
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
    const prompt = screenCalls(router)[0]!.prompt;
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

    it('no longer exports a crowd penalty, and the screen prompt asks for no competitor list', () => {
      expect('crowdPenalty' in screenModule).toBe(false);
      const p = loadPrompt('screen');
      expect(p.version).toBe('screen.v6');
      const text = p.render({ idea: '<idea>x</idea>', computed: 'Money case: 2 of 5', edge: '', criteriaList: 'x' });
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
      const out = await screen(deps(db, router, (m: string) => logs.push(m)), run, { ideaIds: ideasIn.map((i) => i.id) });
      expect(out.ideaIds).toEqual([ideasIn[1]!.id, ideasIn[2]!.id]);
      for (const [i, idea] of ideasIn.entries()) {
        const row = await getIdea(db, idea.id);
        expect(row.screenTotal).toBeCloseTo(total6(given[i]));
        expect(row.screenScores).toEqual(stored(given[i]));
      }
      expect(logs.some((l) => l.includes('"High"') && l.includes('total 3.22'))).toBe(true); // 37 / 11.5
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
      expect(row.screenTotal).toBeCloseTo(total6(scores(4)));
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
      expect((await getIdea(db, plain.id)).screenTotal).toBeCloseTo(29.5 / 11.5);
      expect((await getIdea(db, novel.id)).screenTotal).toBeCloseTo(33.5 / 11.5);
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
      const out = await screen(deps(db, router, (m: string) => logs.push(m)), run, { ideaIds: [copy.id, distinct.id] });
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
      const out = await screen(deps(db, router, (m: string) => logs.push(m)), run, { ideaIds: [self.id, nearSibling.id] });
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
      expect(screenCalls(router)).toHaveLength(0);
      expect((await getIdea(db, owner.id)).status).toBe('advanced');
    });
  });

  describe('pre-gate evidence filter: only candidates that meet the gate evidence rule can become entrants', () => {
    it('skips a candidate whose cited signals give fewer than minSignals independent sources, logs it and the count', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 2 }));
      const vendor = await insertIdea(db, run.id, { title: 'Vendor-backed', signalIds: await sigs(db, [{ voice: 'operator' }, { voice: 'operator' }, { voice: 'vendor' }]) });
      const oneSite = await insertIdea(db, run.id, { title: 'One site', signalIds: await sigs(db, [{ voice: 'operator', domain: 'same.test' }, { voice: 'operator', domain: 'same.test' }, { voice: 'neutral' }]) });
      const untagged = await insertIdea(db, run.id, { title: 'Untagged', signalIds: await sigs(db, [{ voice: 'operator' }, { voice: 'operator' }, { voice: null }]) });
      const none = await insertIdea(db, run.id, { title: 'None', signalIds: [] });
      const ok = await insertIdea(db, run.id, { title: 'Ok', signalIds: await sigs(db, [{ voice: 'operator' }, { voice: 'operator' }, { voice: 'neutral' }]) });
      const ok2 = await insertIdea(db, run.id, { title: 'Ok2' });
      const logs: string[] = [];
      const router = fakeRouter({ structured: { screen: [scores(5), scores(5), scores(5), scores(5), scores(3), scores(2)] } });
      const out = await screen(deps(db, router, (m: string) => logs.push(m)), run, { ideaIds: [vendor, oneSite, untagged, none, ok, ok2].map((i) => i.id) });
      expect(out.ideaIds).toEqual([ok.id, ok2.id]);
      for (const i of [vendor, oneSite, untagged, none]) expect((await getIdea(db, i.id)).status).toBe('screened_out');
      expect(logs.some((l) => l.includes('"Vendor-backed"') && l.includes('2 independent sources') && l.includes('gate needs 3'))).toBe(true);
      expect(logs.some((l) => l.includes('"None"') && l.includes('0 independent sources'))).toBe(true);
      expect(logs).toContain('screen: 4 of 6 candidates have too little evidence for the gate (fewer than 3 independent sources and no demand source) and cannot advance');
    });

    it('applies to the consumer swap too: a consumer candidate without enough evidence is passed over', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 2 }));
      const b1 = await insertIdea(db, run.id, { audience: 'business', businessModel: 'subscription' });
      const b2 = await insertIdea(db, run.id, { audience: 'business', businessModel: 'usage' });
      const thin = await insertIdea(db, run.id, { audience: 'consumer', businessModel: 'ads', signalIds: await sigs(db, [{ voice: 'operator' }]) });
      const backed = await insertIdea(db, run.id, { audience: 'consumer', businessModel: 'affiliate' });
      const router = fakeRouter({ structured: { screen: [scores(5), scores(4), scores(3), scores(2)] } });
      const out = await screen(deps(db, router), run, { ideaIds: [b1.id, b2.id, thin.id, backed.id] });
      expect(out.ideaIds).toEqual([b1.id, backed.id]);
      expect((await getIdea(db, thin.id)).status).toBe('screened_out');
    });

    it('skips a candidate that fails the buyer floor (no estimate, no source, under the floor), logs it and the count', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 2 }));
      const pop = (count: number, source?: string) => ({ ...FLOOR_ESTIMATE, population: { count, basis: 'b', ...(source === undefined ? {} : { source }) } });
      const none = await insertIdea(db, run.id, { title: 'No estimate', scaleEstimate: null });
      const unsourced = await insertIdea(db, run.id, { title: 'Unsourced', scaleEstimate: pop(500_000) as never });
      const small = await insertIdea(db, run.id, { title: 'Small', scaleEstimate: pop(5_000, 'https://stats.example/x') as never });
      const ok = await insertIdea(db, run.id, { title: 'Ok' });
      const ok2 = await insertIdea(db, run.id, { title: 'Ok2' });
      const logs: string[] = [];
      const router = fakeRouter({ structured: { screen: [scores(5), scores(5), scores(5), scores(3), scores(2)] } });
      const out = await screen(deps(db, router, (m: string) => logs.push(m)), run, { ideaIds: [none, unsourced, small, ok, ok2].map((i) => i.id) });
      expect(out.ideaIds).toEqual([ok.id, ok2.id]);
      for (const i of [none, unsourced, small]) expect((await getIdea(db, i.id)).status).toBe('screened_out');
      expect(logs.some((l) => l.includes('"No estimate"') && l.includes('buyer floor: no estimate'))).toBe(true);
      expect(logs.some((l) => l.includes('"Unsourced"') && l.includes('buyer floor') && l.includes('no source'))).toBe(true);
      expect(logs.some((l) => l.includes('"Small"') && l.includes('buyer floor') && l.includes('under the floor'))).toBe(true);
      expect(logs).toContain('screen: 3 of 5 candidates fail the buyer floor (no sourced population, or under 20,000 businesses or 1,000,000 individuals) and cannot advance');
    });

    it('the buyer floor uses the settings and never filters owner ideas', async () => {
      const db = await testDb();
      await setSetting(db, 'gate.minBuyers.businesses', 200_000);
      const run = await insertRun(db, defaultRunConfig({ seedType: 'idea', advanceCount: 1 }));
      const owner = await insertIdea(db, run.id, { origin: 'owner', scaleEstimate: null });
      const below = await insertIdea(db, run.id, { title: 'Below' }); // FLOOR_ESTIMATE: 100,000 businesses
      const out = await screen(deps(db, fakeRouter({ structured: { screen: [scores(3)] } })), run, { ideaIds: [owner.id, below.id] });
      expect(out.ideaIds).toEqual([owner.id]);
      expect((await getIdea(db, below.id)).status).toBe('screened_out');
    });

    it('uses the run minSignals and never filters owner ideas', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'idea', advanceCount: 1, minSignals: 1 }));
      const owner = await insertIdea(db, run.id, { origin: 'owner', signalIds: [] });
      const single = await insertIdea(db, run.id, { signalIds: await sigs(db, [{ voice: 'neutral' }]) });
      const out = await screen(deps(db, fakeRouter({ structured: { screen: [scores(3)] } })), run, { ideaIds: [owner.id, single.id] });
      expect(out.ideaIds).toEqual([owner.id, single.id]);
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
    expect(screenCalls(router)).toHaveLength(2);
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
      // Scale comes from the floor estimate and the price (computed; pinned in the screen.v6 tests).
      expect((await getIdea(db, poor.id)).screenTotal).toBeCloseTo(total6(scores(4), { moneyCase: 1, barrier: 1, upside: 2, scale: p.scale!.value }));
      expect((await getIdea(db, rich.id)).screenTotal).toBeCloseTo(total6(scores(4), { moneyCase: 5, barrier: 5, upside: 2, scale: r.scale!.value }));
      expect(screenCalls(router)[0]!.prompt).toMatch(/Money case \(computed[^\n]*\): 1 of 5/);
      expect(screenCalls(router)[1]!.prompt).toMatch(/Money case \(computed[^\n]*\): 5 of 5/);
      expect(screenCalls(router)[1]!.prompt).toMatch(/Barrier \(computed[^\n]*\): 5 of 5/);
    });

    it('ads and affiliate ideas: the user pays nothing, so no multiple and the neutral band 3 (not the ad revenue per user)', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 3 }));
      // priceHint here is our revenue per user (ideate.v8): dividing by it would give 120x and band 5.
      const ads = await insertIdea(db, run.id, { businessModel: 'ads', valueToUser: value, priceHint: price(10, 'year') });
      const aff = await insertIdea(db, run.id, { businessModel: 'affiliate' });
      const data = await insertIdea(db, run.id, { businessModel: 'data_sales', valueToUser: value, priceHint: price(100, 'year') }); // client side: 12x
      const logs: string[] = [];
      const router = fakeRouter({ structured: { screen: [scores(3), scores(3), scores(3)] } });
      await screen(deps(db, router, (m: string) => logs.push(m)), run, { ideaIds: [ads.id, aff.id, data.id] });
      for (const i of [ads, aff]) {
        const sc = (await getIdea(db, i.id)).screenScores as Record<string, { value: number; note: string }>;
        expect(sc.moneyCase).toEqual({ value: 3, note: 'no value multiple: user pays nothing (ad/affiliate funded)' });
      }
      expect(((await getIdea(db, data.id)).screenScores as Record<string, { value: number }>).moneyCase!.value).toBe(5);
      expect(screenCalls(router)[0]!.prompt).toMatch(/Money case \(computed[^\n]*user pays nothing[^\n]*\): 3 of 5/);
      expect(logs.some((l) => l.includes('0 of 3') && l.includes('no value multiple'))).toBe(true);
      expect(logs.some((l) => l.includes('2 of 3') && l.includes('user pays nothing'))).toBe(true);
    });

    it('missing money or barrier data scores moneyCase 2 and barrier 3, and the null count is logged', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 2 }));
      const a = await insertIdea(db, run.id);
      const b = await insertIdea(db, run.id, { valueToUser: value, priceHint: price(5, 'per use') }); // cannot annualise
      const logs: string[] = [];
      const router = fakeRouter({ structured: { screen: [scores(3), scores(3)] } });
      await screen(deps(db, router, (m: string) => logs.push(m)), run, { ideaIds: [a.id, b.id] });
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
      const out = await screen(deps(db, router, (m: string) => logs.push(m)), run, { ideaIds: [...subs, ads, ...nulls].map((i) => i.id) });
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

    it('needs no swap when a consumer winner already exists', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 2 }));
      const c = await insertIdea(db, run.id, { audience: 'consumer', businessModel: 'ads' });
      const b = await insertIdea(db, run.id, { audience: 'business', businessModel: 'usage' });
      const c2 = await insertIdea(db, run.id, { audience: 'both', businessModel: 'affiliate' });
      const router = fakeRouter({ structured: { screen: [scores(5), scores(4), scores(3)] } });
      const out = await screen(deps(db, router), run, { ideaIds: [c.id, b.id, c2.id] });
      expect(out.ideaIds).toEqual([c.id, b.id]);
    });

    it('the swap respects the per-model cap: a consumer loser whose model is at the cap is passed over', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 3 }));
      const b1 = await insertIdea(db, run.id, { title: 'B1', audience: 'business', businessModel: 'subscription' });
      const b2 = await insertIdea(db, run.id, { title: 'B2', audience: 'business', businessModel: 'subscription' });
      const b3 = await insertIdea(db, run.id, { title: 'B3', audience: 'business', businessModel: 'usage' });
      const cCapped = await insertIdea(db, run.id, { title: 'C-capped', audience: 'consumer', businessModel: 'subscription' });
      const cOk = await insertIdea(db, run.id, { title: 'C-ok', audience: 'consumer', businessModel: 'ads' });
      const router = fakeRouter({ structured: { screen: [scores(5), scores(5), scores(4), scores(3), scores(2)] } });
      const out = await screen(deps(db, router), run, { ideaIds: [b1, b2, b3, cCapped, cOk].map((i) => i.id) });
      expect(out.ideaIds).toEqual([b1.id, b2.id, cOk.id]);
      expect((await getIdea(db, cCapped.id)).status).toBe('screened_out');
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

  // ---- screen.v5: edge and scale criteria, speed weight 0.5, missing edge or scale scored 2 (spec B5) ----

  describe('screen.v5 edge, kept in screen.v6', () => {
    const withEdgeScale = (v: number, edge: number, scale: number) => ({ ...scores(v), edge: { value: edge, note: 'e' }, scale: { value: scale, note: 's' } });

    it('the identity drops "small", "pilot quickly" and the gendered pronoun', () => {
      const text = loadPrompt('screen').render({ idea: 'x', computed: 'c', edge: '', criteriaList: 'l' });
      expect(text).toContain('an owner who wants a software business with a real edge that can grow; software does most of the work');
      for (const w of ['small', 'he', 'his', 'him']) expect(text).not.toMatch(new RegExp(`\\b${w}\\b`, 'i'));
      expect(text).not.toMatch(/pilot quickly/);
    });

    it('weightedScreenTotal keeps the v5 formula for stored v5 scores (no upside): all weights 1 except speed 0.5, over 10.5', () => {
      const s = { ...withEdgeScale(3, 4, 5), moneyCase: { value: 2, note: '' }, barrier: { value: 3, note: '' } };
      expect(weightedScreenTotal(s as never)).toBeCloseTo((3 * 5 + 1.5 + 3 + 2 + 3 + 4 + 5) / 10.5);
      expect(weightedScreenTotal(s as never)).toBeCloseTo(total5(s));
      const bump = (c: string) =>
        weightedScreenTotal({ ...s, [c]: { value: (s as Vals)[c]!.value + 1, note: '' } } as never) - weightedScreenTotal(s as never);
      expect(bump('speed')).toBeCloseTo(0.5 / 10.5);
      expect(bump('pain')).toBeCloseTo(1 / 10.5);
      expect(bump('edge')).toBeCloseTo(1 / 10.5);
      expect(bump('scale')).toBeCloseTo(1 / 10.5);
    });

    it('asks the model for edge (with its rubric) when the idea states it, but never for scale, even with a Scale line', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 1 }));
      const weak = await insertIdea(db, run.id, { title: 'Weak', edge: EDGE, scale: SCALE });
      const strong = await insertIdea(db, run.id, { title: 'Strong', edge: EDGE, scale: SCALE });
      // A scale in the answer is stripped: scale is computed (an estimate with no price here, so 2).
      const router = fakeRouter({ structured: { screen: [withEdgeScale(3, 1, 5), withEdgeScale(3, 5, 5)] } });
      const out = await screen(deps(db, router), run, { ideaIds: [weak.id, strong.id] });
      expect(out.ideaIds).toEqual([strong.id]);
      const row = await getIdea(db, strong.id);
      expect(row.screenScores).toMatchObject({ edge: { value: 5, note: 'e' }, scale: { value: 2 } });
      expect(row.screenTotal).toBeCloseTo(total6(withEdgeScale(3, 5, 5)));
      const prompt = screenCalls(router)[0]!.prompt;
      expect(prompt).toContain("Edge (the idea's own unverified claim): cost: Half the price of Cass per invoice line");
      const edge = prompt.split('\n').find((l) => l.startsWith('- edge:'))!;
      expect(edge).toMatch(/1: no edge, or the only edge is "uses AI"/);
      expect(edge).toMatch(/"better UX"/);
      expect(edge).toMatch(/3: a modest, credible improvement/);
      expect(edge).toMatch(/5: a large advantage over a named option that a buyer could check/);
      expect(prompt).not.toMatch(/^- scale:/m);
      expect(prompt).not.toMatch(/Edge \(computed/);
      expect(prompt).toMatch(/Scale \(computed[^\n]*the price is unknown[^\n]*\): 2 of 5/);
      expect(prompt).toMatch(/Return only these criteria: pain, roi, evidence, speed, autonomy, novelty, reach, edge\./);
    });

    it('a model answer missing a requested edge score fails validation', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 1 }));
      const idea = await insertIdea(db, run.id, { edge: EDGE });
      const router = fakeRouter({ structured: { screen: [scores(4)] } });
      await expect(screen(deps(db, router), run, { ideaIds: [idea.id] })).rejects.toBeInstanceOf(StructuredOutputError);
    });

    it('Review Focus 5: an old idea without edge, estimate or value scores edge 2, scale 2 and upside 3 (computed) and still screens', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 1 }));
      const old = await insertIdea(db, run.id, { title: 'Old', edge: null, scale: null, scaleEstimate: null });
      // A stray edge, scale or upside in the answer cannot override the computed scores.
      const router = fakeRouter({ structured: { screen: [{ ...withEdgeScale(4, 5, 5), upside: { value: 5, note: 'u' } }] } });
      const out = await screen(deps(db, router), run, { ideaIds: [old.id] });
      // Scored, but with no estimate it cannot clear the buyer floor, so it does not advance.
      expect(out.ideaIds).toEqual([]);
      const row = await getIdea(db, old.id);
      expect(row.screenScores).toMatchObject({ edge: { value: 2 }, scale: { value: 2 }, upside: { value: 3 } });
      expect(row.screenTotal).toBeCloseTo(total6(scores(4)));
      const prompt = screenCalls(router)[0]!.prompt;
      expect(prompt).not.toMatch(/^- edge:/m);
      expect(prompt).not.toMatch(/^- scale:/m);
      expect(prompt).not.toMatch(/^- upside:/m);
      expect(prompt).toMatch(/Edge \(computed[^\n]*no edge[^\n]*\): 2 of 5/);
      expect(prompt).toMatch(/Scale \(computed[^\n]*no scale estimate[^\n]*\): 2 of 5/);
      expect(prompt).toMatch(/Upside \(computed[^\n]*\): 3 of 5/);
      expect(prompt).toMatch(/Return only these criteria: pain, roi, evidence, speed, autonomy, novelty, reach\./);
    });

    it('an invalid edge (unknown kind) counts as missing', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 2 }));
      const bad = await insertIdea(db, run.id, { edge: { ...EDGE, kind: 'magic' }, scale: SCALE });
      const router = fakeRouter({ structured: { screen: [{ ...scores(3), scale: { value: 4, note: 's' } }] } });
      await screen(deps(db, router), run, { ideaIds: [bad.id] });
      expect((await getIdea(db, bad.id)).screenScores).toMatchObject({ edge: { value: 2 }, scale: { value: 2 } });
      expect(screenCalls(router)[0]!.prompt).toMatch(/Edge \(computed[^\n]*\): 2 of 5/);
    });
  });

  describe('screen.v6: scale and upside computed in code', () => {
    const result = (band: number, revenueCeiling: number | null, payingBuyers = 3600) => ({
      payingBuyers, annualPrice: revenueCeiling === null ? null : revenueCeiling / payingBuyers, revenueCeiling, band, capped: [], allAssumed: true,
    });
    const value = (kind: 'earn' | 'save' | 'time' | 'risk') => ({ kind, amountPerYear: 5000, basis: 'b' });

    it('is v6 and keeps v5, v4 and v3', () => {
      expect(loadPrompt('screen').version).toBe('screen.v6');
      for (const v of [3, 4, 5]) expect(existsSync(join(__dirname, `../../prompts/screen.v${v}.md`))).toBe(true);
      const text = loadPrompt('screen').render({ idea: 'x', computed: 'c', edge: '', criteriaList: 'l' });
      expect(text).not.toMatch(/^- scale:/m);
    });

    it('weightedScreenTotal v6: the v5 values plus upside, all weights 1 except speed 0.5, over 11.5', () => {
      const s = {
        ...scores(3), moneyCase: { value: 2, note: '' }, barrier: { value: 3, note: '' }, edge: { value: 4, note: '' },
        scale: { value: 5, note: '' }, upside: { value: 1, note: '' },
      };
      expect(weightedScreenTotal(s as never)).toBeCloseTo((3 * 5 + 1.5 + 3 + 2 + 3 + 4 + 5 + 1) / 11.5);
      const bump = (c: string) =>
        weightedScreenTotal({ ...s, [c]: { value: (s as Vals)[c]!.value + 1, note: '' } } as never) - weightedScreenTotal(s as never);
      expect(bump('speed')).toBeCloseTo(0.5 / 11.5);
      for (const c of ['pain', 'novelty', 'edge', 'scale', 'upside', 'moneyCase']) expect(bump(c)).toBeCloseTo(1 / 11.5);
    });

    it('scale is the band from the stored scale result, and upside follows the value kind (earn 5, time 3, risk 3, save 2)', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 4 }));
      const big = await insertIdea(db, run.id, { title: 'Big', scaleResult: result(5, 40_000_000), valueToUser: value('earn') });
      const small = await insertIdea(db, run.id, { title: 'Small', scaleResult: result(1, 90_000), valueToUser: value('save') });
      const time = await insertIdea(db, run.id, { title: 'Time', scaleResult: result(3, 2_000_000), valueToUser: value('time') });
      const risk = await insertIdea(db, run.id, { title: 'Risk', scaleResult: result(4, 9_000_000), valueToUser: value('risk') });
      const router = fakeRouter({ structured: { screen: [scores(3), scores(3), scores(3), scores(3)] } });
      await screen(deps(db, router), run, { ideaIds: [small.id, time.id, risk.id, big.id] });
      // A stored result with no estimate cannot clear the buyer floor, so none advances; the totals still rank them.
      const totals = await Promise.all([big, risk, time, small].map(async (i) => (await getIdea(db, i.id)).screenTotal!));
      expect([...totals].sort((a, b) => b - a)).toEqual(totals);
      expect(new Set(totals).size).toBe(4);
      const got = async (id: string) => (await getIdea(db, id)).screenScores as Record<string, { value: number; note: string }>;
      expect([(await got(big.id)).scale!.value, (await got(big.id)).upside!.value]).toEqual([5, 5]);
      expect([(await got(small.id)).scale!.value, (await got(small.id)).upside!.value]).toEqual([1, 2]);
      expect([(await got(time.id)).scale!.value, (await got(time.id)).upside!.value]).toEqual([3, 3]);
      expect([(await got(risk.id)).scale!.value, (await got(risk.id)).upside!.value]).toEqual([4, 3]);
      expect((await got(big.id)).scale!.note).toContain('$40,000,000');
      expect((await got(big.id)).upside!.note).toContain('earn');
      expect((await getIdea(db, big.id)).screenTotal).toBeCloseTo(total6(scores(3), { scale: 5, upside: 5 }));
      const bigPrompt = screenCalls(router)[3]!.prompt;
      expect(bigPrompt).toMatch(/Scale \(computed[^\n]*revenue ceiling \$40,000,000[^\n]*\): 5 of 5/);
      expect(bigPrompt).toMatch(/Upside \(computed[^\n]*earn[^\n]*\): 5 of 5/);
      expect(bigPrompt).not.toMatch(/^- scale:/m);
    });

    it('Review Focus 1: an unknown price (null ceiling, band 2) scores scale 2 and says the price is unknown', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 1 }));
      const idea = await insertIdea(db, run.id, { scaleResult: result(2, null) });
      const router = fakeRouter({ structured: { screen: [scores(3)] } });
      await screen(deps(db, router), run, { ideaIds: [idea.id] });
      const sc = (await getIdea(db, idea.id)).screenScores as Record<string, { value: number; note: string }>;
      expect(sc.scale!.value).toBe(2);
      expect(sc.scale!.note).toMatch(/price/);
    });

    it('scores the band recomputed from a valid estimate (as the gate does), not a stale stored result', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 1 }));
      const estimate = {
        buyerUnit: 'businesses',
        population: { count: 200_000, basis: 'b', source: 'https://census.example' },
        shareWithProblem: { pct: 50, basis: 'b', source: 'https://s.example' },
        shareWillingToPay: { pct: 10, basis: 'b', source: 'https://s.example' },
        shareReachable: { pct: 20, basis: 'b' },
      };
      // 2,000 buyers x $1,200 = $2,400,000: band 3, whatever the stored result says
      const idea = await insertIdea(db, run.id, {
        scaleEstimate: estimate as never, scaleResult: result(5, 40_000_000), priceHint: { amount: 100, unit: 'month', basis: 'b' },
      });
      const router = fakeRouter({ structured: { screen: [scores(3)] } });
      await screen(deps(db, router), run, { ideaIds: [idea.id] });
      const sc = (await getIdea(db, idea.id)).screenScores as Record<string, { value: number; note: string }>;
      expect(sc.scale!.value).toBe(3);
      expect(sc.scale!.note).toContain('$2,400,000');
    });

    it('a malformed stored scale result counts as missing (scale 2); an unknown value kind is upside 3', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 1 }));
      const idea = await insertIdea(db, run.id, { scaleResult: { band: 9, revenueCeiling: 'lots' }, valueToUser: { kind: 'fame', amountPerYear: 1, basis: 'b' } as never });
      const router = fakeRouter({ structured: { screen: [scores(3)] } });
      await screen(deps(db, router), run, { ideaIds: [idea.id] });
      const sc = (await getIdea(db, idea.id)).screenScores as Record<string, { value: number }>;
      expect([sc.scale!.value, sc.upside!.value]).toEqual([2, 3]);
    });
  });

  describe('pre-gate evidence filter follows the gate rule: 3 complaint units, or 1 signal plus a demand source', () => {
    async function trendItem(db: TestDb) {
      const [row] = await db.insert(knowledgeItems).values({
        kind: 'trend', title: 'Trend', summary: 'S', audience: 'business', countries: ['US'], industries: [], facts: {}, contentHash: `trend${++sigSeq}`,
      }).returning({ id: knowledgeItems.id });
      return row!.id;
    }

    it('an idea with 1 operator pain signal and a cited trend passes the pre-check and reaches the gate; 1 signal alone is skipped', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 2 }));
      const demand = await insertIdea(db, run.id, { title: 'Demand', signalIds: await sigs(db, [{ voice: 'operator' }]), libraryItemIds: [await trendItem(db)] });
      const alone = await insertIdea(db, run.id, { title: 'Alone', signalIds: await sigs(db, [{ voice: 'operator' }]) });
      const logs: string[] = [];
      const out = await screen(deps(db, fakeRouter({ structured: { screen: [scores(3), scores(5)] } }), (m: string) => logs.push(m)), run, { ideaIds: [demand.id, alone.id] });
      expect(out.ideaIds).toEqual([demand.id]);
      expect((await getIdea(db, alone.id)).status).toBe('screened_out');
      expect(logs.some((l) => l.includes('"Alone"') && l.includes('1 independent sources') && l.includes('no demand source'))).toBe(true);
      expect(logs).toContain('screen: 1 of 2 candidates have too little evidence for the gate (fewer than 3 independent sources and no demand source) and cannot advance');
      // The gate's evidence rule agrees (the idea clears the buyer floor).
      await db.update(ideas).set({ scaleEstimate: FLOOR_ESTIMATE }).where(eq(ideas.id, demand.id));
      const research = { text: 'r', sources: [] };
      const verdicts = { verdicts: ['generic', 'regulation', 'control', 'autonomy', 'reachability', 'trivial'].map((check) => ({ check, pass: true, reasoning: 'ok', sourceUrls: [] })) };
      const gated = await gate(deps(db, fakeRouter({ research: { competitors: [research] }, structured: { gate: [verdicts] } })), run, { ideaIds: out.ideaIds });
      expect(gated.passed).toEqual([demand.id]);
    });

    it('the demand route needs a complaint: an opportunity plus a trend, or two opportunities, are skipped with no valid evidence route', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 3 }));
      const oppTrend = await insertIdea(db, run.id, { title: 'Opp+trend', signalIds: await sigs(db, [{ voice: 'operator', kind: 'opportunity' }]), libraryItemIds: [await trendItem(db)] });
      const twoOpp = await insertIdea(db, run.id, { title: 'Two opps', signalIds: await sigs(db, [{ voice: 'operator', kind: 'opportunity' }, { voice: 'neutral', kind: 'opportunity' }]) });
      const logs: string[] = [];
      const out = await screen(deps(db, fakeRouter({ structured: { screen: [scores(4), scores(4)] } }), (m: string) => logs.push(m)), run, { ideaIds: [oppTrend.id, twoOpp.id] });
      expect(out.ideaIds).toEqual([]);
      for (const t of ['"Opp+trend"', '"Two opps"']) {
        expect(logs.some((l) => l.includes(t) && l.includes('no valid evidence route') && !l.includes('no demand source'))).toBe(true);
      }
    });

    it('an opportunity signal alone never meets the complaint route (minSignals 1), nor does one on the same domain as the only pain signal', async () => {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 3, minSignals: 1 }));
      const opp = await insertIdea(db, run.id, { title: 'Opp', signalIds: await sigs(db, [{ voice: 'operator', kind: 'opportunity' }]) });
      const run3 = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 3 }));
      const same = await insertIdea(db, run3.id, { title: 'Same', signalIds: await sigs(db, [{ voice: 'operator', domain: 'a.test' }, { voice: 'neutral', domain: 'www.a.test', kind: 'opportunity' }]) });
      const other = await insertIdea(db, run3.id, { title: 'Other', signalIds: await sigs(db, [{ voice: 'operator', domain: 'a.test' }, { voice: 'neutral', domain: 'b.test', kind: 'opportunity' }]) });
      expect((await screen(deps(db, fakeRouter({ structured: { screen: [scores(3)] } })), run, { ideaIds: [opp.id] })).ideaIds).toEqual([]);
      expect((await screen(deps(db, fakeRouter({ structured: { screen: [scores(3), scores(3)] } })), run3, { ideaIds: [same.id, other.id] })).ideaIds).toEqual([other.id]);
    });
  });
});

// ---- engine v2: the reviewer's score total ranks the screen (judge fallback); the tournament Elo only breaks ties ----
const reasons = { scale: 's', edge: 'e', novelty: 'n', niche: 'c' };
const idsIn = (prompt: string) => [...prompt.matchAll(/^Id: ([0-9a-f-]{36})$/gm)].map((m) => m[1]!);
/** A router for screen scores (a queue) and review calls: `total(id)` gives an idea's review total (4 criteria, 1-5 each), null leaves it out. */
function reviewRouter(screenScores: unknown[], total: (id: string) => number | null, failReview = false) {
  const base = fakeRouter({ structured: { screen: screenScores } });
  const reviewPrompts: string[] = [];
  const reviewMetas: unknown[] = [];
  return Object.assign(Object.create(base) as typeof base, {
    reviewPrompts, reviewMetas,
    async structured(stage: string, req: { prompt: string; schema: { parse: (v: unknown) => unknown } }, meta: unknown) {
      if (stage !== 'review') return (base.structured as (...a: unknown[]) => unknown)(stage, req, meta);
      reviewPrompts.push(req.prompt);
      reviewMetas.push(meta);
      if (failReview) throw new StructuredOutputError('review: still invalid', 'bad');
      const reviews = idsIn(req.prompt).flatMap((ideaId) => {
        const t = total(ideaId);
        if (t === null) return [];
        const [base, rem] = [Math.floor(t / 4), t % 4];
        const [scale, edge, novelty, niche] = [0, 1, 2, 3].map((k) => base + (k < rem ? 1 : 0));
        return [{ ideaId, scale, edge, novelty, niche, reasons }];
      });
      return req.schema.parse({ reviews });
    },
  }) as unknown as typeof base & { reviewPrompts: string[]; reviewMetas: unknown[] };
}

describe('reviewBand', () => {
  it('top quartile 3, second 2, third 1, else 0; a null total gives 0; ties share the better band', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => 20 - i);
    expect(twelve.map((t) => reviewBand(t, twelve))).toEqual([3, 3, 3, 2, 2, 2, 1, 1, 1, 0, 0, 0]);
    expect(reviewBand(null, twelve)).toBe(0);
    expect(reviewBand(10, [])).toBe(0);
    expect(reviewBand(10, [10, null, 8, null])).toBe(3);
    expect([16, 16, 12, 8].map((t, _i, all) => reviewBand(t, all))).toEqual([3, 3, 1, 0]);
  });
});

describe('engine v2 screen ranks by review band', () => {
  it('calls review once per batch of 10, for the unreviewed ideas only', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 1 }));
    const made = [];
    for (let i = 0; i < 12; i++) made.push(await insertIdea(db, run.id, { title: `I${i}` }));
    const router = reviewRouter(made.map(() => scores(3)), () => 12);
    await screen(deps(db, router), run, { ideaIds: made.map((m) => m.id) });
    expect(router.reviewPrompts).toHaveLength(2);
    expect(idsIn(router.reviewPrompts[0]!)).toHaveLength(10);
    expect(idsIn(router.reviewPrompts[1]!)).toHaveLength(2);
    expect(router.reviewMetas).toEqual([{ runId: run.id, promptVersion: 'idea-review.v2' }, { runId: run.id, promptVersion: 'idea-review.v2' }]);
  });

  it('a resumed screen does not re-review ideas that already have reviews', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 1 }));
    const [a, b] = [await insertIdea(db, run.id), await insertIdea(db, run.id)];
    const first = reviewRouter([scores(3), scores(3)], () => 12);
    await screen(deps(db, first), run, { ideaIds: [a.id, b.id] });
    expect(first.reviewPrompts).toHaveLength(1);
    const again = reviewRouter([scores(3), scores(3)], () => 12);
    await screen(deps(db, again), run, { ideaIds: [a.id, b.id] });
    expect(again.reviewPrompts).toHaveLength(0);
    const c = await insertIdea(db, run.id);
    const third = reviewRouter([scores(3), scores(3), scores(3)], () => 12);
    await screen(deps(db, third), run, { ideaIds: [a.id, b.id, c.id] });
    expect(third.reviewPrompts).toHaveLength(1);
    expect(idsIn(third.reviewPrompts[0]!)).toEqual([c.id]);
  });

  it('a high-review idea outranks a high-Elo idea with an otherwise equal total, and Elo is not added', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 1 }));
    const eloTop = await insertIdea(db, run.id, { title: 'Elo top', elo: 1400 });
    const reviewTop = await insertIdea(db, run.id, { title: 'Review top', elo: 1000 });
    const router = reviewRouter([scores(3), scores(3)], (id) => (id === reviewTop.id ? 18 : 8));
    const out = await screen(deps(db, router), run, { ideaIds: [eloTop.id, reviewTop.id] });
    expect(out.ideaIds).toEqual([reviewTop.id]);
    // Two ideas: the reviewed 18 is in the top half (band 3), the 8 is in the bottom half (band 1).
    expect((await getIdea(db, reviewTop.id)).screenTotal).toBeCloseTo(total6(scores(3)) + 3);
    expect((await getIdea(db, eloTop.id)).screenTotal).toBeCloseTo(total6(scores(3)) + 1);
  });

  it('Elo breaks ties between equal totals', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 1 }));
    const low = await insertIdea(db, run.id, { title: 'Low Elo', elo: 1100 });
    const high = await insertIdea(db, run.id, { title: 'High Elo', elo: 1300 });
    const router = reviewRouter([scores(3), scores(3)], () => 12);
    const out = await screen(deps(db, router), run, { ideaIds: [low.id, high.id] });
    expect(out.ideaIds).toEqual([high.id]);
    expect((await getIdea(db, high.id)).screenTotal).toBeCloseTo(total6(scores(3)) + 3);
    expect((await getIdea(db, low.id)).screenTotal).toBeCloseTo(total6(scores(3)) + 3);
  });

  it('a review failure leaves the band at 0 and the screen still advances ideas', async () => {
    const db = await testDb();
    const logs: string[] = [];
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 1 }));
    const [a, b] = [await insertIdea(db, run.id), await insertIdea(db, run.id)];
    const router = reviewRouter([scores(3), scores(4)], () => 12, true);
    const out = await screen(deps(db, router, (m: string) => logs.push(m)), run, { ideaIds: [a.id, b.id] });
    expect(out.ideaIds).toEqual([b.id]);
    expect((await getIdea(db, b.id)).screenTotal).toBeCloseTo(total6(scores(4)));
    expect(logs.filter((l) => l.startsWith('review:'))).toHaveLength(1);
    expect(logs).toContain('screen: 2 of 2 ideas ranked without a review');
  });

  it('a provider error is also survived, and a non-provider error rejects', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 1 }));
    const [a, b] = [await insertIdea(db, run.id), await insertIdea(db, run.id)];
    const down = reviewRouter([scores(3)], () => 12);
    let reviewCalls = 0;
    down.structured = (async (stage: string) => {
      if (stage === 'review') { reviewCalls++; throw new Anthropic.APIError(529, { type: 'error' }, 'overloaded', undefined); }
      return scores(3);
    }) as typeof down.structured;
    const out = await screen(deps(db, down), run, { ideaIds: [a.id, b.id] });
    expect(reviewCalls).toBeGreaterThan(0);
    expect(out.ideaIds).toEqual([a.id]);
    const bug = reviewRouter([scores(3)], () => 12);
    bug.structured = (async (stage: string) => { if (stage === 'review') throw new Error('insert into "llm_calls" failed'); return scores(3); }) as typeof bug.structured;
    await expect(screen(deps(db, bug), run, { ideaIds: [a.id, b.id] })).rejects.toThrow('llm_calls');
  });

  it('skips the review when there are no more generated ideas than advanceCount (all may advance)', async () => {
    const db = await testDb();
    const logs: string[] = [];
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 2 }));
    const [a, b] = [await insertIdea(db, run.id), await insertIdea(db, run.id)];
    const router = reviewRouter([scores(3), scores(4)], () => 12);
    const out = await screen(deps(db, router, (m: string) => logs.push(m)), run, { ideaIds: [a.id, b.id] });
    expect(router.reviewPrompts).toHaveLength(0);
    expect(out.ideaIds).toEqual([b.id, a.id]);
    expect((await getIdea(db, b.id)).screenTotal).toBeCloseTo(total6(scores(4)));
    expect(logs).toContain('screen: 2 generated ideas for 2 places, so no review (all may advance)');
    expect(logs.some((l) => l.includes('ranked without a review'))).toBe(false);
    // One more idea than places: the review runs.
    const c = await insertIdea(db, run.id);
    const more = reviewRouter([scores(3), scores(4), scores(2)], () => 12);
    await screen(deps(db, more), run, { ideaIds: [a.id, b.id, c.id] });
    expect(more.reviewPrompts).toHaveLength(1);
  });

  it('a v1 screen makes no review call and keeps its plain total', async () => {
    const db = await testDb();
    const run = await insertRun(db, { ...defaultRunConfig({ seedType: 'open', advanceCount: 2 }), engine: 'v1' });
    const [a, b] = [await insertIdea(db, run.id, { elo: 1300 }), await insertIdea(db, run.id, { elo: 1100 })];
    const router = reviewRouter([scores(3), scores(4)], () => 20);
    const out = await screen(deps(db, router), run, { ideaIds: [a.id, b.id] });
    expect(router.reviewPrompts).toHaveLength(0);
    expect(out.ideaIds).toEqual([b.id, a.id]);
    expect((await getIdea(db, a.id)).screenTotal).toBeCloseTo(total6(scores(3)));
  });
});
