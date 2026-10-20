import { z } from 'zod';
import { stripInvisible } from '../llm/untrusted';

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
/** A negation right after the keyword ("permission is not required", "consent unnecessary", ", it is not needed"). */
const NEGATION_AFTER =
  /^\W*(?:(?:it|this|that|which)\s+)?(?:(?:is|are|was|were)\s+)?(?:not\s+(?:required|needed|necessary)|unnecessary|needless|optional)\b/i;
/** After "without … permission": wording that approves acting without it ("without permission is fine"). */
const WITHOUT_OK_AFTER = /^\W*(?:(?:it|this|that|which)\s+)?(?:is|are|was|'s)\s+(?:fine|ok(?:ay)?|acceptable|allowed|needed)\b/i;
const NEGATION_WINDOW = 20;

// Best-effort tripwire for advisory text; permission reminders are also appended by the fallback in pack-docs.
// The prohibition exception (P3-R9) is deliberately narrow; other wording edge cases are documented limitations.
/** A prohibition token within PROHIBITION_REACH chars before "without", in the same clause. */
const PROHIBITION_TOKEN = /\b(?:never|do\s+not|don['’]?t|must\s+not|may\s+not|cannot|can['’]?t)\b/i;
const PROHIBITION_REACH = 40;
/** "no <up to 3 words>" directly followed by "without": "No test leads without prior permission". */
const NO_PHRASE_BEFORE_WITHOUT = /\bno\s+(?:\S+\s+){0,3}$/i;
/** "without" at most 2 words before the keyword (the clause ends right before the keyword). */
const WITHOUT_NEAR_KEYWORD = /\bwithout\s+(?:\S+\s+){0,2}$/i;

/** True when `clause` (the text before a permission keyword) reads "<prohibition> … without [≤2 words]". */
function isProhibitionWithout(clause: string): boolean {
  const w = WITHOUT_NEAR_KEYWORD.exec(clause);
  if (!w) return false;
  const beforeWithout = clause.slice(0, w.index);
  return PROHIBITION_TOKEN.test(beforeWithout.slice(-PROHIBITION_REACH)) || NO_PHRASE_BEFORE_WITHOUT.test(beforeWithout);
}

/**
 * True when the text mentions permission (or consent, authorisation, "agreed") at least once affirmatively: not negated
 * before ("no permission needed") or after ("permission not required"), except that a prohibition makes
 * "never … without permission" affirmative unless wording after it approves acting without it.
 */
export function hasPermissionWording(s: string): boolean {
  for (const m of s.matchAll(PERMISSION_WORD)) {
    // The clause before the keyword stops at the previous sentence or clause break (incl. dashes).
    const clause = s.slice(0, m.index).split(/[.;!?—–]/).at(-1)!;
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + NEGATION_WINDOW + 10);
    if (NEGATION_AFTER.test(after)) continue;
    if (isProhibitionWithout(clause)) {
      if (!WITHOUT_OK_AFTER.test(after)) return true;
      continue;
    }
    if (!NEGATION_BEFORE.test(clause.slice(-NEGATION_WINDOW))) return true;
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

/** Text in every issue the permission refinement raises; pack-docs falls back only when all issues carry it (P3-R11). */
export const PERMISSION_ISSUE_MARKER = 'interacts with a third party without mentioning permission';

/** The pilot plan without the permission tripwire: used only by the loose fallback call (P3-R3), whose output is annotated by code. */
export const PilotPlanLooseSchema = z.object({
  idealPilotCustomer: text,
  firstStep: text,
  steps: list.min(3).max(8),
  measures: z.array(z.object({ metric: text, successThreshold: text })).min(2),
  timelineWeeks: z.number().int().min(1).max(52),
  permissionsAndRisks: list,
});

export const PilotPlanSchema = PilotPlanLooseSchema
  // A refinement, not a transform (R9): the router re-asks until every such text names the permission it depends on.
  .superRefine((plan, ctx) => {
    for (const [path, value] of stringLeaves(plan)) {
      if (needsPermissionWording(value)) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `step ${pathLabel(path)} ${PERMISSION_ISSUE_MARKER}: mention that the site owner's permission is obtained first`,
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

const gateShape = { id: text, description: text, metricKey: z.enum(CHECKLIST_METRIC_KEYS) };

/** What the model returns (P3-R16): every threshold positive (a 0 gate would pass with no evidence); a conversion is a percentage ≤ 100. */
export const ChecklistSchema = z.object({
  gates: z
    .array(z.object({ ...gateShape, threshold: z.number().positive() }).refine(
      (g) => g.metricKey !== 'landing_conversion_pct' || g.threshold <= 100,
      { message: 'landing_conversion_pct threshold is a percentage: at most 100', path: ['threshold'] },
    ))
    .min(1)
    .refine((gates) => new Set(gates.map((g) => g.id)).size === gates.length, { message: 'gate ids must be unique' }),
});
export type Checklist = z.infer<typeof ChecklistSchema>;

/**
 * A stored checklist as read back: any finite threshold, so packs stored before P3-R16 (threshold 0) still render.
 * computeChecklistStatus never passes a gate whose threshold is not positive.
 */
export const ChecklistStoredSchema = z.object({ gates: z.array(z.object({ ...gateShape, threshold: z.number() })) });

const packShape = { mvpSpec: MvpSpecSchema, interviewKit: InterviewKitSchema, checklist: ChecklistSchema };

/** What one `pack` call returns (with the pilot-plan permission tripwire). */
export const PackDocsSchema = z.object({ ...packShape, pilotPlan: PilotPlanSchema });
/** The same without the tripwire, for the one fallback call (P3-R3). */
export const PackDocsLooseSchema = z.object({ ...packShape, pilotPlan: PilotPlanLooseSchema });

/**
 * What `validation_packs.sections` stores: the documents plus `reviewNotes`, which only code writes (never the model:
 * it is not in the schemas sent to the model), e.g. when the fallback added permission reminders.
 */
export const PackSectionsSchema = z.object({
  ...packShape,
  checklist: ChecklistStoredSchema,
  pilotPlan: PilotPlanLooseSchema,
  reviewNotes: z.array(z.string()).optional(),
});
export type PackDocs = z.infer<typeof PackSectionsSchema>;

// ---- Outreach drafts (outreach.v1) ---------------------------------------------------------------

// Link guard patterns (rulings P3-R14, R15, R17). Every pattern is linear on hostile input: a match can only start where
// the lookbehind allows (the start of a token), so no start position re-scans the same run of characters. Run them on
// guardText() output. All global: use with replace / match only (the testers below are non-global copies).

/** A link: an http(s)/ftp URL or a bare `www.` host. */
export const LINK_IN_TEXT = /\b(?:(?:https?|ftp):\/\/|www\.)[^\s<>"']*/gi;
/** An email address (starting at the start of its local part). */
export const EMAIL_IN_TEXT = /(?<![a-z0-9._%+'-])[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
/**
 * A scheme-less host (P3-R17, no TLD list): `label(.label)+` with `[a-z0-9-]+` labels (one character allowed) whose
 * final label is 2–24 letters or an `xn--` punycode label, optional /path; not preceded by `@`, a word character, `.` or
 * `-`. One-letter final labels (e.g., i.e., U.S., a.m.) never match; "loads.Then" (no space) is an accepted false positive.
 */
export const HOST_IN_TEXT = /(?<![@\w.-])(?:[a-z0-9-]+\.)+(?:xn--[a-z0-9-]+|[a-z]{2,24})\b(?:\/\S*)?/gi;
/** A dotted-quad IPv4 literal, optional /path. */
export const IPV4_IN_TEXT = /\b\d{1,3}(?:\.\d{1,3}){3}\b(?:\/\S*)?/g;

const GUARD_PATTERNS = [LINK_IN_TEXT, EMAIL_IN_TEXT, HOST_IN_TEXT, IPV4_IN_TEXT];
const GUARD_TESTERS = GUARD_PATTERNS.map((re) => new RegExp(re.source, re.flags.replace('g', '')));

/** Text as the guard sees it: NFKC (full-width letters and dots), ideographic dots → '.', invisible characters removed, \n line ends. */
export function guardText(s: string): string {
  return stripInvisible(s.normalize('NFKC').replace(/[．。｡]/g, '.')).replace(/\r\n?/g, '\n');
}

/** guardText(s) with every link, email address, host and IPv4 literal replaced by a space. Callers cap `s` first. */
export function removeLinksAndAddresses(s: string): string {
  return GUARD_PATTERNS.reduce((acc, re) => acc.replace(re, ' '), guardText(s));
}

/**
 * Model-written email text never carries a link, a host name, an IP address or an email address (prospect-site text
 * could otherwise steer a draft the owner sends). Checked on guardText(), so zero-width characters, full-width or
 * ideographic dots cannot dodge it. The sender's own contact details are added by code after validation, in the footer.
 */
export function hasNoLinksOrAddresses(s: string): boolean {
  const n = guardText(s);
  return GUARD_TESTERS.every((re) => !re.test(n));
}
const NO_LINKS_MESSAGE =
  'must not contain any link (URL, "www.", or a domain such as example.com) or email address; write company and product ' +
  'names without domain suffixes (e.g. "Monday", not "Monday.com"); contact details are added automatically';

/** One plain-text email. The subject is a single line; code appends the CASL footer to the body. */
const draftEmail = z.object({
  subject: text.max(200)
    .refine((s) => !/[\r\n]/.test(s), { message: 'subject must be a single line' })
    .refine(hasNoLinksOrAddresses, { message: `subject ${NO_LINKS_MESSAGE}` }),
  body: text.max(5000).refine(hasNoLinksOrAddresses, { message: `body ${NO_LINKS_MESSAGE}` }),
});

/** What one `outreach` call returns for one prospect. */
export const DraftEmailsSchema = z.object({ cold: draftEmail, followup1: draftEmail, followup2: draftEmail });
export type DraftEmails = z.infer<typeof DraftEmailsSchema>;

// ---- Landing page copy (landing.v1) --------------------------------------------------------------

/** Plain-text copy only: the page template is code, and every string is HTML-escaped when rendered. */
export const LandingCopySchema = z.object({
  headline: text.max(200),
  subhead: text.max(500),
  whoItsFor: text.max(1500),
  problem: text.max(2000),
  howItWorks: z.array(z.object({ title: text.max(120), text: text.max(800) })).length(3),
  offer: text.max(1500),
  faq: z.array(z.object({ q: text.max(300), a: text.max(1500) })).min(3).max(5),
  ctaLabel: text.max(60),
  metaDescription: text.max(320),
});
export type LandingCopy = z.infer<typeof LandingCopySchema>;
