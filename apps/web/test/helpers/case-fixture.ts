import { computeNumbers } from '@bcg/core/calc/numbers';
import type { CaseSections } from '@bcg/core/case/schema';
import type { CaseView, ClaimRow, GateVerdictRow, ScoreRow } from '@bcg/core/dashboard/case-view';
import caseDraft from '../../../../packages/core/test/helpers/fixtures/case-draft.json';

// A complete CaseView built from core's case-draft fixture, plus a hostile variant whose every string is an attack.

export const CASE_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-19T12:00:00Z');

type Draft = Omit<CaseSections, 'summary' | 'evidence' | 'numbers'> & {
  title: string;
  usedSignalUrls: string[];
  summary: Omit<CaseSections['summary'], 'gateFlags'>;
  evidence: { claims: CaseSections['evidence']['claims'] };
  numbers: { inputs: CaseSections['numbers']['inputs'] };
};

export function sectionsFixture(): CaseSections {
  const { title: _t, usedSignalUrls: _u, ...draft } = structuredClone(caseDraft) as unknown as Draft;
  return {
    ...draft,
    summary: { ...draft.summary, gateFlags: [] },
    evidence: {
      claims: draft.evidence.claims,
      signals: [
        { quote: 'Our forms die after plugin updates', url: 'https://news.example/item/1', sourceName: 'Hacker News', voice: 'operator' },
        { quote: 'Leads vanish &#8217;silently&#8217;', url: 'https://forum.example/t/2', sourceName: 'forum.example' },
      ],
    },
    numbers: { inputs: draft.numbers.inputs, results: computeNumbers(draft.numbers.inputs) },
  };
}

let n = 0;
export function claimRow(verified: ClaimRow['verified'], o: Partial<ClaimRow> = {}): ClaimRow {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, caseId: CASE_ID, section: 'evidence', text: `Claim ${n} (${verified})`,
    sourceUrl: `https://src.example/${n}`, quote: `quote ${n}`, verified, confidence: null, reviewNote: null, checkedAt: null,
    createdAt: NOW, ...o,
  };
}

export function gateRow(check: GateVerdictRow['check'], pass: boolean, reasoning: string): GateVerdictRow {
  n += 1;
  return { id: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`, ideaId: 'idea', check, pass, reasoning, model: 'm', promptVersion: 'p', sources: null, createdAt: NOW };
}

export function scoreRow(criterion: ScoreRow['criterion'], value: number, by: ScoreRow['by'], note = ''): ScoreRow {
  n += 1;
  return {
    id: `00000000-0000-4000-a000-${String(n).padStart(12, '0')}`, caseId: CASE_ID, criterion, value, note, by,
    model: by === 'ai' ? 'gemini-x' : null, promptVersion: by === 'ai' ? 'score.v1' : null, createdAt: NOW,
  };
}

export function caseViewFixture(o: { sections?: CaseSections; claims?: ClaimRow[]; stage?: CaseView['case']['stage']; killReason?: string | null } = {}): CaseView {
  const sections = o.sections ?? sectionsFixture();
  return {
    case: {
      id: CASE_ID, ideaId: 'idea', slug: 'lead-flow-verification', title: 'Lead-flow verification for web agencies', stage: o.stage ?? 'new',
      sections, killReason: o.killReason ?? null, gateAdvisory: sections.summary.gateFlags.length > 0, model: 'claude-x',
      promptVersion: 'case-write.v1', createdAt: NOW, updatedAt: NOW,
    },
    claims: o.claims ?? [],
    scores: [],
    gate: [gateRow('reachability', false, 'no reachable buyer'), gateRow('generic', true, 'specific enough')],
    events: [],
    lensName: 'Silent failure monitor',
  };
}

export const HOSTILE = '<img src=x onerror=alert(1)><script>alert(1)</script>"onmouseover=alert(1) x="';
export const HOSTILE_URL = 'javascript:alert(1)';

/** Every string leaf replaced: url-like keys get a javascript: URL, everything else the hostile HTML. */
function hostilize<T>(v: T, key = ''): T {
  if (typeof v === 'string') return (/url$/i.test(key) ? HOSTILE_URL : `${HOSTILE}${v}`) as T;
  if (Array.isArray(v)) return v.map((x) => hostilize(x, key)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'voice' ? x : hostilize(x, k)])) as T;
  return v;
}

/** A case whose every text field, quote, competitor name, claim and url is hostile. */
export function hostileCaseView(): CaseView {
  const sections = hostilize(sectionsFixture());
  sections.summary.gateFlags = [HOSTILE];
  // One https URL carrying an attribute-breaking payload, so a real link is rendered and its attributes are checked.
  sections.competitors.list[0]!.url = 'https://evil.example/"onmouseover=alert(1)';
  const claims = [
    claimRow('unreachable', { text: HOSTILE, quote: HOSTILE, sourceUrl: HOSTILE_URL, reviewNote: HOSTILE }),
    claimRow('needs_review', { section: 'numbers', text: HOSTILE, quote: HOSTILE, sourceUrl: 'data:text/html,<script>alert(1)</script>' }),
    claimRow('verified', { section: 'signal', text: HOSTILE, quote: HOSTILE, sourceUrl: 'https://ok.example/<script>' }),
  ];
  const view = caseViewFixture({ sections, claims, stage: 'killed', killReason: HOSTILE });
  view.case.title = HOSTILE;
  view.gate = [gateRow('generic', false, HOSTILE)];
  view.scores = [scoreRow('pain', 3, 'ai', HOSTILE), scoreRow('gut', 4, 'owner', HOSTILE)];
  view.lensName = HOSTILE;
  return view;
}
