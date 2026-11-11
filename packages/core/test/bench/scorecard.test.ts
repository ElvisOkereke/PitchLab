import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '../../src/db/client';
import type { CaseSections } from '../../src/case/schema';
import { cases, dataCalls, gateVerdicts, ideaReviews, knowledgeItems, llmCalls, runStages, runs, scores, settings, signals } from '../../src/db/schema';
import { IDEA_REVIEW_VERSION, METRIC_DEFS, type MetricId } from '../../src/bench/definitions';
import { computeScorecard, type MetricResult, type Scorecard } from '../../src/bench/scorecard';
import { ensureExample } from '../../src/example/example';
import { defaultRunConfig } from '../../src/pipeline/types';
import { insertCase, insertIdea, insertRun, testDb, unit } from '../helpers/db';

const newRun = async (db: Db, createdAt?: Date) => {
  const r = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
  if (createdAt) await db.update(runs).set({ createdAt }).where(eq(runs.id, r.id));
  return r.id;
};

const metric = (sc: Scorecard, id: MetricId): MetricResult => {
  const m = sc.metrics.find((x) => x.id === id);
  if (!m) throw new Error(`missing metric ${id}`);
  return m;
};

const numbers = (roiMultiple: number | null, grossMarginPct: number | null) =>
  ({ numbers: { results: { buyer: { roiMultiple }, unit: { grossMarginPct } } } }) as unknown as CaseSections;

const caseWith = async (db: Db, runId: string, roi: number | null, gm: number | null) =>
  insertCase(db, (await insertIdea(db, runId)).id, { sections: numbers(roi, gm) });

let sig = 0;
const signal = async (db: Db, voice: 'operator' | 'neutral' | 'vendor' | null) => {
  sig += 1;
  const [row] = await db.insert(signals).values({
    marketId: 'ca-us', source: 'web', url: `https://s.example/${sig}`, title: 't', quote: 'q', quoteHash: `h${sig}`, voice,
  }).returning({ id: signals.id });
  return row!.id;
};

const MEASURED: MetricId[] = ['repetition', 'nearDuplicates', 'buyerVariety', 'consumerShare', 'modelVariety', 'realNeed', 'demandEvidence', 'customerReturn', 'margin', 'wastedEntrants', 'easyStartHardCopy', 'ownerVerdict', 'ownerLikes', 'ownerKeeps', 'medianEdge', 'medianScale', 'nicheShare', 'reviewerAgreement', 'costPerCase', 'uniqueSketchShare', 'cellsFilled', 'judgeAccuracy', 'trivialKillRate', 'compsCoverage', 'engineCostPerRun'];

describe('computeScorecard: similarity', () => {
  it('repetition and near-duplicates use generated ideas with embeddings only', async () => {
    const db = await testDb();
    const r = await newRun(db);
    await insertIdea(db, r, { embedding: unit(1), status: 'advanced' });
    await insertIdea(db, r, { embedding: unit(1), status: 'duplicate' });
    await insertIdea(db, r, { embedding: unit(2), status: 'screened_out' });
    await insertIdea(db, r); // no embedding: skipped
    await insertIdea(db, r, { origin: 'owner', embedding: unit(2) }); // owner idea: not in G
    const sc = await computeScorecard(db, [r]);
    const rep = metric(sc, 'repetition');
    expect(rep.status).toBe('measured');
    expect(rep.value).toBeCloseTo(2 / 3, 6);
    expect(rep.display).toBe('0.67');
    expect(rep.meets).toBe(false);
    const nd = metric(sc, 'nearDuplicates');
    expect(nd.value).toBeCloseTo(2 / 3, 6);
    expect(nd.display).toBe('67% (2 of 3)');
    expect(nd.meets).toBe(false);
    expect(sc.extra.ideas).toBe(4);
  });

  it('distinct ideas meet both targets; a single embedded idea is no_data', async () => {
    const db = await testDb();
    const r = await newRun(db);
    for (const i of [1, 2, 3]) await insertIdea(db, r, { embedding: unit(i) });
    const sc = await computeScorecard(db, [r]);
    expect(metric(sc, 'repetition')).toMatchObject({ value: 0, display: '0.00', meets: true, status: 'measured' });
    expect(metric(sc, 'nearDuplicates')).toMatchObject({ value: 0, meets: true, status: 'measured' });

    const lone = await newRun(db);
    await insertIdea(db, lone, { embedding: unit(4) });
    const sc2 = await computeScorecard(db, [lone]);
    expect(metric(sc2, 'repetition')).toMatchObject({ value: null, meets: null, status: 'no_data' });
    expect(metric(sc2, 'repetition').note).toBeTruthy();
    expect(metric(sc2, 'nearDuplicates').status).toBe('no_data');
  });

  it('newVsHistory compares only with generated ideas in real runs created before the set', async () => {
    const db = await testDb();
    const h = await newRun(db, new Date('2026-01-01T00:00:00Z'));
    await insertIdea(db, h, { embedding: unit(1) });
    await insertIdea(db, h, { origin: 'owner', embedding: unit(2) }); // owner: not history
    const s = await newRun(db, new Date('2026-02-01T00:00:00Z'));
    await insertIdea(db, s, { embedding: unit(1) });
    await insertIdea(db, s, { embedding: unit(2) });
    const sc = await computeScorecard(db, [s]);
    expect(sc.extra.newVsHistory).toBeCloseTo(0.5, 6);
    // With h inside the set there is no earlier history left.
    expect((await computeScorecard(db, [s, h])).extra.newVsHistory).toBeNull();
  });

  it('newVsHistory ignores runs created after the set and example runs', async () => {
    const db = await testDb();
    const s = await newRun(db, new Date('2026-02-01T00:00:00Z'));
    await insertIdea(db, s, { embedding: unit(1) });
    await insertIdea(db, s, { embedding: unit(2) });
    const later = await newRun(db, new Date('2026-03-01T00:00:00Z'));
    await insertIdea(db, later, { embedding: unit(1) });
    const ex = await newRun(db, new Date('2026-01-01T00:00:00Z'));
    await db.update(runs).set({ isExample: true }).where(eq(runs.id, ex));
    await insertIdea(db, ex, { embedding: unit(1) });
    expect((await computeScorecard(db, [s])).extra.newVsHistory).toBeNull();
  });

  it('display never rounds across a target or up to 100%', async () => {
    const { pctText } = await import('../../src/bench/scorecard');
    expect(pctText(199, 200, (v) => v === 1)).toBe('99.5%');
    expect(pctText(200, 200, (v) => v === 1)).toBe('100%');
    expect(pctText(1999, 2000, (v) => v === 1)).toBe('99.9%');
    expect(pctText(296, 1000, (v) => v < 0.3)).toBe('29.6%');
    expect(pctText(1, 1000, () => null as unknown as boolean)).toBe('0.1%');
    expect(pctText(2, 4, (v) => v >= 0.5)).toBe('50%');
    expect(pctText(1, 3, (v) => v < 0.3)).toBe('33%');
  });

  it('bounds runs and similarity ideas to the newest and says so', async () => {
    const db = await testDb();
    const old = await newRun(db, new Date('2026-01-01T00:00:00Z'));
    const mid = await newRun(db, new Date('2026-02-01T00:00:00Z'));
    const recent = await newRun(db, new Date('2026-03-01T00:00:00Z'));
    await insertIdea(db, old, { embedding: unit(9) });
    await insertIdea(db, mid, { embedding: unit(1), createdAt: new Date('2026-02-01T00:00:00Z') });
    await insertIdea(db, recent, { embedding: unit(1), createdAt: new Date('2026-03-01T00:00:00Z') });
    await insertIdea(db, recent, { embedding: unit(2), createdAt: new Date('2026-03-02T00:00:00Z') });
    const sc = await computeScorecard(db, [old, mid, recent], { runsMax: 2 });
    expect(sc.extra.runs).toBe(2);
    expect(sc.extra.ideas).toBe(3);
    expect(sc.notes).toContain('Used the newest 2 of 3 runs.');

    const sc2 = await computeScorecard(db, [mid, recent], { similarityIdeasMax: 2 });
    // Newest two embedded ideas are unit(2) and the recent unit(1): orthogonal.
    expect(metric(sc2, 'repetition').value).toBe(0);
    expect(sc2.notes).toContain('Similarity used the newest 2 of 3 ideas with embeddings.');
  });
});

describe('computeScorecard: variety and evidence', () => {
  it('buyer variety normalises, averages per run and skips runs with no buyer types', async () => {
    const db = await testDb();
    const a = await newRun(db);
    for (const b of ['Property Managers', ' property   manager ', 'Dentists', null]) await insertIdea(db, a, { buyerType: b });
    const b = await newRun(db);
    for (const t of ['Restaurant', 'restaurants', 'Clinic', 'Gym', 'Law Firm']) await insertIdea(db, b, { buyerType: t });
    const c = await newRun(db);
    await insertIdea(db, c, { buyerType: null });
    await insertIdea(db, c, { buyerType: null });
    const sc = await computeScorecard(db, [a, b, c]);
    expect(metric(sc, 'buyerVariety')).toMatchObject({ value: 3, display: '3.0 per run', meets: false, status: 'measured' });

    const sc2 = await computeScorecard(db, [c]);
    expect(metric(sc2, 'buyerVariety')).toMatchObject({ value: null, meets: null, status: 'no_data' });
  });

  it('real need is the share of distinct cited signals in operator or neutral voice; untagged counts as no', async () => {
    const db = await testDb();
    const r = await newRun(db);
    const s1 = await signal(db, 'operator');
    const s2 = await signal(db, 'neutral');
    const s3 = await signal(db, 'vendor');
    const s4 = await signal(db, null);
    const s5 = await signal(db, 'operator');
    await insertIdea(db, r, { signalIds: [s1, s2] });
    await insertIdea(db, r, { signalIds: [s1, s3, s4], status: 'gated_out' });
    await insertIdea(db, r, { origin: 'owner', signalIds: [s5] });
    const sc = await computeScorecard(db, [r]);
    expect(metric(sc, 'realNeed')).toMatchObject({ value: 0.5, display: '50% (2 of 4)', meets: true, status: 'measured' });
  });
});

describe('computeScorecard: cases', () => {
  it('customer return and margin count null numbers as fails and leave them out of the median', async () => {
    const db = await testDb();
    const r = await newRun(db);
    await caseWith(db, r, 4, 70);
    await caseWith(db, r, 2, 60);
    await caseWith(db, r, null, null);
    await caseWith(db, r, 3, 59.9);
    const sc = await computeScorecard(db, [r]);
    expect(metric(sc, 'customerReturn')).toMatchObject({ value: 0.5, display: '50% (2 of 4), median 3.00×', meets: false, status: 'measured' });
    expect(metric(sc, 'margin')).toMatchObject({ value: 0.5, display: '50% (2 of 4)', meets: false, status: 'measured' });
    expect(sc.extra.medianRoi).toBe(3);
    expect(sc.extra.cases).toBe(4);
  });

  it('all cases meeting the bars meet both targets; even-count median is the mean of the middle two', async () => {
    const db = await testDb();
    const r = await newRun(db);
    await caseWith(db, r, 3, 60);
    await caseWith(db, r, 5, 80);
    const sc = await computeScorecard(db, [r]);
    expect(metric(sc, 'customerReturn').meets).toBe(true);
    expect(metric(sc, 'margin').meets).toBe(true);
    expect(sc.extra.medianRoi).toBe(4);
  });

  it('wasted entrants: each idea once; advanced ideas and owner ideas are not wasted', async () => {
    const db = await testDb();
    const r = await newRun(db);
    const v = (ideaId: string, check: 'generic' | 'autonomy' | 'regulation', pass: boolean) =>
      ({ ideaId, check, pass, reasoning: 'r', model: 'm', promptVersion: 'p' });
    const a = await insertIdea(db, r, { status: 'gated_out' });
    const b = await insertIdea(db, r, { status: 'advanced' });
    const c = await insertIdea(db, r, { status: 'gated_out' });
    await insertIdea(db, r, { status: 'screened_out' }); // no verdicts: not an entrant
    const e = await insertIdea(db, r, { status: 'gated_out', origin: 'owner' });
    await db.insert(gateVerdicts).values([
      v(a.id, 'generic', false), v(a.id, 'autonomy', false),
      v(b.id, 'generic', false),
      v(c.id, 'regulation', false), v(c.id, 'generic', true),
      v(e.id, 'generic', false),
    ]);
    const sc = await computeScorecard(db, [r]);
    const w = metric(sc, 'wastedEntrants');
    expect(w.value).toBeCloseTo(1 / 3, 6);
    expect(w).toMatchObject({ display: '33% (1 of 3)', meets: false, status: 'measured' });
  });

  it('owner verdict uses only the latest owner gut row per case', async () => {
    const db = await testDb();
    const r = await newRun(db);
    const c1 = await caseWith(db, r, 1, 1);
    const c2 = await caseWith(db, r, 1, 1);
    const c3 = await caseWith(db, r, 1, 1);
    const s = (caseId: string, criterion: 'gut' | 'pain', value: number, by: 'ai' | 'owner', at: string) =>
      ({ caseId, criterion, value, note: '', by, createdAt: new Date(at) });
    await db.insert(scores).values([
      s(c1.id, 'gut', 1, 'owner', '2026-10-01T00:00:00Z'),
      s(c1.id, 'gut', 5, 'owner', '2026-10-02T00:00:00Z'),
      s(c1.id, 'gut', 1, 'ai', '2026-10-03T00:00:00Z'),
      s(c2.id, 'gut', 3, 'owner', '2026-10-01T00:00:00Z'),
      s(c3.id, 'pain', 2, 'owner', '2026-10-01T00:00:00Z'),
    ]);
    const sc = await computeScorecard(db, [r]);
    expect(metric(sc, 'ownerVerdict')).toMatchObject({ value: 4, display: '4.0 (2 of 3 scored)', meets: false, status: 'measured' });
    expect(sc.extra.scoredCases).toBe(2);

    await db.insert(scores).values(s(c3.id, 'gut', 4, 'owner', '2026-10-04T00:00:00Z'));
    expect(metric(await computeScorecard(db, [r]), 'ownerVerdict')).toMatchObject({ value: 4, display: '4.0 (3 of 3 scored)', meets: true });
  });

  it('owner verdict breaks a created_at tie by the larger score id', async () => {
    const db = await testDb();
    const r = await newRun(db);
    const c = await caseWith(db, r, 1, 1);
    const at = new Date('2026-10-01T00:00:00Z');
    const rows = await db.insert(scores).values([1, 5].map((value) => ({ caseId: c.id, criterion: 'gut' as const, value, note: '', by: 'owner' as const, createdAt: at }))).returning();
    const winner = rows.reduce((a, b) => (a.id > b.id ? a : b));
    expect(metric(await computeScorecard(db, [r]), 'ownerVerdict').value).toBe(winner.value);
  });

  it('owner verdict with no gut scores is no_data "no scores yet"', async () => {
    const db = await testDb();
    const r = await newRun(db);
    await caseWith(db, r, 1, 1);
    const sc = await computeScorecard(db, [r]);
    expect(metric(sc, 'ownerVerdict')).toMatchObject({ value: null, display: 'no scores yet', meets: null, status: 'no_data' });
  });

  it('owner likes: share of rated (non-zero) generated ideas rated 1, with top tags; no_data when none rated', async () => {
    const db = await testDb();
    const r = await newRun(db);
    await insertIdea(db, r);
    expect(metric(await computeScorecard(db, [r]), 'ownerLikes')).toMatchObject({ value: null, meets: null, status: 'no_data' });
    await insertIdea(db, r, { ownerRating: 1, ownerTags: ['love it', 'would build'] });
    await insertIdea(db, r, { ownerRating: 1, ownerTags: ['love it'] });
    await insertIdea(db, r, { ownerRating: -1, ownerTags: ['too niche', 'boring'] });
    await insertIdea(db, r, { ownerRating: 0, ownerTags: ['boring'] }); // neutral: not in the share
    await insertIdea(db, r, { origin: 'owner', ownerRating: -1 }); // owner idea: left out
    const m = metric(await computeScorecard(db, [r]), 'ownerLikes');
    expect(m.status).toBe('measured');
    expect(m.value).toBeCloseTo(2 / 3, 6);
    expect(m.meets).toBe(true);
    expect(m.display).toBe('67% (2 of 3) · top tags: boring ×2, love it ×2, too niche ×1');
  });

  it('owner likes meets at exactly 0.5 and misses below', async () => {
    const db = await testDb();
    const r = await newRun(db);
    await insertIdea(db, r, { ownerRating: 1 });
    await insertIdea(db, r, { ownerRating: -1 });
    expect(metric(await computeScorecard(db, [r]), 'ownerLikes')).toMatchObject({ value: 0.5, meets: true, display: '50% (1 of 2)' });
    await insertIdea(db, r, { ownerRating: -1 });
    expect(metric(await computeScorecard(db, [r]), 'ownerLikes').meets).toBe(false);
  });

  it('owner keeps: kept (validating, pilot, live) of decided cases (stage not new); current stage counts; no_data when none decided', async () => {
    const db = await testDb();
    const r = await newRun(db);
    const stageCase = async (stage: 'new' | 'validating' | 'pilot' | 'live' | 'killed', runId = r) =>
      insertCase(db, (await insertIdea(db, runId)).id, { stage });
    await stageCase('new');
    expect(metric(await computeScorecard(db, [r]), 'ownerKeeps')).toMatchObject({ value: null, meets: null, status: 'no_data' });
    await stageCase('validating');
    const moved = await stageCase('killed');
    await stageCase('killed');
    const m = metric(await computeScorecard(db, [r]), 'ownerKeeps');
    expect(m).toMatchObject({ status: 'measured', display: 'kept 1 of 3 decided', meets: false });
    expect(m.value).toBeCloseTo(1 / 3, 6);
    // moved back from killed to validating on the Board: the current stage counts as kept
    await db.update(cases).set({ stage: 'validating' }).where(eq(cases.id, moved.id));
    const back = metric(await computeScorecard(db, [r]), 'ownerKeeps');
    expect(back).toMatchObject({ display: 'kept 2 of 3 decided', meets: true });
    expect(back.value).toBeCloseTo(2 / 3, 6);
    await stageCase('pilot');
    await stageCase('live');
    expect(metric(await computeScorecard(db, [r]), 'ownerKeeps').display).toBe('kept 4 of 5 decided');
    // a case in another run, and the example case, are left out
    const other = await newRun(db);
    await stageCase('killed', other);
    await insertCase(db, (await insertIdea(db, r)).id, { stage: 'killed', isExample: true, slug: 'ex-flag' });
    expect(metric(await computeScorecard(db, [r]), 'ownerKeeps').display).toBe('kept 4 of 5 decided');
  });

  it('owner keeps meets at exactly 0.5', async () => {
    const db = await testDb();
    const r = await newRun(db);
    await insertCase(db, (await insertIdea(db, r)).id, { stage: 'live' });
    await insertCase(db, (await insertIdea(db, r)).id, { stage: 'killed' });
    expect(metric(await computeScorecard(db, [r]), 'ownerKeeps')).toMatchObject({ value: 0.5, meets: true, display: 'kept 1 of 2 decided' });
  });

  it('cost per case sums llm and data costs of the set runs only', async () => {
    const db = await testDb();
    const r = await newRun(db);
    const other = await newRun(db);
    await caseWith(db, r, 1, 1);
    await caseWith(db, r, 1, 1);
    const call = (runId: string | null, costUsd: string) => ({
      runId, stage: 's', provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1, searchRequests: 0, costUsd, latencyMs: 1, promptVersion: 'v', ok: true,
    });
    await db.insert(llmCalls).values([call(r, '1.25'), call(r, '0.75'), call(other, '10'), call(null, '3')]);
    await db.insert(dataCalls).values([
      { runId: r, provider: 'p', endpoint: 'e', costUsd: '0.5', ok: true },
      { runId: other, provider: 'p', endpoint: 'e', costUsd: '7', ok: true },
    ]);
    const sc = await computeScorecard(db, [r]);
    expect(metric(sc, 'costPerCase')).toMatchObject({ value: 1.25, display: '$1.25', meets: null, status: 'measured' });

    const empty = await computeScorecard(db, [other]);
    expect(metric(empty, 'costPerCase')).toMatchObject({ value: null, meets: null, status: 'no_data' });
  });
});

describe('computeScorecard: exclusions and empty sets', () => {
  it('passing the example run id changes nothing; example-flagged cases are left out', async () => {
    const db = await testDb();
    const r = await newRun(db);
    await insertIdea(db, r, { embedding: unit(1), buyerType: 'dentist' });
    await insertIdea(db, r, { embedding: unit(2), buyerType: 'gym' });
    await caseWith(db, r, 4, 70);
    const before = await computeScorecard(db, [r]);
    expect(before.extra.cases).toBe(1);

    expect(await ensureExample(db)).toBe('inserted');
    const [ex] = await db.select({ id: runs.id }).from(runs).where(eq(runs.isExample, true));
    expect(await computeScorecard(db, [r, ex!.id])).toEqual(before);
    expect(await computeScorecard(db, [ex!.id])).toEqual(await computeScorecard(db, []));

    // A case flagged is_example on a real run's idea is left out too.
    await insertCase(db, (await insertIdea(db, r)).id, { isExample: true, slug: 'flagged', sections: numbers(1, 1) });
    const after = await computeScorecard(db, [r]);
    expect(after.extra.cases).toBe(1);
    expect(metric(after, 'customerReturn').display).toBe(metric(before, 'customerReturn').display);
  });

  it('an empty set gives no_data or not_measured for every metric and never NaN', async () => {
    const db = await testDb();
    const blankRun = await newRun(db);
    for (const sc of [await computeScorecard(db, []), await computeScorecard(db, [blankRun]), await computeScorecard(db, ['not-a-uuid'])]) {
      expect(sc.metrics.map((m) => m.id)).toEqual(METRIC_DEFS.map((d) => d.id));
      for (const def of METRIC_DEFS) {
        const m = metric(sc, def.id);
        expect(m.value).toBeNull();
        expect(m.meets).toBeNull();
        expect(MEASURED).toContain(def.id);
        expect(m.status).toBe('no_data');
        expect(m.note).toBeTruthy();
      }
      expect(metric(sc, 'ownerVerdict').display).toBe('no scores yet');
      expect(sc.extra).toMatchObject({ ideas: 0, cases: 0, scoredCases: 0, medianRoi: null, newVsHistory: null });
      expect(sc.metrics.some((m) => /NaN|Infinity|undefined/.test(m.display))).toBe(false);
      expect(Object.values(sc.extra).every((x) => x === null || Number.isFinite(x))).toBe(true);
    }
  });
});

const bar = (toStart: number, toCopy: number) => ({ toStart, toStartWhy: 'w', toCopy, toCopyWhy: 'w', soloBuildable: true });
const richCase = async (db: Db, runId: string, buyer: Record<string, unknown>, ideaOver: Partial<Parameters<typeof insertIdea>[2]> = {}) =>
  insertCase(db, (await insertIdea(db, runId, ideaOver)).id, { sections: { numbers: { results: { buyer, unit: { grossMarginPct: 70 } } } } as unknown as CaseSections });

describe('computeScorecard: consumer, model and barrier metrics', () => {
  it('consumerShare counts consumer or both over ideas with an audience; meets at 30%', async () => {
    const db = await testDb();
    const r = await newRun(db);
    await insertIdea(db, r, { audience: 'consumer' });
    await insertIdea(db, r, { audience: 'both' });
    await insertIdea(db, r, { audience: 'business' });
    await insertIdea(db, r, { audience: 'business' });
    await insertIdea(db, r); // old idea: no audience, not counted
    await insertIdea(db, r, { audience: 'consumer', origin: 'owner' }); // owner idea: not generated
    const m = metric(await computeScorecard(db, [r]), 'consumerShare');
    expect(m).toMatchObject({ status: 'measured', value: 0.5, display: '50% (2 of 4)', meets: true });
    const r2 = await newRun(db);
    for (const a of ['consumer', 'business', 'business', 'business'] as const) await insertIdea(db, r2, { audience: a });
    expect(metric(await computeScorecard(db, [r2]), 'consumerShare')).toMatchObject({ value: 0.25, meets: false });
  });

  it('old data with no audience, model or barriers is no_data for all three', async () => {
    const db = await testDb();
    const r = await newRun(db);
    await insertIdea(db, r);
    await caseWith(db, r, 3, 70);
    const sc = await computeScorecard(db, [r]);
    for (const id of ['consumerShare', 'modelVariety', 'easyStartHardCopy'] as const) {
      expect(metric(sc, id)).toMatchObject({ status: 'no_data', value: null, meets: null });
      expect(metric(sc, id).note).toBeTruthy();
    }
  });

  it('modelVariety averages distinct models per run over runs with at least one model', async () => {
    const db = await testDb();
    const a = await newRun(db);
    const b = await newRun(db);
    const empty = await newRun(db);
    await insertIdea(db, empty);
    for (const m of ['subscription', 'ads', 'ads', 'one_off', 'usage'] as const) await insertIdea(db, a, { businessModel: m });
    for (const m of ['subscription', 'affiliate'] as const) await insertIdea(db, b, { businessModel: m });
    await insertIdea(db, b, { businessModel: 'ads', origin: 'owner' });
    const m = metric(await computeScorecard(db, [a, b, empty]), 'modelVariety');
    expect(m).toMatchObject({ status: 'measured', value: 3, display: '3.0 per run', meets: false });
    expect(metric(await computeScorecard(db, [a]), 'modelVariety')).toMatchObject({ value: 4, meets: true });
  });

  it('easyStartHardCopy counts cases with toStart <= 2 and toCopy >= 4 over cases with barriers', async () => {
    const db = await testDb();
    const r = await newRun(db);
    await richCase(db, r, { roiMultiple: 3 }, { barriers: bar(2, 4) });
    await richCase(db, r, { roiMultiple: 3 }, { barriers: bar(1, 5) });
    await richCase(db, r, { roiMultiple: 3 }, { barriers: bar(3, 5) });
    await richCase(db, r, { roiMultiple: 3 }, { barriers: bar(2, 3) });
    await richCase(db, r, { roiMultiple: 3 }); // no barriers: not counted
    const m = metric(await computeScorecard(db, [r]), 'easyStartHardCopy');
    expect(m).toMatchObject({ status: 'measured', value: 0.5, display: '50% (2 of 4)', meets: true });
  });

  it('customerReturn prefers valueMultiple, falls back to roiMultiple, and skips pays-nothing cases', async () => {
    const db = await testDb();
    const r = await newRun(db);
    await richCase(db, r, { valueMultiple: 4, roiMultiple: 1 }); // value wins: meets
    await richCase(db, r, { valueMultiple: 1.5, roiMultiple: 9 }); // value wins: fails
    await richCase(db, r, { roiMultiple: 5 }); // old case: fallback
    await richCase(db, r, { valueMultiple: null, valueMultipleNote: 'You pay nothing.', roiMultiple: 0 }); // excluded
    const m = metric(await computeScorecard(db, [r]), 'customerReturn');
    expect(m.status).toBe('measured');
    expect(m.display).toBe('67% (2 of 3), median 4.00×');
    expect(m.meets).toBe(false);
    expect(m.note).toMatch(/pays? nothing/i);
    expect(metric(await computeScorecard(db, [r]), 'margin').display).toContain('4 of 4');
  });

  it('customerReturn is no_data when every case is a pays-nothing case', async () => {
    const db = await testDb();
    const r = await newRun(db);
    await richCase(db, r, { valueMultiple: null, valueMultipleNote: 'You pay nothing.' });
    expect(metric(await computeScorecard(db, [r]), 'customerReturn')).toMatchObject({ status: 'no_data', value: null });
  });

  describe('demandEvidence', () => {
    let seq = 0;
    const entry = async (db: Db, kind: 'trend' | 'rule_change' | 'market' | 'startup') => {
      seq += 1;
      const [row] = await db.insert(knowledgeItems).values({ kind, title: `k${seq}`, summary: 's', audience: 'business', countries: [], industries: [], facts: {}, contentHash: `ch-${kind}-${seq}` }).returning({ id: knowledgeItems.id });
      return row!.id;
    };
    it('3 of 4 ideas citing a trend, rule change or market is 75%', async () => {
      const db = await testDb();
      const r = await newRun(db);
      const trend = await entry(db, 'trend'), rule = await entry(db, 'rule_change'), market = await entry(db, 'market'), startup = await entry(db, 'startup');
      await insertIdea(db, r, { libraryItemIds: [trend] });
      await insertIdea(db, r, { libraryItemIds: [startup, rule] });
      await insertIdea(db, r, { libraryItemIds: [market] });
      await insertIdea(db, r, { libraryItemIds: [startup] });
      await insertIdea(db, r, { libraryItemIds: [trend], origin: 'owner' }); // owner idea: not counted
      const m = metric(await computeScorecard(db, [r]), 'demandEvidence');
      expect(m).toMatchObject({ status: 'measured', value: 0.75, display: '75% (3 of 4)', meets: false });
    });
    it('is no_data when no idea has libraryItemIds (older ideas)', async () => {
      const db = await testDb();
      const r = await newRun(db);
      await insertIdea(db, r);
      await insertIdea(db, r);
      expect(metric(await computeScorecard(db, [r]), 'demandEvidence')).toMatchObject({ status: 'no_data', value: null });
    });
    it('an empty Slice B library counts ideas as not citing (0 of n), not no_data', async () => {
      const db = await testDb();
      const r = await newRun(db);
      await insertIdea(db, r, { libraryItemIds: [] });
      await insertIdea(db, r, { libraryItemIds: [] });
      expect(metric(await computeScorecard(db, [r]), 'demandEvidence')).toMatchObject({ status: 'measured', value: 0, display: '0% (0 of 2)', meets: false });
    });
    it('meets at 80% or more', async () => {
      const db = await testDb();
      const r = await newRun(db);
      const trend = await entry(db, 'trend');
      for (let i = 0; i < 4; i++) await insertIdea(db, r, { libraryItemIds: [trend] });
      await insertIdea(db, r, { libraryItemIds: [] });
      expect(metric(await computeScorecard(db, [r]), 'demandEvidence')).toMatchObject({ value: 0.8, meets: true });
    });
  });
});

/** A generated idea with a review under the current prompt version (or `promptVersion`). */
const reviewed = async (
  db: Db, runId: string, r: { scale: number; edge: number; niche?: number; novelty?: number }, idea: Partial<Parameters<typeof insertIdea>[2]> = {}, promptVersion = IDEA_REVIEW_VERSION,
) => {
  const row = await insertIdea(db, runId, idea);
  await db.insert(ideaReviews).values({
    ideaId: row.id, scale: r.scale, edge: r.edge, novelty: r.novelty ?? 3, niche: r.niche ?? 2, reasons: {}, model: 'm', promptVersion,
  });
  return row;
};

describe('computeScorecard: reviewer metrics', () => {
  it('no reviews: every reviewer metric is no_data', async () => {
    const db = await testDb();
    const r = await newRun(db);
    await insertIdea(db, r, { ownerRating: 1 });
    const sc = await computeScorecard(db, [r]);
    for (const id of ['medianEdge', 'medianScale', 'nicheShare', 'reviewerAgreement'] as const) {
      expect(metric(sc, id)).toMatchObject({ value: null, meets: null, status: 'no_data' });
      expect(metric(sc, id).note).toBeTruthy();
    }
  });

  it('medians of edge and scale over reviewed generated ideas, meeting at 3.5', async () => {
    const db = await testDb();
    const r = await newRun(db);
    await reviewed(db, r, { scale: 3, edge: 4 });
    await reviewed(db, r, { scale: 4, edge: 3 });
    await reviewed(db, r, { scale: 5, edge: 5 });
    await reviewed(db, r, { scale: 2, edge: 2 });
    await reviewed(db, r, { scale: 1, edge: 1 }, { origin: 'owner' }); // owner idea: left out
    await reviewed(db, r, { scale: 1, edge: 1 }, {}, 'idea-review.v0'); // older prompt version: left out
    await insertIdea(db, r); // not reviewed
    const sc = await computeScorecard(db, [r]);
    expect(metric(sc, 'medianEdge')).toMatchObject({ value: 3.5, meets: true, status: 'measured' });
    expect(metric(sc, 'medianEdge').display).toBe('3.5 (4 reviewed)');
    expect(metric(sc, 'medianScale')).toMatchObject({ value: 3.5, meets: true });
    await reviewed(db, r, { scale: 3, edge: 3 });
    const sc2 = await computeScorecard(db, [r]);
    expect(metric(sc2, 'medianEdge')).toMatchObject({ value: 3, meets: false, display: '3.0 (5 reviewed)' });
    expect(metric(sc2, 'medianScale')).toMatchObject({ value: 3, meets: false });
  });

  it('niche share counts niche >= 4 or scale <= 2, meeting at 30% or less', async () => {
    const db = await testDb();
    const r = await newRun(db);
    await reviewed(db, r, { scale: 4, edge: 4, niche: 4 }); // niche
    await reviewed(db, r, { scale: 2, edge: 4, niche: 1 }); // small scale
    for (let i = 0; i < 4; i++) await reviewed(db, r, { scale: 3, edge: 3, niche: 3 });
    const m = metric(await computeScorecard(db, [r]), 'nicheShare');
    expect(m.value).toBeCloseTo(2 / 6, 6);
    expect(m.meets).toBe(false);
    expect(m.display).toBe('33% (2 of 6)');
    await reviewed(db, r, { scale: 3, edge: 3, niche: 3 });
    await reviewed(db, r, { scale: 3, edge: 3, niche: 3 });
    expect(metric(await computeScorecard(db, [r]), 'nicheShare')).toMatchObject({ value: 0.25, meets: true });
  });

  it('reviewer agreement: no_data under 10 rated reviewed ideas; neither verdict is a miss; meets at 70%', async () => {
    const db = await testDb();
    const r = await newRun(db);
    // 6 agreeing: liked +1 (edge >= 4 and scale >= 3), disliked -1 (edge <= 2 or scale <= 2).
    for (let i = 0; i < 3; i++) await reviewed(db, r, { scale: 3, edge: 4 }, { ownerRating: 1 });
    await reviewed(db, r, { scale: 4, edge: 2 }, { ownerRating: -1 });
    await reviewed(db, r, { scale: 2, edge: 5 }, { ownerRating: -1 });
    await reviewed(db, r, { scale: 1, edge: 1 }, { ownerRating: -1 });
    // 2 neither (edge 3, scale 3): misses whichever way the owner rated.
    await reviewed(db, r, { scale: 3, edge: 3 }, { ownerRating: 1 });
    await reviewed(db, r, { scale: 3, edge: 3 }, { ownerRating: -1 });
    // 1 disagreeing.
    await reviewed(db, r, { scale: 5, edge: 5 }, { ownerRating: -1 });
    // Left out: neutral rating, rated but not reviewed, unrated but reviewed.
    await reviewed(db, r, { scale: 5, edge: 5 }, { ownerRating: 0 });
    await insertIdea(db, r, { ownerRating: 1 });
    await reviewed(db, r, { scale: 5, edge: 5 });
    const nine = metric(await computeScorecard(db, [r]), 'reviewerAgreement');
    expect(nine).toMatchObject({ value: null, meets: null, status: 'no_data' });
    expect(nine.note).toMatch(/9 of 10/);

    // Tenth: agreeing, so 7 of 10 = 70% meets.
    await reviewed(db, r, { scale: 4, edge: 4 }, { ownerRating: 1 });
    const ten = metric(await computeScorecard(db, [r]), 'reviewerAgreement');
    expect(ten).toMatchObject({ value: 0.7, meets: true, status: 'measured', display: '70% (7 of 10)' });

    // Eleventh: disagreeing, so 7 of 11 misses.
    await reviewed(db, r, { scale: 4, edge: 4 }, { ownerRating: -1 });
    expect(metric(await computeScorecard(db, [r]), 'reviewerAgreement')).toMatchObject({ meets: false, display: '64% (7 of 11)' });
  });
});

describe('computeScorecard: reviewer agreement from Board decisions', () => {
  it('counts decided cases (kept = liked, killed = disliked); an owner rating of 1 or -1 wins', async () => {
    const db = await testDb();
    const r = await newRun(db);
    const decided = async (stage: 'validating' | 'killed' | 'new', rv: { scale: number; edge: number }, idea: Partial<Parameters<typeof insertIdea>[2]> = {}) => {
      const row = await reviewed(db, r, rv, idea);
      await insertCase(db, row.id, { stage });
      return row;
    };
    for (let i = 0; i < 5; i++) await decided('validating', { scale: 4, edge: 4 });
    for (let i = 0; i < 3; i++) await decided('killed', { scale: 2, edge: 4 });
    // Rating wins: rated -1 but kept (reviewer likes it) is a miss; rated 1 but killed (reviewer likes it) agrees.
    await decided('validating', { scale: 4, edge: 4 }, { ownerRating: -1 });
    await decided('killed', { scale: 4, edge: 4 }, { ownerRating: 1 });
    // Undecided and unrated: left out. A neutral 0 on a decided case lets the case speak (killed, reviewer dislikes: agrees).
    await decided('new', { scale: 4, edge: 4 });
    await decided('killed', { scale: 1, edge: 1 }, { ownerRating: 0 });
    // 5+3+1+1 judged... plus the -1 miss: 11 judged, 10 agree.
    expect(metric(await computeScorecard(db, [r]), 'reviewerAgreement')).toMatchObject({ status: 'measured', display: '91% (10 of 11)', meets: true });
  });

  it('needs 10 judged ideas even when all come from the Board', async () => {
    const db = await testDb();
    const r = await newRun(db);
    for (let i = 0; i < 9; i++) await insertCase(db, (await reviewed(db, r, { scale: 4, edge: 4 })).id, { stage: 'live' });
    const m = metric(await computeScorecard(db, [r]), 'reviewerAgreement');
    expect(m).toMatchObject({ status: 'no_data', value: null });
    expect(m.note).toMatch(/9 of 10/);
    await insertCase(db, (await reviewed(db, r, { scale: 4, edge: 4 })).id, { stage: 'live' });
    expect(metric(await computeScorecard(db, [r]), 'reviewerAgreement')).toMatchObject({ display: '100% (10 of 10)' });
  });
});

describe('computeScorecard: engine v2 rows', () => {
  const ENGINE: MetricId[] = ['uniqueSketchShare', 'cellsFilled', 'judgeAccuracy', 'trivialKillRate', 'compsCoverage', 'engineCostPerRun'];
  const archive = (db: Db, runId: string, uniqueShare: number, cells: number) =>
    db.insert(runStages).values({ runId, stage: 'archive', status: 'done', output: { sketchIds: [], uniqueShare, cells } });
  const call = (runId: string, costUsd: string, promptVersion: string) =>
    ({ runId, stage: 's', provider: 'p', model: 'm', inputTokens: 1, outputTokens: 1, searchRequests: 0, costUsd, latencyMs: 1, promptVersion, ok: true });
  const verdict = (ideaId: string, check: 'trivial' | 'comps', pass: boolean, reasoning = 'r') =>
    ({ ideaId, check, pass, reasoning, model: 'm', promptVersion: 'p' });

  it('v1 passes (no engine data) show no data for the engine rows', async () => {
    const db = await testDb();
    const r = await newRun(db);
    await caseWith(db, r, 1, 1);
    const sc = await computeScorecard(db, [r]);
    for (const id of ENGINE) expect(metric(sc, id), id).toMatchObject({ status: 'no_data', value: null, meets: null, display: 'no data' });
  });

  it('unique share and cells average over runs with an archive stage', async () => {
    const db = await testDb();
    const a = await newRun(db);
    const b = await newRun(db);
    const v1 = await newRun(db); // a v1 run in the set is left out
    await archive(db, a, 0.7, 9);
    await archive(db, b, 0.4, 5);
    const sc = await computeScorecard(db, [a, b, v1]);
    expect(metric(sc, 'uniqueSketchShare')).toMatchObject({ status: 'measured', display: '55%', meets: false });
    expect(metric(sc, 'cellsFilled')).toMatchObject({ status: 'measured', display: '7.0 per run', meets: false });
    await db.update(runStages).set({ output: { uniqueShare: 0.8, cells: 10 } }).where(eq(runStages.runId, b));
    const sc2 = await computeScorecard(db, [a, b]);
    expect(metric(sc2, 'uniqueSketchShare')).toMatchObject({ display: '75%', meets: true });
    expect(metric(sc2, 'cellsFilled')).toMatchObject({ display: '9.5 per run', meets: true });
  });

  it('judge accuracy reads the latest calibration; too few pairs or none is no data', async () => {
    const db = await testDb();
    const r = await newRun(db);
    expect(metric(await computeScorecard(db, [r]), 'judgeAccuracy').status).toBe('no_data');
    await db.insert(settings).values({ key: 'audit.judge.latest', value: { at: '2026-11-01T00:00:00Z', accuracy: 0.8, consistency: 0.9, pairs: 20, tooFew: false } });
    expect(metric(await computeScorecard(db, [r]), 'judgeAccuracy')).toMatchObject({ status: 'measured', display: '80% (20 pairs)', meets: true, value: 0.8 });
    await db.update(settings).set({ value: { at: 'x', accuracy: 0.6, consistency: 0.9, pairs: 12, tooFew: false } }).where(eq(settings.key, 'audit.judge.latest'));
    expect(metric(await computeScorecard(db, [r]), 'judgeAccuracy')).toMatchObject({ display: '60% (12 pairs)', meets: false });
    await db.update(settings).set({ value: { at: 'x', accuracy: 1, consistency: 1, pairs: 3, tooFew: true } }).where(eq(settings.key, 'audit.judge.latest'));
    expect(metric(await computeScorecard(db, [r]), 'judgeAccuracy')).toMatchObject({ status: 'no_data', value: null });
    await db.update(settings).set({ value: { nonsense: true } }).where(eq(settings.key, 'audit.judge.latest'));
    expect(metric(await computeScorecard(db, [r]), 'judgeAccuracy').status).toBe('no_data');
  });

  it('trivial kill rate is the share of gate-evaluated generated ideas killed by the trivial check (reported, no target)', async () => {
    const db = await testDb();
    const r = await newRun(db);
    const a = await insertIdea(db, r, { status: 'gated_out' });
    const b = await insertIdea(db, r, { status: 'advanced' });
    const c = await insertIdea(db, r, { status: 'advanced' });
    const o = await insertIdea(db, r, { status: 'gated_out', origin: 'owner' });
    await db.insert(gateVerdicts).values([
      verdict(a.id, 'trivial', false), verdict(b.id, 'trivial', true), verdict(c.id, 'trivial', true), verdict(o.id, 'trivial', false),
    ]);
    expect(metric(await computeScorecard(db, [r]), 'trivialKillRate')).toMatchObject({ status: 'measured', value: 1 / 3, display: '33% (1 of 3)', meets: null });
  });

  it('comps coverage counts cases whose comps verdict lists two or more dossier comps, over cases with a comps verdict', async () => {
    const db = await testDb();
    const r = await newRun(db);
    const two = 'comps:\n- A (live, dossier): who pays: x\n- B (dead, dossier): who pays: y\n- C (live): who pays: z';
    const one = 'comps:\n- A (live, dossier): who pays: x\n- C (live): who pays: z';
    for (const text of [two, two, one, 'no comps found: no library startup is near this idea']) {
      const idea = await insertIdea(db, r);
      await insertCase(db, idea.id);
      await db.insert(gateVerdicts).values(verdict(idea.id, 'comps', !text.startsWith('no comps'), text));
    }
    // A v1 case (no comps verdict) in the same set is left out of the denominator.
    const v1 = await newRun(db);
    await insertCase(db, (await insertIdea(db, v1)).id);
    await insertCase(db, (await insertIdea(db, r)).id);
    expect(metric(await computeScorecard(db, [r, v1]), 'compsCoverage')).toMatchObject({ status: 'measured', value: 0.5, display: '50% (2 of 4)', meets: false });
  });

  it('engine cost per run sums sketch, judge and evolve calls of the set, averaged over runs that made them', async () => {
    const db = await testDb();
    const a = await newRun(db);
    const b = await newRun(db);
    const other = await newRun(db);
    await newRun(db);
    await db.insert(llmCalls).values([
      call(a, '2', 'sketch.v1'), call(a, '3', 'judge.v1'), call(a, '1', 'evolve.v1'), call(a, '9', 'ideate.v15'), call(a, '9', 'judge-reason.v1'),
      call(b, '4', 'sketch.v1'), call(other, '100', 'sketch.v1'),
    ]);
    expect(metric(await computeScorecard(db, [a, b]), 'engineCostPerRun')).toMatchObject({ status: 'measured', value: 5, display: '$5.00', meets: true });
    await db.insert(llmCalls).values(call(b, '8', 'judge.v1'));
    expect(metric(await computeScorecard(db, [a, b]), 'engineCostPerRun')).toMatchObject({ display: '$9.00', meets: false });
  });
});
