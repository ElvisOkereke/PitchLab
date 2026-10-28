import { describe, it, expect } from 'vitest';
import {
  BUSINESS_MODELS, AUDIENCES, ValueToUserSchema, PriceHintSchema, BarriersSchema, valueMultiple,
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
