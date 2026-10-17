import { describe, it, expect } from 'vitest';
import { computeNumbers } from '../../src/calc/numbers';
import { NumberInputsSchema, type NumberInputs } from '../../src/calc/schema';

const s = (value: number) => ({ value, assumption: 'test' });
const leadFlow: NumberInputs = {
  price: { amount: s(8), per: 'site', unitsPerBuyer: s(40), periodsPerYear: 12 },
  problemCost: [{ label: 'lost leads from broken forms', quantity: s(6), unitCost: s(400), perYear: s(40) }],
  expectedReduction: s(0.5), reachableBuyers: s(3000), captureRate: s(0.01),
  deliveryCostPerBuyerMonthly: [{ label: 'infra+LLM', cost: s(40) }], fixedCostsMonthly: [{ label: 'hosting', cost: s(30) }], scenarios: [10, 50, 200],
};

describe('computeNumbers', () => {
  it('computes the lead-flow example', () => {
    const r = computeNumbers(leadFlow);
    expect(r.buyer.annualPrice).toBe(3840); expect(r.buyer.annualProblemCost).toBe(96000);
    expect(r.buyer.annualSavings).toBe(48000); expect(r.buyer.roiMultiple).toBeCloseTo(12.5);
    expect(r.buyer.paybackMonths).toBeCloseTo(0.96);
    expect(r.unit.monthlyPricePerBuyer).toBe(320); expect(r.unit.grossMarginPct).toBeCloseTo(87.5);
    expect(r.market.year1Revenue).toBe(115200);
    expect(r.scenarios[0]).toEqual({ buyers: 10, mrr: 3200, arr: 38400, monthlyGrossProfit: 2800, monthlyNet: 2770 });
    expect(r.breakevenBuyers).toBe(1);
    expect(r.formulas.some(f => f.includes('$3,840'))).toBe(true);
    expect(r.formulas).toContain('Annual price = $8 × 40 × 12 = $3,840');
  });
  it('breakeven is null when price does not cover delivery', () => {
    const r = computeNumbers({ ...leadFlow, deliveryCostPerBuyerMonthly: [{ label: 'x', cost: s(400) }] });
    expect(r.breakevenBuyers).toBeNull(); expect(r.breakevenReason).toBe('price does not cover delivery cost');
  });
  it('zero buyers and zero price give zeros/nulls, never NaN', () => {
    const r = computeNumbers({ ...leadFlow, reachableBuyers: s(0), price: { ...leadFlow.price, amount: s(0) } });
    expect(r.market.annualRevenuePotential).toBe(0); expect(r.buyer.roiMultiple).toBeNull();
    expect(r.unit.grossMarginPct).toBeNull();
    expect(JSON.stringify(r)).not.toMatch(/NaN|Infinity/);
  });
  it('defaults scenarios when missing or empty', () => {
    expect(computeNumbers({ ...leadFlow, scenarios: [] }).scenarios.map(x => x.buyers)).toEqual([10, 50, 200]);
    expect(computeNumbers({ ...leadFlow, scenarios: undefined as unknown as number[] }).scenarios.length).toBe(3);
  });
  it('payback is null when savings are zero', () => {
    expect(computeNumbers({ ...leadFlow, expectedReduction: s(0) }).buyer.paybackMonths).toBeNull();
  });
});

describe('NumberInputsSchema', () => {
  it('accepts valid inputs', () => {
    expect(NumberInputsSchema.safeParse(leadFlow).success).toBe(true);
  });
  it('rejects an input with neither source nor assumption', () => {
    expect(NumberInputsSchema.safeParse({ ...leadFlow, captureRate: { value: 0.01 } }).success).toBe(false);
  });
  it('rejects negative values and fractions above 1', () => {
    expect(NumberInputsSchema.safeParse({ ...leadFlow, reachableBuyers: s(-1) }).success).toBe(false);
    expect(NumberInputsSchema.safeParse({ ...leadFlow, captureRate: s(1.5) }).success).toBe(false);
    expect(NumberInputsSchema.safeParse({ ...leadFlow, expectedReduction: s(2) }).success).toBe(false);
  });
});
