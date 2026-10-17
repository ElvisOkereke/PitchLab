import { describe, expect, it } from 'vitest';
import { listInputs } from '../../src/calc/inputs';
import type { NumberInputs } from '../../src/calc/schema';

const s = (value: number) => ({ value, assumption: 'a' });
const src = (value: number) => ({ value, source: { url: 'https://x.example', quote: 'q' } });

const inputs: NumberInputs = {
  price: { amount: src(8), per: 'site', unitsPerBuyer: s(40), periodsPerYear: 12 },
  problemCost: [
    { label: 'lost leads from broken forms', quantity: s(6), unitCost: src(400), perYear: s(40) },
    { label: 'support time', quantity: s(2), unitCost: s(50), perYear: s(12) },
  ],
  expectedReduction: s(0.5),
  reachableBuyers: src(3000),
  captureRate: s(0.01),
  deliveryCostPerBuyerMonthly: [{ label: 'infra+LLM', cost: s(30) }, { label: 'hosting', cost: src(10) }],
  fixedCostsMonthly: [{ label: 'domain', cost: s(2) }],
  scenarios: [10],
};

describe('listInputs', () => {
  it('yields every Sourced input with a readable path label, in schema order', () => {
    expect(listInputs(inputs).map((x) => x.label)).toEqual([
      'price.amount',
      'price.unitsPerBuyer',
      'problemCost[0].quantity (lost leads from broken forms)',
      'problemCost[0].unitCost (lost leads from broken forms)',
      'problemCost[0].perYear (lost leads from broken forms)',
      'problemCost[1].quantity (support time)',
      'problemCost[1].unitCost (support time)',
      'problemCost[1].perYear (support time)',
      'expectedReduction',
      'reachableBuyers',
      'captureRate',
      'deliveryCostPerBuyerMonthly[0] (infra+LLM)',
      'deliveryCostPerBuyerMonthly[1] (hosting)',
      'fixedCostsMonthly[0] (domain)',
    ]);
  });

  it('returns the Sourced object itself so callers can read value/source', () => {
    const sourced = listInputs(inputs).filter((x) => x.sourced.source);
    expect(sourced.map((x) => [x.label, x.sourced.value])).toEqual([
      ['price.amount', 8],
      ['problemCost[0].unitCost (lost leads from broken forms)', 400],
      ['reachableBuyers', 3000],
      ['deliveryCostPerBuyerMonthly[1] (hosting)', 10],
    ]);
    expect(sourced[0]!.sourced).toBe(inputs.price.amount);
  });
});
