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
  /**
   * True when the band was lowered to 3 because the population has no source (or no step has one); the ceiling itself is
   * unchanged. Absent on results stored before this flag existed.
   */
  bandCapped?: boolean;
};

/** A stored ScaleResult as read back from jsonb (for display and prompt text); anything else fails. */
export const ScaleResultSchema = z.object({
  payingBuyers: z.number().finite().min(0),
  annualPrice: z.number().finite().nullable(),
  revenueCeiling: z.number().finite().min(0).nullable(),
  band: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  capped: z.array(z.string()),
  allAssumed: z.boolean(),
  bandCapped: z.boolean().optional(),
});

const clampPct = (n: number) => (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0);
const hasSource = (s?: string) => typeof s === 'string' && s.trim() !== '';

/** The default revenue-ceiling line: the gate kills a generated idea whose ceiling is under it (setting `gate.minRevenueCeiling`). */
export const DEFAULT_MIN_REVENUE_CEILING = 1_000_000;

/** Business models where the user pays nothing: the price hint is our revenue per user per year. */
export const USER_PAYS_NOTHING_MODELS: readonly string[] = ['ads', 'affiliate'];
/** True for ads and affiliate, where step 3 of the scale estimate is the share who become regular users. */
export const userPaysNothing = (businessModel?: string | null) => !!businessModel && USER_PAYS_NOTHING_MODELS.includes(businessModel);
/** The highest band an estimate gets when its population has no source (or no step has one). */
export const UNSOURCED_MAX_BAND = 3;

/** The shares as used, in percent (0-100) after clamping and the caps for unsourced shares, plus the names that were capped. */
export type ScaleShares = { shareWithProblem: number; shareWillingToPay: number; shareReachable: number; capped: string[] };

/**
 * The unsourced cap on step 3 (`shareWillingToPay`). Normally the share who would pay: individuals 3%, businesses 15%.
 * For ads and affiliate (the user pays nothing) it is the share who become regular users: individuals 10%, businesses 30%.
 */
export function willingToPayCap(buyerUnit: ScaleEstimate['buyerUnit'], businessModel?: string | null): number {
  if (userPaysNothing(businessModel)) return buyerUnit === 'individuals' ? 10 : 30;
  return buyerUnit === 'individuals' ? 3 : 15;
}

/** The shares computeScale multiplies, in percent: clamped to 0-100, and an unsourced share capped at a realistic level. */
export function scaleShares(e: ScaleEstimate, businessModel?: string | null): ScaleShares {
  const capped: string[] = [];
  const share = (name: string, pct: number, cap: number, source?: string) => {
    let v = clampPct(pct);
    if (!hasSource(source) && v > cap) { v = cap; capped.push(name); }
    return v;
  };
  const shareWithProblem = share('shareWithProblem', e.shareWithProblem.pct, 60, e.shareWithProblem.source);
  const shareWillingToPay = share('shareWillingToPay', e.shareWillingToPay.pct, willingToPayCap(e.buyerUnit, businessModel), e.shareWillingToPay.source);
  const shareReachable = share('shareReachable', e.shareReachable.pct, 20);
  return { shareWithProblem, shareWillingToPay, shareReachable, capped };
}

/**
 * Paying buyers and revenue ceiling from the estimate; an unsourced share is capped at a realistic level. A price of 0
 * is unknown (a free product earns another way): no ceiling, band 2, like a price that cannot be annualised. For ads and
 * affiliate (`businessModel`), step 3 is the share who become regular users and the price is our revenue per user.
 * When the population has no source (or no step has one) the band is capped at 3; the ceiling is unchanged.
 */
export function computeScale(e: ScaleEstimate, priceHint: PriceHint | null, businessModel?: string | null): ScaleResult {
  const { shareWithProblem, shareWillingToPay, shareReachable, capped } = scaleShares(e, businessModel);
  const population = Number.isFinite(e.population.count) ? Math.max(0, e.population.count) : 0;
  const payingBuyers = population * (shareWithProblem / 100) * (shareWillingToPay / 100) * (shareReachable / 100);
  const annual = priceHint ? annualPrice(priceHint) : null;
  const price = annual === 0 ? null : annual;
  const revenueCeiling = price === null ? null : payingBuyers * price;
  const raw: ScaleResult['band'] = revenueCeiling === null ? 2
    : revenueCeiling < 250_000 ? 1 : revenueCeiling < 1_000_000 ? 2 : revenueCeiling < 5_000_000 ? 3 : revenueCeiling < 25_000_000 ? 4 : 5;
  const allAssumed = ![e.population.source, e.shareWithProblem.source, e.shareWillingToPay.source].some(hasSource);
  const bandCapped = (allAssumed || !hasSource(e.population.source)) && raw > UNSOURCED_MAX_BAND;
  const band = bandCapped ? UNSOURCED_MAX_BAND : raw;
  return { payingBuyers, annualPrice: price, revenueCeiling, band, capped, allAssumed, bandCapped };
}

const StoredPriceSchema = z.object({ amount: z.number().finite(), unit: z.string() }).passthrough();

/** True when the stored price hint is 0 a year (a free product): its revenue ceiling is unknown, not $0. */
export function priceIsFree(priceHint: unknown): boolean {
  const price = StoredPriceSchema.safeParse(priceHint);
  return price.success && annualPrice(price.data as PriceHint) === 0;
}

/** The revenue ceiling's wording when it is unknown because the price is 0. */
export const FREE_PRICE_CEILING_NOTE = 'unknown: the price is 0 (a free product earns another way)';

/** The idea fields currentScale reads (stored jsonb, so validated here). */
export type ScaleFields = { scaleEstimate: unknown; scaleResult: unknown; priceHint: unknown; businessModel?: string | null };

/**
 * The scale result as it stands now: computeScale on the stored estimate (with the idea's price hint and business model)
 * when the estimate is valid, else the validated stored result, else null. The screen and the gate both use it, so they
 * can never disagree; ideate and the estimator store computeScale's result with the same inputs.
 */
export function currentScale(idea: ScaleFields): ScaleResult | null {
  const est = ScaleEstimateSchema.safeParse(idea.scaleEstimate);
  if (est.success) {
    // Only the amount and unit matter here; a stored hint with an odd basis still prices the idea.
    const price = StoredPriceSchema.safeParse(idea.priceHint);
    return computeScale(est.data, price.success ? (price.data as PriceHint) : null, idea.businessModel ?? null);
  }
  const stored = ScaleResultSchema.safeParse(idea.scaleResult);
  return stored.success ? stored.data : null;
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
