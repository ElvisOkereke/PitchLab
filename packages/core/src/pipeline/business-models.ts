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

/** Yearly value to the user divided by the yearly price; null when it cannot be worked out. */
export function valueMultiple(valueToUser: ValueToUser, priceHint: PriceHint, periodsPerYear?: number): number | null {
  if (!Number.isFinite(priceHint.amount) || !(priceHint.amount > 0)) return null;
  const unit = priceHint.unit.trim().toLowerCase();
  // A count in the unit ("every 2 weeks", "per 6 months") is not handled: say nothing rather than guess.
  if (/\d/.test(unit)) return null;
  const year = /\b(year|yr|yearly|annual|annually)\b/.test(unit);
  const month = /\b(month|mo|monthly)\b/.test(unit);
  if (year && month) return null;
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
  return valueToUser.amountPerYear / (priceHint.amount * periods);
}
