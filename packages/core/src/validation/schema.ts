import { z } from 'zod';

// Structured-output schemas for the validation pack. No transforms (R9): refinements only.

const text = z.string().min(1);
const list = z.array(text);

export const MvpSpecSchema = z.object({
  summary: text,
  features: z.array(z.object({ name: text, why: text, manualAtFirst: z.boolean() })).min(3).max(8),
  architectureSketch: text,
  buildEstimate: z
    .object({ lowDays: z.number().min(0), highDays: z.number().min(0), assumptions: list })
    .refine((e) => e.highDays >= e.lowDays, { message: 'highDays must be at least lowDays', path: ['highDays'] }),
  fakeOrManualFirst: list,
  risks: list,
  packaging: text,
});
export type MvpSpec = z.infer<typeof MvpSpecSchema>;

export const PilotPlanSchema = z.object({
  idealPilotCustomer: text,
  firstStep: text,
  steps: list.min(3).max(8),
  measures: z.array(z.object({ metric: text, successThreshold: text })).min(2),
  timelineWeeks: z.number().int().min(1).max(52),
  permissionsAndRisks: list,
});
export type PilotPlan = z.infer<typeof PilotPlanSchema>;

export const InterviewKitSchema = z.object({
  targetRoles: list.min(1),
  whereToFind: list.min(1),
  opening: text,
  questions: z.array(z.object({ question: text, whyAsk: text, listenFor: text })).min(8),
  redFlags: list,
});
export type InterviewKit = z.infer<typeof InterviewKitSchema>;

/** Metrics the checklist can track; each is computed by code from tracked outreach and landing data. */
export const CHECKLIST_METRIC_KEYS = ['emails_sent', 'positive_replies', 'meetings', 'interviews_done', 'landing_conversion_pct'] as const;
export type ChecklistMetricKey = (typeof CHECKLIST_METRIC_KEYS)[number];

/** Default go/no-go gates (spec §6.3); the prompt offers them and the model may adjust them to the case. */
export const DEFAULT_CHECKLIST_GATES: readonly { id: string; description: string; metricKey: ChecklistMetricKey; threshold: number }[] = [
  { id: 'emails-sent', description: 'Send at least 50 personalised cold emails', metricKey: 'emails_sent', threshold: 50 },
  { id: 'positive-replies', description: 'At least 3 positive replies from 50 emails', metricKey: 'positive_replies', threshold: 3 },
  { id: 'meetings', description: 'At least 2 discovery calls booked', metricKey: 'meetings', threshold: 2 },
  { id: 'interviews', description: 'At least 5 buyer interviews done', metricKey: 'interviews_done', threshold: 5 },
  { id: 'landing-conversion', description: 'At least 5% of landing page visitors leave their email', metricKey: 'landing_conversion_pct', threshold: 5 },
];

export const ChecklistSchema = z.object({
  gates: z
    .array(z.object({ id: text, description: text, metricKey: z.enum(CHECKLIST_METRIC_KEYS), threshold: z.number().min(0) }))
    .min(1)
    .refine((gates) => new Set(gates.map((g) => g.id)).size === gates.length, { message: 'gate ids must be unique' }),
});
export type Checklist = z.infer<typeof ChecklistSchema>;

/** What one `pack` call returns and what `validation_packs.sections` stores. */
export const PackDocsSchema = z.object({
  mvpSpec: MvpSpecSchema,
  pilotPlan: PilotPlanSchema,
  interviewKit: InterviewKitSchema,
  checklist: ChecklistSchema,
});
export type PackDocs = z.infer<typeof PackDocsSchema>;
