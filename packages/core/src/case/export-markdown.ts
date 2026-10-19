import { listInputs } from '../calc/inputs';
import type { Sourced } from '../calc/schema';
import { stripInvisible } from '../llm/untrusted';
import { decodeEntities } from '../tools/entities';
import { competitorPricingText, hasPriceFigure } from './schema';
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

// Quotes stored before entity decoding landed (legacy rows) may still hold `&#8217;` etc.: decode first, strip
// control and invisible/bidi characters (decoded or stored raw), then escape (R13).
const cleanQuote = (s: string) => stripInvisible(decodeEntities(s));
const quoteLine = (s: string) => line(cleanQuote(s));
const quoteCell = (s: string) => cell(cleanQuote(s));

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

const STATUS_EMOJI: Record<Status, string> = { verified: '✅', unsupported: '❌', unreachable: '⚠️', needs_review: '🔍', unverified: '⏳' };
const CLAIM_STATUS: Record<Status, string> = {
  verified: '✅ verified',
  unsupported: '❌ unsupported',
  unreachable: '⚠️ unreachable',
  needs_review: '🔍 needs review',
  unverified: '⏳ unverified',
};
/** Claim sections listed under "Claims"; signal and competitor rows are flagged where their link is shown. */
const LISTED_SECTIONS = new Set(['evidence', 'numbers']);

/** Verification status of every displayed link, looked up the way deep-case keyed its claim rows. */
type Flags = {
  signal: Map<string, Status>;
  competitor: Map<string, Status>;
  competitorPricing: Map<string, Status>;
  input: Map<string, Status>;
};

// One url can carry several items (quotes, competitors), so links are keyed by url + identifying text:
// a signal by its quote, a competitor by its name, its pricing by the `competitorPricingText` deep-case stored.
const linkKey = (url: string, text: string) => `${url}\n${text}`;

/**
 * Before tuning-2 a competitor had one claim, `"<name>: <pricing>"` (section `competitor`), checking name and pricing
 * together. Cases written then still carry it: it stands in for the product check, and for the pricing check when the
 * pricing quotes a figure, labelled so the owner knows which rule produced it.
 */
type CompetitorLike = { url: string; name: string; pricing: string };
const legacyCompetitorKey = (x: CompetitorLike) => linkKey(x.url, `${x.name}: ${x.pricing}`);
const OLD_CHECK = '(old check: name + pricing)';

/** Worst first: on a key collision the flag never looks better than its weakest claim. */
const SEVERITY: Record<Status, number> = { unsupported: 4, unreachable: 3, needs_review: 2, unverified: 1, verified: 0 };

function setWorst(map: Map<string, Status>, key: string, status: Status) {
  const prev = map.get(key);
  if (prev === undefined || SEVERITY[status] > SEVERITY[prev]) map.set(key, status);
}

function flagsOf(claimRows: ClaimRow[]): Flags {
  const f: Flags = { signal: new Map(), competitor: new Map(), competitorPricing: new Map(), input: new Map() };
  for (const r of claimRows) {
    if (r.section === 'signal') setWorst(f.signal, linkKey(r.sourceUrl, r.quote ?? ''), r.verified);
    else if (r.section === 'competitor') setWorst(f.competitor, linkKey(r.sourceUrl, r.text), r.verified);
    else if (r.section === 'competitor-pricing') setWorst(f.competitorPricing, linkKey(r.sourceUrl, r.text), r.verified);
    else if (r.section === 'numbers') setWorst(f.input, r.text, r.verified);
  }
  return f;
}

/** Statuses the checker could not settle: the owner must open the link himself. Real `unsupported` is not one. */
const FOR_OWNER = new Set<Status>(['unreachable', 'needs_review', 'unverified']);
const NOT_CHECKED_REASON = 'not checked yet — open it yourself';
const FIXED_REASON: Partial<Record<Status, string>> = {
  unreachable: 'page could not be loaded by the checker — open it yourself',
  needs_review: 'checker unsure',
  unverified: NOT_CHECKED_REASON,
};
const SECTION_LABEL: Record<string, string> = {
  evidence: 'Claim',
  numbers: 'Number input',
  signal: 'Signal',
  competitor: 'Competitor',
  'competitor-pricing': 'Competitor pricing',
};
const UNPUBLISHED_PRICE_REASON = 'pricing not published — check it yourself';

/**
 * Everything the checker could not settle: unreachable, unsure and never-checked claims, displayed links that have no
 * claim at all (legacy cases, items past the cap), and competitors whose pricing is not published. The all-clear line
 * is written only when the case has claims and none of these.
 */
function forYouToCheck(c: CaseRow, claimRows: ClaimRow[], flags: Flags): string[] {
  // Items sharing a url, reason and label (one unreachable page behind several claims) become one line: the first,
  // counted. The label stays in the key so a competitor's product and pricing items remain separate lines.
  const merged = new Map<string, { label: string; text: string; url: string; reason: string; count: number }>();
  const item = (label: string, text: string, url: string, reason: string) => {
    const key = `${url}\n${reason}\n${label}`;
    const prev = merged.get(key);
    if (prev) prev.count++;
    else merged.set(key, { label, text, url, reason, count: 1 });
  };
  for (const r of claimRows) {
    if (FOR_OWNER.has(r.verified)) item(SECTION_LABEL[r.section] ?? line(r.section), r.text, r.sourceUrl, r.reviewNote?.trim() || FIXED_REASON[r.verified] || r.verified);
  }
  for (const s of c.sections.evidence.signals) {
    if (!flags.signal.has(linkKey(s.url, s.quote))) item('Signal', s.quote, s.url, NOT_CHECKED_REASON);
  }
  for (const { label, sourced } of listInputs(c.sections.numbers.inputs)) {
    if (sourced.source && !flags.input.has(`${label}: ${sourced.value}`)) {
      item('Number input', `${label}: ${sourced.value}`, sourced.source.url, NOT_CHECKED_REASON);
    }
  }
  for (const x of c.sections.competitors.list) {
    // A legacy claim is listed above when unsettled, like any claim; it covers the product (and a quoted price).
    const legacy = flags.competitor.has(legacyCompetitorKey(x));
    if (!legacy && !flags.competitor.has(linkKey(x.url, x.name))) item('Competitor', x.name, x.url, NOT_CHECKED_REASON);
    // An existing pricing claim always wins (its own status is listed above when unsettled); otherwise the predicate.
    if (flags.competitorPricing.has(linkKey(x.url, competitorPricingText(x)))) continue;
    if (!hasPriceFigure(x.pricing)) item('Competitor pricing', x.name, x.url, UNPUBLISHED_PRICE_REASON);
    else if (!legacy) item('Competitor pricing', competitorPricingText(x), x.url, NOT_CHECKED_REASON);
  }
  const items = [...merged.values()].map(
    (m) => `- **${m.label}:** ${quoteLine(m.text)} (${link(m.url)}): ${line(m.reason)}${m.count > 1 ? ` (${m.count} claims)` : ''}`,
  );
  const out = ['## For you to check', ''];
  if (claimRows.length === 0) out.push('This case has no checked sources — verify everything yourself.', ...(items.length ? [''] : []));
  else if (items.length === 0) out.push('Nothing — every displayed source was confirmed or flagged.');
  return [...out, ...items];
}

const emoji = (s: Status | undefined) => (s ? ` ${STATUS_EMOJI[s]}` : '');

function sourceOf(s: Sourced, status: Status | undefined): string {
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

function evidence(c: CaseRow, claimRows: ClaimRow[], flags: Flags): string[] {
  const { signals } = c.sections.evidence;
  const out = ['## Evidence', '', '### Signals', ''];
  if (signals.length === 0) out.push('_No harvested signals._');
  for (const s of signals) {
    const status = flags.signal.get(linkKey(s.url, s.quote));
    out.push(`- "${quoteLine(s.quote)}" (${line(s.sourceName)}, ${link(s.url)}) ${status ? STATUS_EMOJI[status] : 'not checked'}`);
  }
  out.push('', '### Claims', '');
  const listed = claimRows.filter((cl) => LISTED_SECTIONS.has(cl.section));
  if (listed.length === 0) out.push('_No claims recorded._');
  for (const cl of listed) {
    out.push(`- ${CLAIM_STATUS[cl.verified]}: ${line(cl.text)}`);
    if (cl.quote) out.push(`  - Quote: "${quoteLine(cl.quote)}"`);
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
  const shown = (s: Status | undefined) => (s ? CLAIM_STATUS[s] : 'not checked');
  const legacy = (x: CompetitorLike) => {
    const s = flags.competitor.get(legacyCompetitorKey(x));
    return s ? `${CLAIM_STATUS[s]} ${OLD_CHECK}` : undefined;
  };
  const product = (x: CompetitorLike) => {
    const s = flags.competitor.get(linkKey(x.url, x.name));
    return s ? CLAIM_STATUS[s] : legacy(x) ?? shown(undefined);
  };
  // A stored pricing claim always decides the cell, so a checked price never shows "not published".
  const pricing = (x: CompetitorLike) => {
    const s = flags.competitorPricing.get(linkKey(x.url, competitorPricingText(x)));
    if (s) return CLAIM_STATUS[s];
    if (!hasPriceFigure(x.pricing)) return '🔍 not published — check';
    return legacy(x) ?? 'not checked';
  };
  return [
    '## Competitors',
    '',
    table(
      ['Name', 'Link', 'Pricing', 'Gap', 'Product', 'Pricing check'],
      list.map((x) => [cell(x.name), cellLink(x.url), cell(x.pricing), cell(x.gap), product(x), pricing(x)]),
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
    ...forYouToCheck(c, claimRows, linkFlags), '',
    ...evidence(c, claimRows, linkFlags), '',
    ...numbers(c, linkFlags), '',
    ...competitors(c, linkFlags), '',
    ...pitch(c), '',
    ...scoreSection(scoreRows), '',
  ].join('\n');
}
