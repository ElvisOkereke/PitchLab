import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listInputs } from '../../src/calc/inputs';
import { computeNumbers } from '../../src/calc/numbers';
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
  ['one_off', { model: 'one_off', price: s(49), repeatPurchasesPerYear: s(2) }, 98, 'purchases'],
  ['data_sales', { model: 'data_sales', pricePerClientPerYear: s(3000) }, 3000, 'client'],
  ['licensing', { model: 'licensing', pricePerClientPerYear: s(8000) }, 8000, 'client'],
  ['service_plus_software', { model: 'service_plus_software', subscriptionPerYear: s(1200), setupFee: s(800) }, 2000, 'setup'],
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

describe('value multiple', () => {
  it('uses valueToUserPerYear as annual savings and sets valueMultiple = roiMultiple', () => {
    const r = computeNumbers({ ...base, valueToUserPerYear: s(600) });
    expect(r.buyer.annualPrice).toBe(120);
    expect(r.buyer.annualSavings).toBe(600);
    expect(r.buyer.valueMultiple).toBe(5);
    expect(r.buyer.roiMultiple).toBe(5);
    expect(r.buyer.paybackMonths).toBe(2.4);
    expect(r.formulas).toContain('Value multiple = annual value to the user $600 ÷ annual price $120 = 5×');
  });
  it('is below 1 when value is under price, and null when price is 0', () => {
    expect(computeNumbers({ ...base, valueToUserPerYear: s(60) }).buyer.valueMultiple).toBe(0.5);
    expect(computeNumbers({ ...base, price: { ...base.price, amount: s(0) }, valueToUserPerYear: s(60) }).buyer.valueMultiple).toBeNull();
  });
  it('combines a revenue formula with value', () => {
    const r = computeNumbers(withRev(models[7]![1], { valueToUserPerYear: s(6000) }));
    expect(r.buyer.valueMultiple).toBe(2);
  });
});

describe('old inputs are unchanged', () => {
  const snap = JSON.parse(readFileSync(new URL('./fixtures/old-results.json', import.meta.url), 'utf8'));
  it('computes exactly the results taken before the change', () => {
    expect(computeNumbers(snap.inputs)).toEqual(snap.results);
    expect(JSON.stringify(computeNumbers(snap.inputs))).not.toMatch(/valueMultiple|revenueFormula/);
  });
  it('old stored results still parse, new optional fields parse too', () => {
    const results = computeNumbers(withRev(models[0]![1], { valueToUserPerYear: s(5000) }));
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
