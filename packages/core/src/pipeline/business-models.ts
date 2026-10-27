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
  amountPerYear: z.number().min(0),
  basis: z.string().min(1).max(400),
  source: z.string().max(300).optional(),
});
export type ValueToUser = z.infer<typeof ValueToUserSchema>;

export const PriceHintSchema = z.object({
  amount: z.number().min(0),
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
  if (!(priceHint.amount > 0)) return null;
  const unit = priceHint.unit.trim().toLowerCase();
  let periods: number | undefined;
  if (/\b(month|mo|monthly)\b/.test(unit)) periods = 12;
  else if (/\b(week|wk|weekly)\b/.test(unit)) periods = 52;
  else if (/\b(year|yr|annual|yearly)\b/.test(unit)) periods = 1;
  else if (/(one[- ]?time|once|one[- ]?off|flat)/.test(unit)) periods = 1;
  else if (periodsPerYear && periodsPerYear > 0) periods = periodsPerYear;
  if (periods === undefined) return null;
  return valueToUser.amountPerYear / (priceHint.amount * periods);
}
