import { describe, it, expect } from 'vitest';
import {
  BUSINESS_MODELS, AUDIENCES, ValueToUserSchema, PriceHintSchema, BarriersSchema, valueMultiple,
  ScaleEstimateSchema, computeScale, currentScale, annualPrice, type ScaleEstimate,
} from '../../src/pipeline/business-models';

const value = { kind: 'save' as const, amountPerYear: 1200, basis: 'Avoids late fees' };
const price = (amount: number, unit: string) => ({ amount, unit, basis: 'competitor page' });

describe('business models', () => {
  it('lists the models and audiences', () => {
    expect(BUSINESS_MODELS).toHaveLength(11);
    expect(BUSINESS_MODELS).toContain('service_plus_software');
    expect([...AUDIENCES]).toEqual(['business', 'consumer', 'both']);
  });
  it('validates valueToUser', () => {
    expect(ValueToUserSchema.safeParse(value).success).toBe(true);
    expect(ValueToUserSchema.safeParse({ ...value, kind: 'fun' }).success).toBe(false);
    expect(ValueToUserSchema.safeParse({ ...value, amountPerYear: -1 }).success).toBe(false);
    expect(ValueToUserSchema.safeParse({ ...value, basis: '' }).success).toBe(false);
  });
  it('validates priceHint', () => {
    expect(PriceHintSchema.safeParse(price(10, 'month')).success).toBe(true);
    expect(PriceHintSchema.safeParse(price(10, '')).success).toBe(false);
    expect(PriceHintSchema.safeParse(price(-1, 'month')).success).toBe(false);
  });
  it('validates barriers', () => {
    const b = { toStart: 2, toStartWhy: 'a', toCopy: 4, toCopyWhy: 'b', soloBuildable: true };
    expect(BarriersSchema.safeParse(b).success).toBe(true);
    expect(BarriersSchema.safeParse({ ...b, toStart: 6 }).success).toBe(false);
    expect(BarriersSchema.safeParse({ ...b, toCopy: 1.5 }).success).toBe(false);
    expect(BarriersSchema.safeParse({ ...b, soloBuildable: 'yes' }).success).toBe(false);
  });
});

describe('valueMultiple', () => {
  it('annualises by unit', () => {
    expect(valueMultiple(value, price(10, 'month'))).toBe(10);
    expect(valueMultiple(value, price(100, 'year'))).toBe(12);
    expect(valueMultiple(value, price(12, 'week'))).toBeCloseTo(1200 / 624);
    expect(valueMultiple(value, price(600, 'one-time'))).toBe(2);
  });
  it('handles per-use and zero prices', () => {
    expect(valueMultiple(value, price(5, 'per use'))).toBeNull();
    expect(valueMultiple(value, price(5, 'per use'), 20)).toBe(12);
    expect(valueMultiple(value, price(0, 'month'))).toBeNull();
  });
  it.each([
    ['per seat/month', 12], ['user/month', 12], ['/mo', 12], ['annually', 1], ['yearly', 1], ['lifetime', 1],
    ['bi-weekly', 26], ['biweekly', 26], ['fortnight', 26], ['quarterly', 4], ['semi-annual', 2], ['half-year', 2],
  ])('unit %s uses %i periods', (unit, n) => {
    expect(valueMultiple(value, price(10, unit))).toBeCloseTo(1200 / (10 * n));
  });
  it.each(['every 2 weeks', 'per 3 months', 'per 6 months', 'per year, billed monthly', '$10/month billed annually', 'weekly, billed annually', 'bi-weekly billed yearly', 'seat'])(
    'unit %s is null', (unit) => { expect(valueMultiple(value, price(10, unit))).toBeNull(); });
  it('does not match once/flat inside other words, but does match them as words', () => {
    expect(valueMultiple(value, price(10, 'flatten'))).toBeNull();
    expect(valueMultiple(value, price(10, 'inflate'))).toBeNull();
    expect(valueMultiple(value, price(10, 'sconce'))).toBeNull();
    expect(valueMultiple(value, price(10, 'flat fee'))).toBeCloseTo(120);
  });
  it('rejects negative and infinite prices', () => {
    expect(valueMultiple(value, price(-5, 'month'))).toBeNull();
    expect(valueMultiple(value, price(Infinity, 'month'))).toBeNull();
    expect(PriceHintSchema.safeParse(price(Infinity, 'month')).success).toBe(false);
    expect(ValueToUserSchema.safeParse({ ...value, amountPerYear: Infinity }).success).toBe(false);
  });
});

const est = (o: Partial<{ unit: 'businesses' | 'individuals'; count: number; prob: object; pay: object; reach: object }> = {}): ScaleEstimate => ({
  buyerUnit: o.unit ?? 'businesses',
  population: { count: o.count ?? 1000, basis: 'census' },
  shareWithProblem: { pct: 50, basis: 'guess', ...(o.prob ?? {}) },
  shareWillingToPay: { pct: 10, basis: 'guess', ...(o.pay ?? {}) },
  shareReachable: { pct: 10, basis: 'guess', ...(o.reach ?? {}) },
} as ScaleEstimate);
const yearly = (amount: number) => ({ amount, unit: 'year', basis: 'b' });

describe('annualPrice', () => {
  it('annualises by unit and returns null when it cannot', () => {
    expect(annualPrice(yearly(100))).toBe(100);
    expect(annualPrice({ amount: 10, unit: 'month', basis: 'b' })).toBe(120);
    expect(annualPrice({ amount: 10, unit: 'per claim', basis: 'b' })).toBeNull();
    expect(annualPrice({ amount: 10, unit: 'per claim', basis: 'b' }, 4)).toBe(40);
    expect(annualPrice({ amount: 10, unit: 'every 2 weeks', basis: 'b' })).toBeNull();
  });
});

describe('ScaleEstimateSchema', () => {
  it('validates ranges and lengths', () => {
    expect(ScaleEstimateSchema.safeParse(est()).success).toBe(true);
    expect(ScaleEstimateSchema.safeParse(est({ prob: { pct: 101 } })).success).toBe(false);
    expect(ScaleEstimateSchema.safeParse(est({ pay: { pct: -1 } })).success).toBe(false);
    expect(ScaleEstimateSchema.safeParse(est({ count: -1 })).success).toBe(false);
    expect(ScaleEstimateSchema.safeParse(est({ reach: { basis: 'x'.repeat(301) } })).success).toBe(false);
    expect(ScaleEstimateSchema.safeParse({ ...est(), buyerUnit: 'cats' }).success).toBe(false);
  });
});

describe('computeScale caps', () => {
  it('caps willing-to-pay at 15% for businesses and 3% for individuals when unsourced', () => {
    const b = computeScale(est({ pay: { pct: 50 } }), yearly(1));
    expect(b.capped).toEqual(['shareWillingToPay']);
    expect(b.payingBuyers).toBeCloseTo(1000 * 0.5 * 0.15 * 0.1);
    const i = computeScale(est({ unit: 'individuals', pay: { pct: 50 } }), yearly(1));
    expect(i.payingBuyers).toBeCloseTo(1000 * 0.5 * 0.03 * 0.1);
  });
  it('does not cap a sourced share, only clamps it', () => {
    const r = computeScale(est({ pay: { pct: 50, source: 'lib:1' }, prob: { pct: 90, source: 'u' } }), yearly(1));
    expect(r.capped).toEqual([]);
    expect(r.payingBuyers).toBeCloseTo(1000 * 0.9 * 0.5 * 0.1);
    expect(computeScale(est({ pay: { pct: 500, source: 'lib:1' } }), yearly(1)).payingBuyers).toBeCloseTo(1000 * 0.5 * 1 * 0.1);
  });
  it('treats an empty or whitespace source as none', () => {
    expect(computeScale(est({ pay: { pct: 50, source: '' } }), yearly(1)).capped).toEqual(['shareWillingToPay']);
    expect(computeScale(est({ pay: { pct: 50, source: '   ' } }), yearly(1)).capped).toEqual(['shareWillingToPay']);
  });
  it('caps with-problem at 60% and reachable at 20% always', () => {
    const r = computeScale(est({ prob: { pct: 90 }, reach: { pct: 80, source: 'x' } }), yearly(1));
    expect(r.capped).toEqual(['shareWithProblem', 'shareReachable']);
    expect(r.payingBuyers).toBeCloseTo(1000 * 0.6 * 0.1 * 0.2);
  });
  it('clamps negative shares to 0 and a negative population to 0', () => {
    const r = computeScale({ ...est(), population: { count: -5, basis: 'b' }, shareWithProblem: { pct: -10, basis: 'b' } }, yearly(10));
    expect(r.payingBuyers).toBe(0);
    expect(r.revenueCeiling).toBe(0);
  });
});

describe('computeScale allAssumed', () => {
  it('is true with no sources and false when any step has one', () => {
    expect(computeScale(est(), yearly(1)).allAssumed).toBe(true);
    const e = est(); e.population.source = 'census.gov';
    expect(computeScale(e, yearly(1)).allAssumed).toBe(false);
    expect(computeScale(est({ prob: { source: ' ' } }), yearly(1)).allAssumed).toBe(true);
  });
});

describe('computeScale bands', () => {
  // sourced shares at 100%, reach capped at 20%, price 5 => ceiling = count
  const at = (ceiling: number) => computeScale({
    buyerUnit: 'businesses',
    population: { count: ceiling, basis: 'b', source: 's' },
    shareWithProblem: { pct: 100, basis: 'b', source: 's' },
    shareWillingToPay: { pct: 100, basis: 'b', source: 's' },
    shareReachable: { pct: 100, basis: 'b' },
  }, yearly(5));
  it.each([
    [249_999, 1], [250_000, 2], [999_999, 2], [1_000_000, 3], [4_999_999, 3],
    [5_000_000, 4], [24_999_999, 4], [25_000_000, 5], [100_000_000, 5],
  ])('ceiling %i is band %i', (c, band) => {
    const r = at(c);
    expect(r.revenueCeiling).toBeCloseTo(c);
    expect(r.band).toBe(band);
  });
});

describe('computeScale price handling', () => {
  it('null price hint or unknown unit gives null ceiling and band 2', () => {
    for (const p of [null, { amount: 10, unit: 'per claim', basis: 'b' }]) {
      const r = computeScale(est({ count: 1e9 }), p);
      expect(r).toMatchObject({ annualPrice: null, revenueCeiling: null, band: 2 });
    }
  });
  it('a price of 0 is unknown (a free product earns another way): null ceiling and band 2', () => {
    expect(annualPrice(yearly(0))).toBe(0);
    expect(computeScale(est(), yearly(0))).toMatchObject({ annualPrice: null, revenueCeiling: null, band: 2 });
    expect(computeScale(est(), { amount: 0, unit: 'month', basis: 'b' })).toMatchObject({ revenueCeiling: null, band: 2 });
  });
});

describe('computeScale for ads and affiliate (the user pays nothing)', () => {
  // 1M individuals x 50% x 8% x 20% = 8,000 regular users x $5 a year of revenue per user = $40,000
  const ad = (): ScaleEstimate => ({
    buyerUnit: 'individuals',
    population: { count: 1_000_000, basis: 'b', source: 'https://census.example' },
    shareWithProblem: { pct: 50, basis: 'Assumption' },
    shareWillingToPay: { pct: 8, basis: 'Assumption: become regular users' },
    shareReachable: { pct: 20, basis: 'Assumption' },
  });
  it('step 3 is the share who become regular users, capped unsourced at 10% for individuals', () => {
    for (const m of ['ads', 'affiliate']) {
      const r = computeScale(ad(), yearly(5), m);
      expect(r.capped).toEqual([]);
      expect(r.payingBuyers).toBeCloseTo(8000);
      expect(r.revenueCeiling).toBeCloseTo(40_000);
      expect(r.band).toBe(1);
    }
    const capped = computeScale({ ...ad(), shareWillingToPay: { pct: 40, basis: 'Assumption' } }, yearly(5), 'ads');
    expect(capped.capped).toEqual(['shareWillingToPay']);
    expect(capped.payingBuyers).toBeCloseTo(1_000_000 * 0.5 * 0.1 * 0.2);
  });
  it('caps businesses at 30% under ads', () => {
    const r = computeScale({ ...ad(), buyerUnit: 'businesses', shareWillingToPay: { pct: 50, basis: 'Assumption' } }, yearly(5), 'ads');
    expect(r.payingBuyers).toBeCloseTo(1_000_000 * 0.5 * 0.3 * 0.2);
  });
  it('the same idea under subscription (or no model) caps at 3%', () => {
    for (const m of ['subscription', null, undefined]) {
      const r = computeScale(ad(), yearly(5), m);
      expect(r.capped).toEqual(['shareWillingToPay']);
      expect(r.payingBuyers).toBeCloseTo(3000);
      expect(r.revenueCeiling).toBeCloseTo(15_000);
    }
  });
});

describe('computeScale unsourced band cap', () => {
  const big = (popSource?: string, paySource?: string): ScaleEstimate => ({
    buyerUnit: 'businesses',
    population: { count: 100_000_000, basis: 'b', ...(popSource ? { source: popSource } : {}) },
    shareWithProblem: { pct: 50, basis: 'b' },
    shareWillingToPay: { pct: 10, basis: 'b', ...(paySource ? { source: paySource } : {}) },
    shareReachable: { pct: 20, basis: 'b' },
  });
  // 100M x 50% x 10% x 20% = 1M buyers x $100 = $100M: band 5 when the population is sourced
  it('caps the band at 3 when the population has no source, keeping the ceiling', () => {
    const r = computeScale(big(undefined, 'lib:1'), yearly(100));
    expect(r.allAssumed).toBe(false);
    expect(r.revenueCeiling).toBeCloseTo(100_000_000);
    expect(r.band).toBe(3);
    expect(r.bandCapped).toBe(true);
  });
  it('caps the band at 3 when every step is an assumption', () => {
    const r = computeScale(big(), yearly(100));
    expect(r.allAssumed).toBe(true);
    expect(r).toMatchObject({ band: 3, bandCapped: true });
  });
  it('a sourced population keeps its band; a band already at or under 3 is not flagged', () => {
    expect(computeScale(big('https://census.example'), yearly(100))).toMatchObject({ band: 5, bandCapped: false });
    expect(computeScale(big(), yearly(3))).toMatchObject({ revenueCeiling: 3_000_000, band: 3, bandCapped: false });
    expect(computeScale(big(), yearly(0.1))).toMatchObject({ band: 1, bandCapped: false });
  });
});

describe('currentScale', () => {
  const e = (): ScaleEstimate => ({
    buyerUnit: 'businesses',
    population: { count: 200_000, basis: 'b', source: 's' },
    shareWithProblem: { pct: 50, basis: 'b', source: 's' },
    shareWillingToPay: { pct: 10, basis: 'b', source: 's' },
    shareReachable: { pct: 20, basis: 'b' },
  });
  const stale = { payingBuyers: 1, annualPrice: 1, revenueCeiling: 1, band: 1, capped: [], allAssumed: true };
  it('recomputes from a valid estimate, the price hint and the business model (ignoring a stale stored result)', () => {
    const r = currentScale({ scaleEstimate: e(), scaleResult: stale, priceHint: { amount: 100, unit: 'month', basis: 'b' }, businessModel: 'subscription' });
    expect(r).toMatchObject({ payingBuyers: 2000, annualPrice: 1200, revenueCeiling: 2_400_000, band: 3 });
    const ads = { ...e(), shareWillingToPay: { pct: 25, basis: 'b' } };
    expect(currentScale({ scaleEstimate: ads, scaleResult: null, priceHint: yearly(1), businessModel: 'ads' })!.payingBuyers).toBeCloseTo(5000);
  });
  it('falls back to a valid stored result when the estimate is missing or malformed, else null', () => {
    expect(currentScale({ scaleEstimate: null, scaleResult: stale, priceHint: null, businessModel: null })).toMatchObject({ band: 1, revenueCeiling: 1 });
    expect(currentScale({ scaleEstimate: { junk: 1 }, scaleResult: stale, priceHint: null, businessModel: null })).toMatchObject({ band: 1 });
    expect(currentScale({ scaleEstimate: null, scaleResult: { junk: 1 }, priceHint: null, businessModel: null })).toBeNull();
    expect(currentScale({ scaleEstimate: null, scaleResult: null, priceHint: null, businessModel: null })).toBeNull();
  });
  it('treats a malformed price hint as no price', () => {
    expect(currentScale({ scaleEstimate: e(), scaleResult: null, priceHint: { amount: 'lots' }, businessModel: null }))
      .toMatchObject({ revenueCeiling: null, band: 2 });
  });
});
