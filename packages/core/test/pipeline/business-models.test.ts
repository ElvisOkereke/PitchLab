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
});
