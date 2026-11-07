import { describe, it, expect } from 'vitest';
import {
  BUSINESS_MODELS, AUDIENCES, ValueToUserSchema, PriceHintSchema, BarriersSchema, valueMultiple,
  ScaleEstimateSchema, computeScale, annualPrice, type ScaleEstimate,
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
  it('a price of 0 gives ceiling 0 and band 1', () => {
    expect(computeScale(est(), yearly(0))).toMatchObject({ annualPrice: 0, revenueCeiling: 0, band: 1 });
  });
});
