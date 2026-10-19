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

const NUM = String.raw`\d+(?:[.,]\d+)*`;
const CURRENCY_CODE = String.raw`(?:USD|CAD|EUR|GBP|AUD|NZD)`;
const BILLING_UNIT = String.raw`(?:mo|mos|month|months|yr|yrs|year|years|user|seat|site|location)`;
// A percentage ("20%", "5-10%", "20 to 30 percent", "25 per cent") is a price only next to fee vocabulary:
// "99.9% uptime", "grew 30%" and "30% discount" are not.
const PCT = String.raw`${NUM}(?:\s*(?:-|–|to)\s*${NUM})?\s?(?:%|percent\b|per\s?cent\b)`;
const FEE_BEFORE = String.raw`\b(?:fees?|commissions?|contingency|takes?|charges?|cut|share|rate)\b\W*(?:\w+\W+){0,2}`;
const FEE_AFTER = String.raw`\s*(?:of\s+(?:the\s+)?(?:recovered|savings|spend|media spend|ad spend|revenue|sales|credits|claims|invoices?|amount|collected)\b|contingency\b|commissions?\b|fees?\b)`;
const PRICE_PATTERNS = [
  new RegExp(String.raw`[$€£¥]\s?${NUM}`), // $49, CA$29, US$35.00, €10, £5
  new RegExp(String.raw`${NUM}\s?[$€£¥]`), // 10 €
  new RegExp(String.raw`\b${CURRENCY_CODE}\s?${NUM}`, 'i'), // USD 15
  new RegExp(String.raw`${NUM}\s?${CURRENCY_CODE}\b`, 'i'), // 49 USD
  new RegExp(String.raw`${NUM}\s*(?:\/\s*${BILLING_UNIT}\b|per\s+${BILLING_UNIT}\b)`, 'i'), // 29/mo, 29 per month, 5 per seat
  new RegExp(FEE_BEFORE + PCT, 'i'), // fee: 20%, takes a 15% cut, contingency rate 25–35%
  new RegExp(PCT + FEE_AFTER, 'i'), // 10% commission, 5-10% of media spend, 15 percent of recovered credits
  // "Free" / "free tier" / "free plan" is a published price; a free trial, demo or consultation is not.
  /\bfree\b(?!\s+(?:trial|demo|consultation|quote|estimate|audit|assessment)s?\b)/i,
];

/**
 * True when a competitor's pricing text states a concrete published price, so a `competitor-pricing` claim can be
 * checked: a currency symbol or code next to a number ("$49", "49 USD", "CA$29", "€10"), a number with a billing unit
 * ("29/mo", "5 per seat"), a percentage next to fee vocabulary ("20% fee", "15 percent of recovered credits"), or a free
 * plan ("Free", "free tier"). Bare numbers ("first 150 testers", "10+ seats", "up to 5 users") and bare percentages
 * ("20%", "99.9% uptime", "30% discount") are not.
 */
export const hasPriceFigure = (pricing: string) => PRICE_PATTERNS.some((re) => re.test(pricing));

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
    usedSignalUrls: z.array(z.string().max(2000)).max(30),
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
