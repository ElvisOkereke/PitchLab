import { listInputs } from '../calc/inputs';
import type { Sourced } from '../calc/schema';
import type { cases, claims, scores } from '../db/schema';

export type CaseRow = typeof cases.$inferSelect;
export type ClaimRow = typeof claims.$inferSelect;
export type ScoreRow = typeof scores.$inferSelect;

// All case-derived text is untrusted (R13): escape HTML and neutralise Markdown link/image syntax.

/** Escape for inline Markdown text: HTML-significant chars and link brackets. */
function esc(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

/** Single-line text (headings, list items). */
const line = (s: string) => esc(s.replace(/\s+/g, ' ').trim());

/** A table cell: single line, pipes escaped. */
const cell = (s: string) => line(s).replace(/\|/g, '\\|');

/** Multi-line text: each line escaped and trimmed, line breaks kept as hard breaks, blank lines as paragraph breaks. */
function block(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n\s*\n/)
    .map((para) => para.split('\n').map((l) => esc(l.trim())).join('  \n'))
    .join('\n\n');
}

/** `[host](url)` for http(s) urls; otherwise the url as escaped plain text. */
function link(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return line(url);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return line(url);
  // Characters that would end the link target early or break a table row.
  const href = parsed.href.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\|/g, '%7C');
  return `[${esc(parsed.hostname)}](${href})`;
}

/** A link inside a table cell (a non-http url falls back to text, which may contain pipes). */
const cellLink = (url: string) => link(url).replace(/\|/g, '\\|');

const money = (x: number) => {
  const whole = Number.isInteger(Math.round(x * 100) / 100);
  return (x < 0 ? '-$' : '$') + Math.abs(x).toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
};
const orNone = (x: number | null, fmt: (n: number) => string) => (x === null ? 'n/a' : fmt(x));

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

type Status = ClaimRow['verified'];

const STATUS_EMOJI: Record<Status, string> = { verified: '✅', unsupported: '❌', unreachable: '⚠️', unverified: '⏳' };
const CLAIM_STATUS: Record<Status, string> = {
  verified: '✅ verified',
  unsupported: '❌ unsupported',
  unreachable: '⚠️ unreachable',
  unverified: '⏳ unverified',
};
/** Claim sections listed under "Claims"; signal and competitor rows are flagged where their link is shown. */
const LISTED_SECTIONS = new Set(['evidence', 'numbers']);

/** Verification status of every displayed link, looked up the way deep-case keyed its claim rows. */
type Flags = { signal: Map<string, Status>; competitor: Map<string, Status>; input: Map<string, Status> };

// One url can carry several items (quotes, competitors), so links are keyed by url + identifying text:
// a signal by its quote, a competitor by the `${name}: ${pricing}` text deep-case stored as the claim.
const linkKey = (url: string, text: string) => `${url}\n${text}`;

/** Worst first: on a key collision the flag never looks better than its weakest claim. */
const SEVERITY: Record<Status, number> = { unsupported: 3, unreachable: 2, unverified: 1, verified: 0 };

function setWorst(map: Map<string, Status>, key: string, status: Status) {
  const prev = map.get(key);
  if (prev === undefined || SEVERITY[status] > SEVERITY[prev]) map.set(key, status);
}

function flagsOf(claimRows: ClaimRow[]): Flags {
  const f: Flags = { signal: new Map(), competitor: new Map(), input: new Map() };
  for (const r of claimRows) {
    if (r.section === 'signal') setWorst(f.signal, linkKey(r.sourceUrl, r.quote ?? ''), r.verified);
    else if (r.section === 'competitor') setWorst(f.competitor, linkKey(r.sourceUrl, r.text), r.verified);
    else if (r.section === 'numbers') setWorst(f.input, r.text, r.verified);
  }
  return f;
}

const emoji = (s: Status | undefined) => (s ? ` ${STATUS_EMOJI[s]}` : '');

function sourceOf(s: Sourced, status: Status | undefined): string {
  if (s.source) return `${cellLink(s.source.url)}: "${cell(s.source.quote)}"${emoji(status)}`;
  return `assumption: ${cell(s.assumption ?? '')}`;
}

function summary(c: CaseRow): string[] {
  const s = c.sections.summary;
  const field = (label: string, text: string) => `**${label}:** ${block(text)}`;
  return [
    '## Summary',
    '',
    field('One-liner', s.oneLiner),
    '',
    field('Buyer', s.buyer),
    '',
    field('Problem', s.problem),
    '',
    field('Solution', s.solution),
    '',
    `**Price:** ${money(s.price.amount)} per ${line(s.price.per)}. ${block(s.price.rationale)}`,
    '',
    field('Why now', s.whyNow),
    '',
    field('Why it wins', s.whyItWins),
    '',
    field('Next action', s.nextAction),
  ];
}

function evidence(c: CaseRow, claimRows: ClaimRow[], flags: Flags): string[] {
  const { signals } = c.sections.evidence;
  const out = ['## Evidence', '', '### Signals', ''];
  if (signals.length === 0) out.push('_No harvested signals._');
  for (const s of signals) {
    out.push(`- "${line(s.quote)}" (${line(s.sourceName)}, ${link(s.url)})${emoji(flags.signal.get(linkKey(s.url, s.quote)))}`);
  }
  out.push('', '### Claims', '');
  const listed = claimRows.filter((cl) => LISTED_SECTIONS.has(cl.section));
  if (listed.length === 0) out.push('_No claims recorded._');
  for (const cl of listed) {
    out.push(`- ${CLAIM_STATUS[cl.verified]}: ${line(cl.text)}`);
    if (cl.quote) out.push(`  - Quote: "${line(cl.quote)}"`);
    out.push(`  - Source: ${link(cl.sourceUrl)}`);
  }
  return out;
}

function numbers(c: CaseRow, flags: Flags): string[] {
  const { inputs, results: r } = c.sections.numbers;
  const pct = (n: number) => `${n}%`;
  return [
    '## Numbers',
    '',
    '### Key results',
    '',
    `- Annual price per buyer: ${money(r.buyer.annualPrice)}`,
    `- Annual problem cost per buyer: ${money(r.buyer.annualProblemCost)}`,
    `- Annual savings per buyer: ${money(r.buyer.annualSavings)}`,
    `- ROI multiple: ${orNone(r.buyer.roiMultiple, (n) => `${n}x`)}`,
    `- Payback: ${orNone(r.buyer.paybackMonths, (n) => `${n} months`)}`,
    `- Annual revenue potential: ${money(r.market.annualRevenuePotential)}`,
    `- Year 1 revenue: ${money(r.market.year1Revenue)}`,
    `- Gross margin: ${orNone(r.unit.grossMarginPct, pct)}`,
    `- Breakeven buyers: ${r.breakevenBuyers === null ? `none (${line(r.breakevenReason ?? 'unknown')})` : r.breakevenBuyers}`,
    '',
    '### Formulas',
    '',
    ...r.formulas.map((f) => `- ${line(f)}`),
    '',
    '### Inputs',
    '',
    table(
      ['Input', 'Value', 'Source'],
      listInputs(inputs).map((i) => [
        cell(i.label), String(i.sourced.value), sourceOf(i.sourced, flags.input.get(`${i.label}: ${i.sourced.value}`)),
      ]),
    ),
    '',
    '### Scenarios',
    '',
    table(
      ['Buyers', 'MRR', 'ARR', 'Monthly gross profit', 'Monthly net'],
      r.scenarios.map((s) => [String(s.buyers), money(s.mrr), money(s.arr), money(s.monthlyGrossProfit), money(s.monthlyNet)]),
    ),
  ];
}

function competitors(c: CaseRow, flags: Flags): string[] {
  const { list, levels } = c.sections.competitors;
  const status = (x: { url: string; name: string; pricing: string }) => {
    const s = flags.competitor.get(linkKey(x.url, `${x.name}: ${x.pricing}`));
    return s ? CLAIM_STATUS[s] : 'not checked';
  };
  return [
    '## Competitors',
    '',
    table(
      ['Name', 'Link', 'Pricing', 'Gap', 'Status'],
      list.map((x) => [cell(x.name), cellLink(x.url), cell(x.pricing), cell(x.gap), status(x)]),
    ),
    '',
    '### Levels',
    '',
    table(['Level', 'What it checks', 'Limitation'], levels.map((l) => [cell(l.level), cell(l.whatItChecks), cell(l.limitation)])),
  ];
}

function pitch(c: CaseRow): string[] {
  const p = c.sections.pitch;
  const email = (heading: string) => (e: { subject: string; body: string }, i: number) =>
    [`#### ${heading} ${i + 1}: ${line(e.subject)}`, '', block(e.body), ''];
  return [
    '## Pitch',
    '',
    '### Elevator pitch',
    '',
    block(p.elevator),
    '',
    '### Emails',
    '',
    ...p.emails.flatMap(email('Email')),
    '### Follow-ups',
    '',
    ...p.followUps.flatMap(email('Follow-up')),
    '### Call script',
    '',
    block(p.callScript),
    '',
    '### Objections',
    '',
    ...p.objections.map((o) => `- **${line(o.objection)}**: ${line(o.response)}`),
    '',
    '### Pricing copy',
    '',
    block(p.pricingCopy),
  ];
}

function scoreSection(scoreRows: ScoreRow[]): string[] {
  const render = (rows: ScoreRow[]) => table(['Criterion', 'Value', 'Note'], rows.map((s) => [s.criterion, String(s.value), cell(s.note)]));
  const ai = scoreRows.filter((s) => s.by === 'ai');
  const owner = scoreRows.filter((s) => s.by === 'owner');
  const out = ['## Score', '', '### AI scores', '', ai.length ? render(ai) : '_Not scored yet._'];
  if (owner.length) out.push('', '### Owner scores', '', render(owner));
  return out;
}

/** Render a case (with its claims and scores) as a Markdown document, sections in dashboard tab order. */
export function caseToMarkdown(c: CaseRow, claimRows: ClaimRow[], scoreRows: ScoreRow[]): string {
  const flags = c.sections.summary.gateFlags;
  const head = [`# ${line(c.title)}`, ''];
  if (flags.length) head.push(`> ⚠️ Gate flags: ${flags.map(line).join(', ')}`, '');
  head.push(`_Stage: ${c.stage} · Model: ${line(c.model)} · Prompt: ${line(c.promptVersion)}_`, '');
  if (c.killReason) head.push(`**Kill reason:** ${line(c.killReason)}`, '');
  const linkFlags = flagsOf(claimRows);
  return [
    ...head,
    ...summary(c), '',
    ...evidence(c, claimRows, linkFlags), '',
    ...numbers(c, linkFlags), '',
    ...competitors(c, linkFlags), '',
    ...pitch(c), '',
    ...scoreSection(scoreRows), '',
  ].join('\n');
}
