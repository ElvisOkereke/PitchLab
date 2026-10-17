import type { NumberInputs } from './schema';

export type NumberResults = {
  buyer: {
    annualPrice: number;
    annualProblemCost: number;
    annualSavings: number;
    roiMultiple: number | null;
    paybackMonths: number | null;
  };
  market: { annualRevenuePotential: number; year1Revenue: number };
  unit: { monthlyPricePerBuyer: number; monthlyDeliveryCost: number; grossMarginPct: number | null };
  scenarios: { buyers: number; mrr: number; arr: number; monthlyGrossProfit: number; monthlyNet: number }[];
  breakevenBuyers: number | null;
  breakevenReason?: string;
  formulas: string[];
};

const DEFAULT_SCENARIOS = [10, 50, 200];

/** Coerce non-finite results to 0 so NaN/Infinity can never leak out. */
const fin = (x: number) => (Number.isFinite(x) ? x : 0);
const cents = (x: number) => Math.round(fin(x) * 100) / 100;
const round2 = cents;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

const usd = (x: number) => {
  const c = cents(x);
  const whole = Number.isInteger(c);
  return (c < 0 ? '-$' : '$') + Math.abs(c).toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  });
};
const plain = (x: number) => String(round2(x));

export function computeNumbers(i: NumberInputs): NumberResults {
  const amount = fin(i.price.amount.value);
  const units = fin(i.price.unitsPerBuyer.value);
  const periods = fin(i.price.periodsPerYear);
  const annualPriceRaw = fin(amount * units * periods);

  const problemLines = i.problemCost.map(l => ({
    label: l.label,
    q: fin(l.quantity.value),
    u: fin(l.unitCost.value),
    y: fin(l.perYear.value),
  }));
  const annualProblemRaw = sum(problemLines.map(l => fin(l.q * l.u * l.y)));
  const reduction = fin(i.expectedReduction.value);
  const annualSavingsRaw = fin(annualProblemRaw * reduction);

  const roi = annualPriceRaw === 0 ? null : round2(annualSavingsRaw / annualPriceRaw);
  const payback = annualSavingsRaw === 0 ? null : round2(annualPriceRaw / (annualSavingsRaw / 12));

  const monthlyPriceRaw = annualPriceRaw / 12;
  const deliveryRaw = sum(i.deliveryCostPerBuyerMonthly.map(l => fin(l.cost.value)));
  const fixedRaw = sum(i.fixedCostsMonthly.map(l => fin(l.cost.value)));
  const marginPerBuyer = monthlyPriceRaw - deliveryRaw;
  const grossMarginPct = monthlyPriceRaw === 0 ? null : round2((marginPerBuyer / monthlyPriceRaw) * 100);

  const reachable = fin(i.reachableBuyers.value);
  const capture = fin(i.captureRate.value);
  const potentialRaw = fin(reachable * annualPriceRaw);
  const year1Raw = fin(potentialRaw * capture);

  const buyerCounts = i.scenarios && i.scenarios.length > 0 ? i.scenarios : DEFAULT_SCENARIOS;
  const scenarios = buyerCounts.map(buyers => {
    const mrr = fin(buyers * monthlyPriceRaw);
    const gross = fin(buyers * marginPerBuyer);
    return {
      buyers,
      mrr: cents(mrr),
      arr: cents(mrr * 12),
      monthlyGrossProfit: cents(gross),
      monthlyNet: cents(gross - fixedRaw),
    };
  });

  let breakevenBuyers: number | null = null;
  let breakevenReason: string | undefined;
  if (marginPerBuyer <= 0) {
    breakevenReason = 'price does not cover delivery cost';
  } else {
    // small epsilon guards against float noise pushing an exact quotient up a whole buyer
    breakevenBuyers = Math.max(0, Math.ceil(fin(fixedRaw / marginPerBuyer) - 1e-9));
  }

  const formulas: string[] = [
    `Annual price = ${usd(amount)} × ${plain(units)} × ${plain(periods)} = ${usd(annualPriceRaw)}`,
    ...problemLines.map(
      l => `Annual cost of ${l.label} = ${plain(l.q)} × ${usd(l.u)} × ${plain(l.y)} = ${usd(l.q * l.u * l.y)}`,
    ),
    `Annual problem cost = ${usd(annualProblemRaw)}`,
    `Annual savings = ${usd(annualProblemRaw)} × ${plain(reduction)} = ${usd(annualSavingsRaw)}`,
    roi === null
      ? `ROI multiple: n/a (annual price is ${usd(annualPriceRaw)})`
      : `ROI multiple = annual savings ${usd(annualSavingsRaw)} ÷ annual price ${usd(annualPriceRaw)} = ${roi}×`,
    payback === null
      ? `Payback: n/a (annual savings are ${usd(annualSavingsRaw)})`
      : `Payback = annual price ${usd(annualPriceRaw)} ÷ (annual savings ${usd(annualSavingsRaw)} ÷ 12) = ${payback} months`,
    `Monthly price per buyer = ${usd(annualPriceRaw)} / 12 = ${usd(monthlyPriceRaw)}`,
    `Monthly delivery cost per buyer = ${usd(deliveryRaw)}`,
    grossMarginPct === null
      ? `Gross margin: n/a (monthly price is ${usd(monthlyPriceRaw)})`
      : `Gross margin = (monthly price ${usd(monthlyPriceRaw)} − delivery ${usd(deliveryRaw)}) ÷ ${usd(monthlyPriceRaw)} = ${grossMarginPct}%`,
    `Annual revenue potential = ${plain(reachable)} × ${usd(annualPriceRaw)} = ${usd(potentialRaw)}`,
    `Year 1 revenue = ${usd(potentialRaw)} × ${plain(capture)} = ${usd(year1Raw)}`,
    breakevenBuyers === null
      ? `Breakeven buyers: none (${breakevenReason})`
      : `Breakeven buyers = ceil(${usd(fixedRaw)} / (${usd(monthlyPriceRaw)} - ${usd(deliveryRaw)})) = ${breakevenBuyers}`,
  ];

  return {
    buyer: {
      annualPrice: cents(annualPriceRaw),
      annualProblemCost: cents(annualProblemRaw),
      annualSavings: cents(annualSavingsRaw),
      roiMultiple: roi,
      paybackMonths: payback,
    },
    market: { annualRevenuePotential: cents(potentialRaw), year1Revenue: cents(year1Raw) },
    unit: { monthlyPricePerBuyer: cents(monthlyPriceRaw), monthlyDeliveryCost: cents(deliveryRaw), grossMarginPct },
    scenarios,
    breakevenBuyers,
    ...(breakevenReason ? { breakevenReason } : {}),
    formulas,
  };
}
