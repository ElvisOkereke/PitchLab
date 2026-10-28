import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '../../src/db/client';
import type { CaseSections } from '../../src/case/schema';
import { dataCalls, gateVerdicts, llmCalls, runs, scores, signals } from '../../src/db/schema';
import { METRIC_DEFS, type MetricId } from '../../src/bench/definitions';
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

const MEASURED: MetricId[] = ['repetition', 'nearDuplicates', 'buyerVariety', 'consumerShare', 'modelVariety', 'realNeed', 'customerReturn', 'margin', 'wastedEntrants', 'easyStartHardCopy', 'ownerVerdict', 'costPerCase'];

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
        if (def.phase) {
          expect(m).toMatchObject({ status: 'not_measured', display: `not measured yet (Phase ${def.phase})` });
        } else {
          expect(MEASURED).toContain(def.id);
          expect(m.status).toBe('no_data');
          expect(m.note).toBeTruthy();
        }
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

  it('demandEvidence stays not measured', async () => {
    const db = await testDb();
    const r = await newRun(db);
    expect(metric(await computeScorecard(db, [r]), 'demandEvidence')).toMatchObject({ status: 'not_measured', display: 'not measured yet (Phase 2)' });
  });
});
