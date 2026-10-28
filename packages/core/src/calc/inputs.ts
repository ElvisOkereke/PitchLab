import type { NumberInputs, Sourced } from './schema';

export type LabelledInput = { label: string; sourced: Sourced };

/** Every Sourced value in NumberInputs, in schema order, labelled with a readable path (plus the line label for list items). */
export function listInputs(i: NumberInputs): LabelledInput[] {
  const out: LabelledInput[] = [
    { label: 'price.amount', sourced: i.price.amount },
    { label: 'price.unitsPerBuyer', sourced: i.price.unitsPerBuyer },
  ];
  if (i.revenue) {
    const { model: _m, ...fields } = i.revenue;
    for (const [key, sourced] of Object.entries(fields)) out.push({ label: `revenue.${key}`, sourced: sourced as Sourced });
  }
  if (i.valueToUserPerYear) out.push({ label: 'valueToUserPerYear', sourced: i.valueToUserPerYear });
  i.problemCost.forEach((line, n) => {
    for (const key of ['quantity', 'unitCost', 'perYear'] as const) {
      out.push({ label: `problemCost[${n}].${key} (${line.label})`, sourced: line[key] });
    }
  });
  out.push(
    { label: 'expectedReduction', sourced: i.expectedReduction },
    { label: 'reachableBuyers', sourced: i.reachableBuyers },
    { label: 'captureRate', sourced: i.captureRate },
  );
  for (const key of ['deliveryCostPerBuyerMonthly', 'fixedCostsMonthly'] as const) {
    i[key].forEach((line, n) => out.push({ label: `${key}[${n}] (${line.label})`, sourced: line.cost }));
  }
  return out;
}
