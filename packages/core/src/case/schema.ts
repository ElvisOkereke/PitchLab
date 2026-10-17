import { z } from 'zod';
import type { NumberResults } from '../calc/numbers';
import { NumberInputsSchema } from '../calc/schema';

/** AI-scored screening criteria (`gut` is owner-only and added elsewhere). */
export const CRITERIA = ['pain', 'roi', 'evidence', 'speed', 'autonomy', 'novelty', 'reach'] as const;
export type Criterion = (typeof CRITERIA)[number];

const criterionScore = z.object({ value: z.number().int().min(1).max(5), note: z.string() });

export const AiScoresSchema = z.object({
  pain: criterionScore,
  roi: criterionScore,
  evidence: criterionScore,
  speed: criterionScore,
  autonomy: criterionScore,
  novelty: criterionScore,
  reach: criterionScore,
});
export type AiScores = z.infer<typeof AiScoresSchema>;

// ---- Case sections -------------------------------------------------------------------------------
// The LLM writes a CaseDraft; code adds summary.gateFlags and numbers.results to make CaseSections.
// No transforms (R9): CaseDraftSchema is passed to router.structured.

const nonEmpty = z.string().min(1);

const summaryShape = {
  oneLiner: z.string(),
  buyer: z.string(),
  problem: z.string(),
  solution: z.string(),
  price: z.object({ amount: z.number().min(0), per: z.string(), rationale: z.string() }),
  whyNow: z.string(),
  whyItWins: z.string(),
  nextAction: z.string(),
};

const EvidenceSchema = z.object({
  signals: z.array(z.object({ quote: nonEmpty, url: nonEmpty, sourceName: z.string() })),
  claims: z.array(z.object({ text: nonEmpty, sourceUrl: nonEmpty, quote: nonEmpty })).min(3),
});

const CompetitorsSchema = z.object({
  list: z.array(z.object({ name: z.string(), url: z.string(), pricing: z.string(), gap: z.string() })),
  levels: z.array(z.object({ level: z.string(), whatItChecks: z.string(), limitation: z.string() })).min(2),
});

const emailSchema = z.object({ subject: z.string(), body: z.string() });
const PitchSchema = z.object({
  elevator: z.string(),
  emails: z.array(emailSchema).length(3),
  followUps: z.array(emailSchema).length(2),
  callScript: z.string(),
  objections: z.array(z.object({ objection: z.string(), response: z.string() })),
  pricingCopy: z.string(),
});

const num = z.number();
const numOrNull = z.number().nullable();

/** Mirrors `NumberResults` from calc/numbers (checked at compile time below). */
export const NumberResultsSchema = z.object({
  buyer: z.object({
    annualPrice: num, annualProblemCost: num, annualSavings: num, roiMultiple: numOrNull, paybackMonths: numOrNull,
  }),
  market: z.object({ annualRevenuePotential: num, year1Revenue: num }),
  unit: z.object({ monthlyPricePerBuyer: num, monthlyDeliveryCost: num, grossMarginPct: numOrNull }),
  scenarios: z.array(z.object({ buyers: num, mrr: num, arr: num, monthlyGrossProfit: num, monthlyNet: num })),
  breakevenBuyers: numOrNull,
  breakevenReason: z.string().optional(),
  formulas: z.array(z.string()),
});

/** What the case writer returns. `numbers.results` and `summary.gateFlags` are not in it: code adds them. */
export const CaseDraftSchema = z
  .object({
    title: nonEmpty,
    summary: z.object(summaryShape),
    evidence: EvidenceSchema,
    numbers: z.object({ inputs: NumberInputsSchema }),
    competitors: CompetitorsSchema,
    pitch: PitchSchema,
  })
  .refine((d) => d.summary.price.amount === d.numbers.inputs.price.amount.value, {
    message: 'summary.price.amount must equal numbers.inputs.price.amount.value',
    path: ['summary', 'price', 'amount'],
  });
export type CaseDraft = z.infer<typeof CaseDraftSchema>;

/** The stored `cases.sections` shape. */
export const CaseSectionsSchema = z.object({
  summary: z.object({ ...summaryShape, gateFlags: z.array(z.string()) }),
  evidence: EvidenceSchema,
  numbers: z.object({ inputs: NumberInputsSchema, results: NumberResultsSchema }),
  competitors: CompetitorsSchema,
  pitch: PitchSchema,
});
export type CaseSections = z.infer<typeof CaseSectionsSchema>;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _resultsMatch: Same<z.infer<typeof NumberResultsSchema>, NumberResults> = true;
void _resultsMatch;
