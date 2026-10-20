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

// Pilot-plan tripwire (rulings P3-R1, P3-R2). The plan is advisory text the owner reads; the system never executes it.
// Best-effort tripwire for advisory text, not a complete guarantee.
const THIRD_PARTY_ACTIONS = [
  String.raw`submit(?:s|ted|ting)?`,
  String.raw`fill(?:s|ed|ing)?(?:\s+(?:in|out))?`,
  String.raw`test[\s-]+leads?`,
  String.raw`prob(?:e|es|ed|ing|ers?)`,
  // Explicit forms (not scan\w*) so "scanner(s)" matches but "scandal" does not.
  String.raw`scan(?:s|ned|ning|ners?)?`,
  String.raw`scrap(?:e|es|ed|er|ers|ing)`,
  String.raw`stress[\s-]?test\w*`,
  String.raw`exploit\w*`,
  String.raw`phish\w*`,
  String.raw`crawl(?:s|ed|er|ers|ing)?`,
  String.raw`spider(?:s|ed|ing)?`,
  String.raw`enumerat\w*`,
  String.raw`fuzz\w*`,
  String.raw`brute[\s-]?forc\w*`,
  String.raw`pen(?:etration)?[\s-]?test\w*`,
  String.raw`sign(?:s|ed|ing)?[\s-]*up`,
  String.raw`log(?:s|ged|ging)?[\s-]*(?:in|on)(?:to)?`,
  String.raw`logins?`,
  String.raw`regist(?:er|ers|ered|ering|ration)`,
  String.raw`creat(?:e|es|ed|ing)\s+(?:an?\s+)?accounts?`,
  String.raw`authenticat\w*`,
  String.raw`(?:send(?:s|ing)?|sent)\s+(?:an?\s+)?(?:test\s+)?(?:requests?|e-?mails?|sms|messages?)`,
  String.raw`test[\s-]+(?:e-?mails?|messages?)`,
  String.raw`call(?:s|ed|ing)?\b.{0,30}?\bapis?`,
  String.raw`harvest\w*`,
];
/** Wording that means acting on someone else's site, systems or contacts. */
export const THIRD_PARTY_ACTION = new RegExp(String.raw`\b(?:${THIRD_PARTY_ACTIONS.join('|')})\b`, 'i');
const PERMISSION_WORD = /\b(?:permission|consent(?:s|ed|ing)?|authori[sz](?:e|es|ed|ing|ation|ations)|agreed)\b/gi;
/** A negation shortly before the keyword ("no", "without", "don't need" … permission). */
const NEGATION_BEFORE = /\b(?:no|without|not|never|don['’]?t|doesn['’]?t|unnecessary|needless)\b/i;
/** A negation right after the keyword ("permission is not required", "consent unnecessary"). */
const NEGATION_AFTER = /^\W*(?:(?:is|are|was|were)\s+)?(?:not\s+(?:required|needed|necessary)|unnecessary|needless|optional)\b/i;
const NEGATION_WINDOW = 20;
/** A prohibition earlier in the clause turns "without … permission" into a rule: "Never submit test leads without permission". */
const PROHIBITION = /\b(?:never|no|do\s+not|don['’]?t|must\s+not|may\s+not|cannot|can['’]?t)\b/i;

/** True when `clause` (text before a permission keyword) reads "<prohibition> … without …" with "without" near the keyword. */
function isProhibitionWithout(clause: string): boolean {
  const near = clause.slice(-NEGATION_WINDOW);
  const w = near.search(/\bwithout\b/i);
  if (w < 0) return false;
  return PROHIBITION.test(clause.slice(0, clause.length - near.length + w));
}

/**
 * True when the text mentions permission (or consent, authorisation, "agreed") at least once affirmatively: not negated
 * ("no permission needed", "permission not required"), unless the negation is a prohibition ("never … without permission").
 */
export function hasPermissionWording(s: string): boolean {
  for (const m of s.matchAll(PERMISSION_WORD)) {
    // The clause before the keyword stops at the previous sentence or clause break.
    const clause = s.slice(0, m.index).split(/[.;!?]/).at(-1)!;
    if (isProhibitionWithout(clause)) return true;
    const before = clause.slice(-NEGATION_WINDOW);
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + NEGATION_WINDOW + 5);
    if (!NEGATION_BEFORE.test(before) && !NEGATION_AFTER.test(after)) return true;
  }
  return false;
}

/** True when the text describes acting on a third party's site or systems without mentioning permission. */
export const needsPermissionWording = (s: string) => THIRD_PARTY_ACTION.test(s) && !hasPermissionWording(s);

/** Every string in a parsed value, with its path; so fields added later are checked by default. */
function* stringLeaves(v: unknown, path: (string | number)[] = []): Generator<[(string | number)[], string]> {
  if (typeof v === 'string') yield [path, v];
  else if (Array.isArray(v)) for (let i = 0; i < v.length; i++) yield* stringLeaves(v[i], [...path, i]);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) yield* stringLeaves(x, [...path, k]);
}
const pathLabel = (path: (string | number)[]) =>
  path.map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? p : `.${p}`)).join('');

export const PilotPlanSchema = z
  .object({
    idealPilotCustomer: text,
    firstStep: text,
    steps: list.min(3).max(8),
    measures: z.array(z.object({ metric: text, successThreshold: text })).min(2),
    timelineWeeks: z.number().int().min(1).max(52),
    permissionsAndRisks: list,
  })
  // A refinement, not a transform (R9): the router re-asks until every such text names the permission it depends on.
  .superRefine((plan, ctx) => {
    for (const [path, value] of stringLeaves(plan)) {
      if (needsPermissionWording(value)) {
        ctx.addIssue({
          code: 'custom',
          path,
          message:
            `step ${pathLabel(path)} interacts with a third party without mentioning permission: ` +
            "mention that the site owner's permission is obtained first",
        });
      }
    }
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
