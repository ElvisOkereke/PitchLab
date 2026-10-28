import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listInputs } from '../../src/calc/inputs';
import { computeNumbers, valueMultipleRaw } from '../../src/calc/numbers';
import { NumberInputsSchema, type NumberInputs } from '../../src/calc/schema';
import { CaseSectionsSchema } from '../../src/case/schema';

const s = (value: number) => ({ value, assumption: 'test' });
const base: NumberInputs = {
  price: { amount: s(10), per: 'month', unitsPerBuyer: s(1), periodsPerYear: 12 },
  problemCost: [],
  expectedReduction: s(0.5), reachableBuyers: s(1000), captureRate: s(0.01),
  deliveryCostPerBuyerMonthly: [{ label: 'infra', cost: s(2) }], fixedCostsMonthly: [], scenarios: [10],
};
const withRev = (revenue: NumberInputs['revenue'], extra: Partial<NumberInputs> = {}): NumberInputs => ({ ...base, revenue, ...extra });

const models: [string, NonNullable<NumberInputs['revenue']>, number, string][] = [
  ['marketplace', { model: 'marketplace', gmvPerBuyerPerYear: s(20000), takeRate: s(0.1) }, 2000, 'GMV'],
  ['usage', { model: 'usage', unitPrice: s(0.5), unitsPerBuyerPerYear: s(4000) }, 2000, 'units'],
  ['ads', { model: 'ads', impressionsPerUserPerYear: s(100000), cpm: s(5) }, 500, 'CPM'],
  ['affiliate', { model: 'affiliate', referralsPerBuyerPerYear: s(20), commission: s(30) }, 600, 'commission'],
  ['freemium', { model: 'freemium', conversionRate: s(0.05), paidPricePerYear: s(120) }, 6, 'conversion'],
  ['transaction_fee', { model: 'transaction_fee', transactionsPerBuyerPerYear: s(500), feePerTransaction: s(1.5) }, 750, 'transactions'],
  ['one_off', { model: 'one_off', price: s(49), purchasesPerBuyerPerYear: s(2) }, 98, 'purchases'],
  ['data_sales', { model: 'data_sales', pricePerClientPerYear: s(3000) }, 3000, 'client'],
  ['licensing', { model: 'licensing', pricePerClientPerYear: s(8000) }, 8000, 'client'],
  ['service_plus_software', { model: 'service_plus_software', subscriptionPerYear: s(1200), setupFee: s(800) }, 1200, 'subscription'],
];

describe('business-model revenue', () => {
  it.each(models)('%s: annual revenue per buyer comes from the model formula', (_n, revenue, expected, word) => {
    const inputs = withRev(revenue);
    expect(NumberInputsSchema.safeParse(inputs).success).toBe(true);
    const r = computeNumbers(inputs);
    expect(r.buyer.annualPrice).toBe(expected);
    expect(r.unit.monthlyPricePerBuyer).toBeCloseTo(expected / 12, 2);
    expect(r.market.annualRevenuePotential).toBe(expected * 1000);
    expect(r.revenueFormula).toContain(word);
    expect(r.revenueFormula).toContain(`$${expected.toLocaleString('en-US')}`);
    expect(r.formulas[0]).toBe(r.revenueFormula);
    expect(r.buyer.valueMultiple).toBeUndefined();
  });
  it('rejects a revenue variant with a missing field or an unknown model', () => {
    expect(NumberInputsSchema.safeParse(withRev({ model: 'usage', unitPrice: s(1) } as never)).success).toBe(false);
    expect(NumberInputsSchema.safeParse(withRev({ model: 'barter' } as never)).success).toBe(false);
  });
  it('accepts businessModel and rejects an unknown one', () => {
    expect(NumberInputsSchema.safeParse({ ...base, businessModel: 'usage' }).success).toBe(true);
    expect(NumberInputsSchema.safeParse({ ...base, businessModel: 'barter' }).success).toBe(false);
  });
  it('lists the new sourced inputs', () => {
    const labels = listInputs(withRev(models[0]![1], { valueToUserPerYear: s(5000) })).map((l) => l.label);
    expect(labels).toContain('revenue.gmvPerBuyerPerYear');
    expect(labels).toContain('revenue.takeRate');
    expect(labels).toContain('valueToUserPerYear');
  });
});

describe('value multiple per model (value / what the user pays)', () => {
  const cases2: [string, NonNullable<NumberInputs['revenue']>, number, number | null][] = [
    ['usage', models[1]![1], 6000, 3],
    ['freemium (paid price, not revenue per user)', models[4]![1], 600, 5],
    ['transaction_fee', models[5]![1], 1500, 2],
    ['data_sales', models[7]![1], 6000, 2],
    ['licensing', models[8]![1], 16000, 2],
    ['one_off', models[6]![1], 196, 2],
    ['service_plus_software (subscription only)', models[9]![1], 2400, 2],
    ['ads (user pays nothing)', models[2]![1], 600, null],
    ['affiliate (user pays nothing)', models[3]![1], 600, null],
  ];
  it.each(cases2)('%s', (_n, revenue, value, expected) => {
    const r = computeNumbers(withRev(revenue, { valueToUserPerYear: s(value) }));
    expect(r.buyer.valueMultiple).toBe(expected);
    if (expected === null) expect(r.buyer.valueMultipleNote).toBe('user pays nothing (ad/affiliate funded)');
    else expect(r.buyer.valueMultipleNote).toBeUndefined();
  });
  it('ads and freemium formulas say user, others say buyer', () => {
    const ads = computeNumbers(withRev(models[2]![1])).formulas.join('\n');
    expect(ads).toContain('Monthly price per user');
    expect(ads).toContain('Monthly delivery cost per user');
    expect(ads).toContain('Breakeven users');
    expect(computeNumbers(withRev(models[1]![1])).formulas.join('\n')).toContain('Monthly price per buyer');
  });
  it('freemium keeps roiMultiple on the revenue basis', () => {
    const r = computeNumbers(withRev(models[4]![1], { valueToUserPerYear: s(600) }));
    expect(r.buyer.roiMultiple).toBe(100);
  });
  it('marketplace divides by what the buyer side pays (the price fields), not the take', () => {
    const r = computeNumbers(withRev(models[0]![1], { valueToUserPerYear: s(600) }));
    expect(r.buyer.annualPrice).toBe(2000);
    expect(r.buyer.valueMultiple).toBe(5);
    expect(r.buyer.roiMultiple).toBe(0.3);
    const free = computeNumbers(withRev(models[0]![1], { price: { ...base.price, amount: s(0) }, valueToUserPerYear: s(600) }));
    expect(free.buyer.valueMultiple).toBeNull();
    expect(free.buyer.valueMultipleNote).toBe('user pays nothing');
  });
  it('raw multiple is not rounded', () => {
    expect(valueMultipleRaw({ ...base, valueToUserPerYear: s(119.9) })).toBeLessThan(1);
    expect(computeNumbers({ ...base, valueToUserPerYear: s(119.9) }).buyer.valueMultiple).toBe(1);
    expect(valueMultipleRaw(base)).toBeNull();
  });
  it('one-off: a single purchase earns the price, and zero purchases is rejected', () => {
    const r = computeNumbers(withRev({ model: 'one_off', price: s(49), purchasesPerBuyerPerYear: s(1) }));
    expect(r.buyer.annualPrice).toBe(49);
    expect(NumberInputsSchema.safeParse(withRev({ model: 'one_off', price: s(49), purchasesPerBuyerPerYear: s(0) })).success).toBe(false);
  });
  it('service_plus_software: setup fee is a separate year-1 line, not in MRR, ARR, margin or breakeven', () => {
    const r = computeNumbers(withRev(models[9]![1]));
    expect(r.buyer.setupFeePerBuyer).toBe(800);
    expect(r.unit.monthlyPricePerBuyer).toBe(100);
    expect(r.scenarios[0]!.mrr).toBe(1000);
    expect(r.market.annualRevenuePotential).toBe(1200000);
    expect(r.market.year1Revenue).toBe(20000);
    expect(r.formulas).toContain('Year 1 includes a one-time setup fee of $800 per buyer');
    expect(r.formulas).toContain('Year 1 revenue = $1,200,000 × 0.01 + 10 buyers × $800 setup = $20,000');
  });
  it('value wording: ROI and payback lines say value to the user, problem-cost lines are omitted', () => {
    const r = computeNumbers({ ...base, problemCost: [{ label: 'x', quantity: s(1), unitCost: s(1), perYear: s(1) }], valueToUserPerYear: s(600) });
    expect(r.formulas.some((f) => f.startsWith('Annual cost of x'))).toBe(false);
    expect(r.formulas.some((f) => f.startsWith('Annual savings'))).toBe(false);
    expect(r.formulas).toContain('ROI multiple = annual value to the user $600 ÷ annual price $120 = 5×');
    expect(r.formulas).toContain('Payback = annual price $120 ÷ (annual value to the user $600 ÷ 12) = 2.4 months');
  });
});

describe('value multiple', () => {
  it('uses valueToUserPerYear as annual savings and sets valueMultiple = roiMultiple', () => {
    const r = computeNumbers({ ...base, valueToUserPerYear: s(600) });
    expect(r.buyer.annualPrice).toBe(120);
    expect(r.buyer.annualSavings).toBe(600);
    expect(r.buyer.valueMultiple).toBe(5);
    expect(r.buyer.roiMultiple).toBe(5);
    expect(r.buyer.paybackMonths).toBe(2.4);
    expect(r.formulas).toContain("Value multiple = annual value to the user $600 ÷ the user's annual price $120 = 5×");
  });
  it('is below 1 when value is under price, and null when price is 0', () => {
    expect(computeNumbers({ ...base, valueToUserPerYear: s(60) }).buyer.valueMultiple).toBe(0.5);
    expect(computeNumbers({ ...base, price: { ...base.price, amount: s(0) }, valueToUserPerYear: s(60) }).buyer.valueMultiple).toBeNull();
  });
  it('combines a revenue formula with value', () => {
    const r = computeNumbers(withRev(models[7]![1], { valueToUserPerYear: s(6000) }));
    expect(r.buyer.valueMultiple).toBe(2);
    expect(r.buyer.roiMultiple).toBe(2);
  });
});

describe('old inputs are unchanged', () => {
  const snap = JSON.parse(readFileSync(new URL('./fixtures/old-results.json', import.meta.url), 'utf8'));
  it('computes exactly the results taken before the change', () => {
    expect(computeNumbers(snap.inputs)).toEqual(snap.results);
    expect(JSON.stringify(computeNumbers(snap.inputs))).not.toMatch(/valueMultiple|revenueFormula/);
  });
  it('old stored results still parse, new optional fields parse too', () => {
    const results = computeNumbers(withRev(models[1]![1], { valueToUserPerYear: s(5000) }));
    expect(results.buyer.valueMultiple).toBe(2.5);
    const draft = JSON.parse(readFileSync(new URL('../helpers/fixtures/case-draft.json', import.meta.url), 'utf8'));
    const full = (r: unknown) => ({
      ...draft,
      summary: { ...draft.summary, gateFlags: [] },
      evidence: { ...draft.evidence, signals: [] },
      numbers: { inputs: base, results: r },
    });
    expect(CaseSectionsSchema.safeParse(full(snap.results)).success).toBe(true);
    expect(CaseSectionsSchema.safeParse(full(results)).success).toBe(true);
  });
});
