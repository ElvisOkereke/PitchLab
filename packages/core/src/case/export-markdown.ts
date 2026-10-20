import { listInputs } from '../calc/inputs';
import type { Sourced } from '../calc/schema';
import { stripInvisible } from '../llm/untrusted';
import type { cases, scores } from '../db/schema';
import { safeHttpUrl } from './links';
import {
  STATUS_EMOJI, STATUS_LABEL, cleanQuote, competitorChecks, forYouToCheck, inputStatus, linkFlags, signalStatus,
  type ClaimRow, type ClaimStatus, type LinkFlags,
} from './review';

export type CaseRow = typeof cases.$inferSelect;
export type { ClaimRow };
export type ScoreRow = typeof scores.$inferSelect;

// All case-derived text is untrusted (R13): escape HTML and neutralise Markdown link/image syntax. What to show
// (statuses, "For you to check") comes from review.ts as raw text; this file only formats and escapes it.

/** Escape for inline Markdown text: HTML-significant chars and link brackets. */
export function esc(s: string): string {
  // P3-R16: invisible/bidi/control characters go first, so every helper built on esc is safe by construction.
  return stripInvisible(s)
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

/** Single-line text (headings, list items). */
export const line = (s: string) => esc(s.replace(/\s+/g, ' ').trim());

/** A table cell: single line, pipes escaped. */
export const cell = (s: string) => line(s).replace(/\|/g, '\\|');

const quoteLine = (s: string) => line(cleanQuote(s));
const quoteCell = (s: string) => cell(cleanQuote(s));

/** Multi-line text: each line escaped and trimmed, line breaks kept as hard breaks, blank lines as paragraph breaks. */
export function block(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n\s*\n/)
    .map((para) => para.split('\n').map((l) => esc(l.trim())).join('  \n'))
    .join('\n\n');
}

/** `[host](url)` for http(s) urls; otherwise the url as escaped plain text. */
export function link(url: string): string {
  const parsed = safeHttpUrl(url);
  if (!parsed) return line(url);
  // Characters that would end the link target early or break a table row.
  const href = parsed.href.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\|/g, '%7C');
  return `[${esc(parsed.hostname)}](${href})`;
}

/** A link inside a table cell (a non-http url falls back to text, which may contain pipes). */
export const cellLink = (url: string) => link(url).replace(/\|/g, '\\|');

/** A dollar amount as the case export shows it ("$1", "$1.50", "-$1,200"); also used for the case price in prompts. */
export const money = (x: number) => {
  const whole = Number.isInteger(Math.round(x * 100) / 100);
  return (x < 0 ? '-$' : '$') + Math.abs(x).toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
};
const orNone = (x: number | null, fmt: (n: number) => string) => (x === null ? 'n/a' : fmt(x));

export function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

/** Claim sections listed under "Claims"; signal and competitor rows are flagged where their link is shown. */
const LISTED_SECTIONS = new Set(['evidence', 'numbers']);

function forYouSection(c: CaseRow, claimRows: ClaimRow[], flags: LinkFlags): string[] {
  const r = forYouToCheck(c.sections, claimRows, flags);
  // Item text is already cleaned (cleanQuote); every field is escaped here.
  const items = r.items.map(
    (m) => `- **${line(m.label)}:** ${line(m.text)} (${link(m.url)}): ${line(m.reason)}${m.count > 1 ? ` (${m.count} claims)` : ''}`,
  );
  const out = ['## For you to check', ''];
  if (r.state === 'no_claims') out.push('This case has no checked sources — verify everything yourself.', ...(items.length ? [''] : []));
  else if (r.state === 'all_clear') out.push('Nothing — every displayed source was confirmed or flagged.');
  return [...out, ...items];
}

const emoji = (s: ClaimStatus | undefined) => (s ? ` ${STATUS_EMOJI[s]}` : '');

function sourceOf(s: Sourced, status: ClaimStatus | undefined): string {
  if (s.source) return `${cellLink(s.source.url)}: "${quoteCell(s.source.quote)}"${emoji(status)}`;
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

function evidence(c: CaseRow, claimRows: ClaimRow[], flags: LinkFlags): string[] {
  const { signals } = c.sections.evidence;
  const out = ['## Evidence', '', '### Signals', ''];
  if (signals.length === 0) out.push('_No harvested signals._');
  for (const s of signals) {
    const status = signalStatus(flags, s);
    // Who wrote the signal, when it was tagged (tuning-4); untagged and older signals show no label.
    const voice = s.voice ? ` (voice: ${line(s.voice)})` : '';
    out.push(`- "${quoteLine(s.quote)}" (${line(s.sourceName)}, ${link(s.url)})${voice} ${status ? STATUS_EMOJI[status] : 'not checked'}`);
  }
  out.push('', '### Claims', '');
  const listed = claimRows.filter((cl) => LISTED_SECTIONS.has(cl.section));
  if (listed.length === 0) out.push('_No claims recorded._');
  for (const cl of listed) {
    out.push(`- ${STATUS_LABEL[cl.verified]}: ${line(cl.text)}`);
    if (cl.quote) out.push(`  - Quote: "${quoteLine(cl.quote)}"`);
    out.push(`  - Source: ${link(cl.sourceUrl)}`);
  }
  return out;
}

function numbers(c: CaseRow, flags: LinkFlags): string[] {
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
        cell(i.label), String(i.sourced.value), sourceOf(i.sourced, inputStatus(flags, i.label, i.sourced.value)),
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

function competitors(c: CaseRow, flags: LinkFlags): string[] {
  const { list, levels } = c.sections.competitors;
  return [
    '## Competitors',
    '',
    table(
      ['Name', 'Link', 'Pricing', 'Gap', 'Product', 'Pricing check'],
      list.map((x) => {
        const checks = competitorChecks(flags, x);
        return [cell(x.name), cellLink(x.url), cell(x.pricing), cell(x.gap), checks.product.text, checks.pricing.text];
      }),
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
  const gateFlags = c.sections.summary.gateFlags;
  const head = [`# ${line(c.title)}`, ''];
  if (gateFlags.length) head.push(`> ⚠️ Gate flags: ${gateFlags.map(line).join(', ')}`, '');
  head.push(`_Stage: ${c.stage} · Model: ${line(c.model)} · Prompt: ${line(c.promptVersion)}_`, '');
  if (c.killReason) head.push(`**Kill reason:** ${line(c.killReason)}`, '');
  const flags = linkFlags(claimRows);
  return [
    ...head,
    ...summary(c), '',
    ...forYouSection(c, claimRows, flags), '',
    ...evidence(c, claimRows, flags), '',
    ...numbers(c, flags), '',
    ...competitors(c, flags), '',
    ...pitch(c), '',
    ...scoreSection(scoreRows), '',
  ].join('\n');
}
