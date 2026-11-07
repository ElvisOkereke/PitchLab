import { describe, expect, it } from 'vitest';
import { renderBacktestMarkdown, runBacktest } from '../../src/audit/backtest';
import type { Db } from '../../src/db/client';
import { upsideScore } from '../../src/pipeline/business-models';
import { defaultRunConfig } from '../../src/pipeline/types';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';

type Stage = 'new' | 'validating' | 'pilot' | 'live' | 'killed';
const value = (kind: string) => ({ kind, amountPerYear: 1000, basis: 'b' });
const result = (revenueCeiling: number | null) => ({ payingBuyers: 1, annualPrice: 1, revenueCeiling, band: 2, capped: [], allAssumed: true });

async function add(db: Db, runId: string, title: string, stage: Stage, opts: { ceiling?: number | null; noResult?: boolean; kind?: string; isExample?: boolean } = {}) {
  const i = await insertIdea(db, runId, {
    title, valueToUser: opts.kind ? value(opts.kind) as never : null,
    scaleResult: opts.noResult ? null : result(opts.ceiling === undefined ? 0 : opts.ceiling),
  });
  await insertCase(db, i.id, { stage, slug: `c-${title}`, isExample: opts.isExample ?? false });
  return i;
}

describe('upsideScore', () => {
  it('maps value kinds', () => {
    expect(['earn', 'time', 'risk', 'save'].map((k) => upsideScore(k as never))).toEqual([5, 3, 3, 2]);
    expect(upsideScore(null)).toBe(3);
    expect(upsideScore(undefined)).toBe(3);
  });
});

describe('runBacktest', () => {
  async function fixture() {
    const db = await testDb();
    const r = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    await add(db, r.id, 'keptHigh', 'validating', { ceiling: 2_000_000, kind: 'earn' }); // rule keep, owner keep: agree
    await add(db, r.id, 'keptLow', 'live', { ceiling: 100_000, kind: 'earn' }); // below line: disagree
    await add(db, r.id, 'killedHigh', 'killed', { ceiling: 5_000_000, kind: 'earn' }); // rule keep: disagree
    await add(db, r.id, 'killedLowSave', 'killed', { ceiling: 100, kind: 'save' }); // agree
    await add(db, r.id, 'killedHighSave', 'killed', { ceiling: 9_000_000, kind: 'save' }); // upside 2: rule kill: agree
    await add(db, r.id, 'keptNoValue', 'pilot', { ceiling: 1_000_000 }); // missing = 3, ceiling at line: keep, agree
    await add(db, r.id, 'nullCeiling', 'killed', { ceiling: null, kind: 'earn' });
    await add(db, r.id, 'noResult', 'validating', { noResult: true });
    await add(db, r.id, 'fresh', 'new', { ceiling: 9_000_000, kind: 'earn' });
    await add(db, r.id, 'example', 'killed', { ceiling: 9_000_000, kind: 'earn', isExample: true });
    return db;
  }

  it('computes agreement, the confusion table and the disagreements', async () => {
    const bt = await runBacktest(await fixture(), { minRevenueCeiling: 1_000_000 });
    expect(bt.decided).toBe(6);
    expect(bt.agree).toBe(4);
    expect(bt.table).toEqual({ keptAbove: 2, keptBelow: 1, killedAbove: 2, killedBelow: 1 });
    expect(bt.disagreements.map((d) => d.title).sort()).toEqual(['keptLow', 'killedHigh']);
    expect(bt.disagreements.find((d) => d.title === 'killedHigh')).toMatchObject({ stage: 'killed', revenueCeiling: 5_000_000, upside: 5 });
  });

  it('lists ideas with no estimate or a null ceiling separately and leaves them out of agreement', async () => {
    const bt = await runBacktest(await fixture(), { minRevenueCeiling: 1_000_000 });
    expect(bt.noEstimate.map((d) => d.title).sort()).toEqual(['noResult', 'nullCeiling']);
  });

  it('writes markdown with the percentage, table, disagreements and no-estimate list', async () => {
    const bt = await runBacktest(await fixture(), { minRevenueCeiling: 1_000_000 });
    const md = renderBacktestMarkdown(bt, { minRevenueCeiling: 1_000_000, date: '2026-11-07' });
    expect(md).toContain('67%');
    expect(md).toContain('4 of 6');
    expect(md).toContain('keptLow');
    expect(md).toContain('noResult');
    expect(md).toMatch(/Kept[^\n]*\|\s*2\s*\|\s*1/);
  });

  it('uses the ceiling recomputed from the estimate with the business model, like the gate', async () => {
    const db = await testDb();
    const r = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const estimate = {
      buyerUnit: 'individuals',
      population: { count: 10_000_000, basis: 'b', source: 'https://census.example' },
      shareWithProblem: { pct: 50, basis: 'Assumption' },
      shareWillingToPay: { pct: 8, basis: 'Assumption' },
      shareReachable: { pct: 20, basis: 'Assumption' },
    };
    // ads: 80,000 regular users x $20 = $1,600,000 (the stale stored result says 0)
    const i = await insertIdea(db, r.id, {
      title: 'adIdea', businessModel: 'ads', priceHint: { amount: 20, unit: 'year', basis: 'b' }, scaleEstimate: estimate as never,
      scaleResult: result(0), valueToUser: value('earn') as never,
    });
    await insertCase(db, i.id, { stage: 'validating', slug: 'c-ad', isExample: false });
    const bt = await runBacktest(db, { minRevenueCeiling: 1_000_000 });
    expect(bt.table.keptAbove).toBe(1);
    expect(bt.agree).toBe(1);
  });

  it('handles an empty set', async () => {
    const db = await testDb();
    const bt = await runBacktest(db, { minRevenueCeiling: 1_000_000 });
    expect(bt).toMatchObject({ decided: 0, agree: 0, disagreements: [], noEstimate: [] });
    expect(renderBacktestMarkdown(bt, { minRevenueCeiling: 1_000_000, date: 'd' })).toContain('0 of 0');
  });
});
