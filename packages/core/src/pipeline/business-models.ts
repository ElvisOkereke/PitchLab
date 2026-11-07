import { z } from 'zod';

export const BUSINESS_MODELS = [
  'subscription', 'one_off', 'usage', 'marketplace', 'transaction_fee', 'data_sales',
  'ads', 'affiliate', 'licensing', 'freemium', 'service_plus_software',
] as const;
export type BusinessModel = (typeof BUSINESS_MODELS)[number];

export const AUDIENCES = ['business', 'consumer', 'both'] as const;
export type IdeaAudience = (typeof AUDIENCES)[number];

export const ValueToUserSchema = z.object({
  kind: z.enum(['earn', 'save', 'time', 'risk']),
  amountPerYear: z.number().finite().min(0),
  basis: z.string().min(1).max(400),
  source: z.string().max(300).optional(),
});
export type ValueToUser = z.infer<typeof ValueToUserSchema>;

export const PriceHintSchema = z.object({
  amount: z.number().finite().min(0),
  unit: z.string().min(1).max(60),
  basis: z.string().min(1).max(300),
  source: z.string().max(300).optional(),
});
export type PriceHint = z.infer<typeof PriceHintSchema>;

export const BarriersSchema = z.object({
  toStart: z.number().int().min(1).max(5),
  toStartWhy: z.string().max(300),
  toCopy: z.number().int().min(1).max(5),
  toCopyWhy: z.string().max(300),
  soloBuildable: z.boolean(),
});
export type Barriers = z.infer<typeof BarriersSchema>;

/** What kind of advantage an idea claims over today's option (ideate.v12). */
export const EDGE_KINDS = ['ai', 'cost', 'speed', 'accuracy', 'data', 'network', 'new_capability', 'distribution'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** The idea's edge (ideate.v12; a model claim): the advantage, today's option it beats, and why it is possible now. */
export const EdgeSchema = z.object({
  kind: z.enum(EDGE_KINDS),
  claim: z.string().min(1).max(300),
  versus: z.string().min(1).max(200),
  whyNow: z.string().min(1).max(300),
});
export type Edge = z.infer<typeof EdgeSchema>;

/** Who and how many buyers (ideate.v12; a model claim). `source` is a library id or signal url; otherwise the basis is an assumption. */
export const ScaleSchema = z.object({
  buyers: z.string().min(1).max(200),
  basis: z.string().min(1).max(300),
  source: z.string().max(300).optional(),
});
export type Scale = z.infer<typeof ScaleSchema>;

/** The yearly price (amount times periods per year); null when the unit cannot be annualised. A price of 0 is 0. */
export function annualPrice(priceHint: PriceHint, periodsPerYear?: number): number | null {
  if (!Number.isFinite(priceHint.amount) || priceHint.amount < 0) return null;
  const unit = priceHint.unit.trim().toLowerCase();
  // A count in the unit ("every 2 weeks", "per 6 months") is not handled: say nothing rather than guess.
  if (/\d/.test(unit)) return null;
  const year = /\b(year|yr|yearly|annual|annually)\b/.test(unit);
  const month = /\b(month|mo|monthly)\b/.test(unit);
  // A year word together with a month or week word is ambiguous ("weekly, billed annually"): say nothing.
  const week = /\b(bi-?weekly|fortnight\w*|week|wk|weekly)\b/.test(unit);
  if (year && (month || week)) return null;
  let periods: number | undefined;
  if (/\b(bi-?weekly|fortnight\w*)\b/.test(unit)) periods = 26;
  else if (/\bsemi-?annual(ly)?\b|\bhalf[- ]year(ly)?\b/.test(unit)) periods = 2;
  else if (/\bquarter(ly)?\b/.test(unit)) periods = 4;
  else if (month) periods = 12;
  else if (/\b(week|wk|weekly)\b/.test(unit)) periods = 52;
  else if (year) periods = 1;
  else if (/\b(one[- ]?time|once|one[- ]?off|flat|lifetime)\b/.test(unit)) periods = 1;
  else if (periodsPerYear && periodsPerYear > 0) periods = periodsPerYear;
  if (periods === undefined) return null;
  return priceHint.amount * periods;
}

/** Yearly value to the user divided by the yearly price; null when it cannot be worked out. */
export function valueMultiple(valueToUser: ValueToUser, priceHint: PriceHint, periodsPerYear?: number): number | null {
  if (!Number.isFinite(priceHint.amount) || !(priceHint.amount > 0)) return null;
  const price = annualPrice(priceHint, periodsPerYear);
  if (price === null) return null;
  return valueToUser.amountPerYear / price;
}

const SourcedShare = z.object({ pct: z.number().finite().min(0).max(100), basis: z.string().max(300), source: z.string().max(300).optional() });

/** The scale estimate (a model claim): who the buyers are and the share at each step. Web-safe (zod only). */
export const ScaleEstimateSchema = z.object({
  buyerUnit: z.enum(['businesses', 'individuals']),
  population: z.object({ count: z.number().finite().min(0), basis: z.string().max(300), source: z.string().max(300).optional() }),
  shareWithProblem: SourcedShare,
  shareWillingToPay: SourcedShare,
  shareReachable: z.object({ pct: z.number().finite().min(0).max(100), basis: z.string().max(300) }),
});
export type ScaleEstimate = z.infer<typeof ScaleEstimateSchema>;

export type ScaleResult = {
  payingBuyers: number;
  annualPrice: number | null;
  revenueCeiling: number | null;
  band: 1 | 2 | 3 | 4 | 5;
  /** Names of the shares that were capped. */
  capped: string[];
  /** True when no step has a source. */
  allAssumed: boolean;
};

/** A stored ScaleResult as read back from jsonb (for display and prompt text); anything else fails. */
export const ScaleResultSchema = z.object({
  payingBuyers: z.number().finite().min(0),
  annualPrice: z.number().finite().nullable(),
  revenueCeiling: z.number().finite().min(0).nullable(),
  band: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  capped: z.array(z.string()),
  allAssumed: z.boolean(),
});

const clampPct = (n: number) => (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0);
const hasSource = (s?: string) => typeof s === 'string' && s.trim() !== '';

/** Paying buyers and revenue ceiling from the estimate; an unsourced share is capped at a realistic level. */
export function computeScale(e: ScaleEstimate, priceHint: PriceHint | null): ScaleResult {
  const capped: string[] = [];
  const share = (name: string, pct: number, cap: number, source?: string) => {
    let v = clampPct(pct);
    if (!hasSource(source) && v > cap) { v = cap; capped.push(name); }
    return v / 100;
  };
  const population = Number.isFinite(e.population.count) ? Math.max(0, e.population.count) : 0;
  const problem = share('shareWithProblem', e.shareWithProblem.pct, 60, e.shareWithProblem.source);
  const pay = share('shareWillingToPay', e.shareWillingToPay.pct, e.buyerUnit === 'individuals' ? 3 : 15, e.shareWillingToPay.source);
  const reach = share('shareReachable', e.shareReachable.pct, 20);
  const payingBuyers = population * problem * pay * reach;
  const price = priceHint ? annualPrice(priceHint) : null;
  const revenueCeiling = price === null ? null : payingBuyers * price;
  const band: ScaleResult['band'] = revenueCeiling === null ? 2
    : revenueCeiling < 250_000 ? 1 : revenueCeiling < 1_000_000 ? 2 : revenueCeiling < 5_000_000 ? 3 : revenueCeiling < 25_000_000 ? 4 : 5;
  const allAssumed = ![e.population.source, e.shareWithProblem.source, e.shareWillingToPay.source].some(hasSource);
  return { payingBuyers, annualPrice: price, revenueCeiling, band, capped, allAssumed };
}

/** How much a value kind says about upside to the buyer (earn is worth most). A missing or unknown kind scores 3. */
export function upsideScore(kind: ValueToUser['kind'] | null | undefined): number {
  switch (kind) {
    case 'earn': return 5;
    case 'time': return 3;
    case 'risk': return 3;
    case 'save': return 2;
    default: return 3;
  }
}
