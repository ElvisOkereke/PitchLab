import { z } from 'zod';

export const SourcedSchema = z
  .object({
    value: z.number().min(0),
    source: z.object({ url: z.string(), quote: z.string() }).optional(),
    assumption: z.string().optional(),
  })
  .refine(v => v.source !== undefined || (v.assumption !== undefined && v.assumption.length > 0), {
    message: 'a value needs a source or an assumption',
  });

const FractionSchema = SourcedSchema.refine(v => v.value >= 0 && v.value <= 1, {
  message: 'value must be a fraction between 0 and 1',
});

const CostLineSchema = z.object({ label: z.string(), cost: SourcedSchema });

export const NumberInputsSchema = z.object({
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
