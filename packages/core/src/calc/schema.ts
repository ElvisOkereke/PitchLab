import { z } from 'zod';
import { BUSINESS_MODELS } from '../pipeline/business-models';

export const SourcedSchema = z
  .object({
    value: z.number().min(0),
    source: z.object({ url: z.string().min(1), quote: z.string().min(1) }).optional(),
    assumption: z.string().optional(),
  })
  .refine(v => v.source !== undefined || (v.assumption !== undefined && v.assumption.length > 0), {
    message: 'a value needs a source or an assumption',
  });

const FractionSchema = SourcedSchema.refine(v => v.value >= 0 && v.value <= 1, {
  message: 'value must be a fraction between 0 and 1',
});

const CostLineSchema = z.object({ label: z.string(), cost: SourcedSchema });

const S = SourcedSchema;
/** One variant per business model whose revenue is not a plain price x units x periods; all fields are sourced or assumed. */
export const RevenueSchema = z.discriminatedUnion('model', [
  z.object({ model: z.literal('marketplace'), gmvPerBuyerPerYear: S, takeRate: FractionSchema }),
  z.object({ model: z.literal('usage'), unitPrice: S, unitsPerBuyerPerYear: S }),
  z.object({ model: z.literal('ads'), impressionsPerUserPerYear: S, cpm: S }),
  z.object({ model: z.literal('affiliate'), referralsPerBuyerPerYear: S, commission: S }),
  z.object({ model: z.literal('freemium'), conversionRate: FractionSchema, paidPricePerYear: S }),
  z.object({ model: z.literal('transaction_fee'), transactionsPerBuyerPerYear: S, feePerTransaction: S }),
  z.object({ model: z.literal('one_off'), price: S, repeatPurchasesPerYear: S }),
  z.object({ model: z.literal('data_sales'), pricePerClientPerYear: S }),
  z.object({ model: z.literal('licensing'), pricePerClientPerYear: S }),
  z.object({ model: z.literal('service_plus_software'), subscriptionPerYear: S, setupFee: S }),
]);
export type Revenue = z.infer<typeof RevenueSchema>;

export const NumberInputsSchema = z.object({
  /** Absent reads as subscription. */
  businessModel: z.enum(BUSINESS_MODELS).optional(),
  revenue: RevenueSchema.optional(),
  valueToUserPerYear: SourcedSchema.optional(),
  price: z.object({
    amount: SourcedSchema,
    per: z.string(),
    unitsPerBuyer: SourcedSchema,
    periodsPerYear: z.number().min(0),
  }),
  problemCost: z.array(
    z.object({ label: z.string(), quantity: SourcedSchema, unitCost: SourcedSchema, perYear: SourcedSchema }),
  ),
  expectedReduction: FractionSchema,
  reachableBuyers: SourcedSchema,
  captureRate: FractionSchema,
  deliveryCostPerBuyerMonthly: z.array(CostLineSchema),
  fixedCostsMonthly: z.array(CostLineSchema),
  scenarios: z.array(z.number().min(0)),
});

export type Sourced = z.infer<typeof SourcedSchema>;
export type NumberInputs = z.infer<typeof NumberInputsSchema>;
