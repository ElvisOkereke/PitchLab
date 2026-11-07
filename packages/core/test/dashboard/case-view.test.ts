import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client';
import { claims, gateVerdicts, scores } from '../../src/db/schema';
import { getCaseView } from '../../src/dashboard/case-view';
import { moveStage } from '../../src/dashboard/stage';
import { defaultRunConfig } from '../../src/pipeline/types';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';

let db: Db;

beforeEach(async () => {
  db = await testDb();
});

describe('getCaseView', () => {
  it('getCaseView rejects a bad slug and orders failed gate checks first', async () => {
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await insertIdea(db, run.id, { lensId: 'money-leak' });
    const c = await insertCase(db, idea.id, { slug: 'good-slug' });
    const v = (check: 'generic' | 'control' | 'evidence', pass: boolean, reasoning: string, s: number) =>
      ({ ideaId: idea.id, check, pass, reasoning, model: 'm', promptVersion: 'p', createdAt: new Date(Date.UTC(2026, 9, 3, 0, 0, s)) });
    await db.insert(gateVerdicts).values([
      v('control', true, 'ok', 0), v('evidence', true, 'old pass', 0), v('evidence', false, 'thin', 1), v('generic', true, 'fine', 0),
    ]);
    await db.insert(claims).values({ caseId: c.id, section: 'evidence', text: 'c', sourceUrl: 'https://x.test' });
    await db.insert(scores).values({ caseId: c.id, criterion: 'gut', value: 3, note: '', by: 'owner' });
    await moveStage(db, { caseId: c.id, from: 'new', to: 'validating' });

    for (const bad of ['', 'Bad-Slug', 'a/b', "x' or 1=1", 'a'.repeat(121), 'slug with space']) expect(await getCaseView(db, bad)).toBeNull();
    expect(await getCaseView(db, 'missing-slug')).toBeNull();

    const view = (await getCaseView(db, 'good-slug'))!;
    expect(view.case.id).toBe(c.id);
    expect(view.case.stage).toBe('validating');
    expect(view.lensName).toBe('Money-leak recovery');
    expect(view.gate.map((g) => [g.check, g.pass])).toEqual([['evidence', false], ['generic', true], ['control', true]]);
    expect(view.claims).toHaveLength(1);
    expect(view.scores).toHaveLength(1);
    expect(view.events).toHaveLength(1);
    expect(view.events[0]!.kind).toBe('move');
  });

  it("carries the idea's edge and scale (ideate.v12) when valid, and null for older ideas or garbage jsonb", async () => {
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const edge = { kind: 'cost', claim: 'Half the price', versus: 'An agency retainer', whyNow: 'Models got cheap' };
    const scale = { buyers: '40,000 firms', basis: 'Assumption: one in five' };
    await insertCase(db, (await insertIdea(db, run.id, { edge, scale })).id, { slug: 'new-idea' });
    await insertCase(db, (await insertIdea(db, run.id)).id, { slug: 'old-idea' });
    await insertCase(db, (await insertIdea(db, run.id, { edge: { kind: 'magic' }, scale: 'lots' })).id, { slug: 'junk-idea' });
    expect(await getCaseView(db, 'new-idea')).toMatchObject({ edge, scale });
    expect(await getCaseView(db, 'old-idea')).toMatchObject({ edge: null, scale: null });
    expect(await getCaseView(db, 'junk-idea')).toMatchObject({ edge: null, scale: null });
  });

  it("carries the idea's scale estimate and result (ideate.v13) when valid, and null for older ideas or garbage jsonb", async () => {
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const scaleEstimate = {
      buyerUnit: 'businesses', population: { count: 200_000, basis: 'Census', source: 'https://x.test/a' },
      shareWithProblem: { pct: 50, basis: 'Assumption: half' }, shareWillingToPay: { pct: 10, basis: 'Assumption: some' },
      shareReachable: { pct: 20, basis: 'Through accountants' },
    };
    const scaleResult = { payingBuyers: 2000, annualPrice: 1200, revenueCeiling: 2_400_000, band: 3, capped: [], allAssumed: false };
    await insertCase(db, (await insertIdea(db, run.id, { scaleEstimate, scaleResult, priceHint: { amount: 1200, unit: 'year', basis: 'b' } })).id, { slug: 'est-idea' });
    await insertCase(db, (await insertIdea(db, run.id)).id, { slug: 'no-est-idea' });
    await insertCase(db, (await insertIdea(db, run.id, { scaleEstimate: { buyerUnit: 'robots' }, scaleResult: { payingBuyers: 'many' } })).id, { slug: 'junk-est-idea' });
    expect(await getCaseView(db, 'est-idea')).toMatchObject({ scaleEstimate, scaleResult });
    expect(await getCaseView(db, 'no-est-idea')).toMatchObject({ scaleEstimate: null, scaleResult: null });
    expect(await getCaseView(db, 'junk-est-idea')).toMatchObject({ scaleEstimate: null, scaleResult: null });
  });

  it('recomputes the scale result from the estimate (a stale stored one never shows), and carries the business model and a free price', async () => {
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const scaleEstimate = {
      buyerUnit: 'individuals', population: { count: 1_000_000, basis: 'Census', source: 'https://x.test/a' },
      shareWithProblem: { pct: 50, basis: 'Assumption: half' }, shareWillingToPay: { pct: 40, basis: 'Assumption: some' },
      shareReachable: { pct: 10, basis: 'Through ads' },
    };
    const stale = { payingBuyers: 1, annualPrice: 2, revenueCeiling: 0, band: 1, capped: [], allAssumed: false };
    await insertCase(db, (await insertIdea(db, run.id, {
      scaleEstimate, scaleResult: stale, businessModel: 'ads', priceHint: { amount: 2, unit: 'year', basis: 'b' },
    })).id, { slug: 'ads-idea' });
    await insertCase(db, (await insertIdea(db, run.id, {
      scaleEstimate, scaleResult: stale, businessModel: 'ads', priceHint: { amount: 0, unit: 'year', basis: 'free' },
    })).id, { slug: 'free-idea' });
    const ads = (await getCaseView(db, 'ads-idea'))!;
    // 1,000,000 x 50% x 10% (capped from 40%) x 10% = 5,000 regular users x $2.
    expect(ads.scaleResult).toMatchObject({ payingBuyers: 5000, revenueCeiling: 10_000, band: 1 });
    expect(ads).toMatchObject({ businessModel: 'ads', priceIsFree: false });
    const free = (await getCaseView(db, 'free-idea'))!;
    expect(free.scaleResult).toMatchObject({ revenueCeiling: null, band: 2 });
    expect(free.priceIsFree).toBe(true);
  });

  it('keeps only the latest 20 stage events, newest first, and a null lens for owner ideas', async () => {
    const run = await insertRun(db, defaultRunConfig({ seedType: 'idea' }));
    const idea = await insertIdea(db, run.id, { origin: 'owner' });
    const c = await insertCase(db, idea.id, { slug: 'busy' });
    let from: 'new' | 'validating' = 'new';
    for (let i = 0; i < 22; i++) {
      const to: 'new' | 'validating' = from === 'new' ? 'validating' : 'new';
      await moveStage(db, { caseId: c.id, from, to });
      from = to;
    }
    const view = (await getCaseView(db, 'busy'))!;
    expect(view.lensName).toBeNull();
    expect(view.events).toHaveLength(20);
    const times = view.events.map((e) => e.at.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});
