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

const claimsSchema = z.array(z.object({ text: nonEmpty, sourceUrl: nonEmpty, quote: nonEmpty })).min(3);
/** Evidence signals are rebuilt by code from the idea's real signal rows, so the draft only carries claims. */
const EvidenceDraftSchema = z.object({ claims: claimsSchema });
const EvidenceSchema = z.object({
  signals: z.array(z.object({ quote: z.string(), url: z.string(), sourceName: z.string() })),
  claims: claimsSchema,
});

const CompetitorsSchema = z.object({
  list: z.array(z.object({ name: z.string(), url: z.string(), pricing: z.string(), gap: z.string() })),
  levels: z.array(z.object({ level: z.string(), whatItChecks: z.string(), limitation: z.string() })).min(2),
});

/** True when a competitor's pricing text quotes a concrete figure ("$49/mo"), so a pricing claim can be checked. */
export const hasPriceFigure = (pricing: string) => /\d/.test(pricing);

/** The `competitor-pricing` claim text; deep-case stores it and the export looks it up by the same string. */
export const competitorPricingText = (c: { name: string; pricing: string }) => `${c.name} pricing: ${c.pricing}`;

/** CASL / CAN-SPAM (spec §11.6): sender name, mailing address, one other contact method, unsubscribe line. */
export const CASL_PLACEHOLDERS = ['[Your name]', '[Mailing address]', '[Phone or website]', '[Unsubscribe line]'] as const;

const emailSchema = z.object({
  subject: z.string(),
  body: z.string().refine((b) => CASL_PLACEHOLDERS.every((p) => b.includes(p)), {
    message: `email body must contain each placeholder: ${CASL_PLACEHOLDERS.join(', ')}`,
  }),
});
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

/**
 * What the case writer returns. `numbers.results`, `summary.gateFlags` and `evidence.signals` are not in it: code adds
 * them (evidence signals from the real rows named in `usedSignalUrls`, which is not stored in the sections).
 */
export const CaseDraftSchema = z
  .object({
    title: nonEmpty,
    summary: z.object(summaryShape),
    evidence: EvidenceDraftSchema,
    /** URLs of the provided signals the writer actually relied on; code keeps only real, provided signal rows. */
    usedSignalUrls: z.array(z.string()),
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
