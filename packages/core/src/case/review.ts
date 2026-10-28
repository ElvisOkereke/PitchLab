import { listInputs } from '../calc/inputs';
import type { claims } from '../db/schema';
import { stripInvisible } from '../llm/untrusted';
import { decodeEntities } from '../tools/entities';
import { EXPIRED_PLACEHOLDER } from './expired';
import { competitorPricingText, hasPriceFigure, type CaseSections } from './schema';

// What the owner must check in a case, shared by the Markdown export and the dashboard so both say the same thing.
// Everything here returns RAW, UNESCAPED text: each renderer escapes at render (R13) — the export with esc/line,
// the dashboard through React text nodes.

export type ClaimRow = typeof claims.$inferSelect;
export type ClaimStatus = ClaimRow['verified'];

export const STATUS_EMOJI: Record<ClaimStatus, string> = {
  verified: '✅', unsupported: '❌', unreachable: '⚠️', needs_review: '🔍', unverified: '⏳',
};
export const STATUS_LABEL: Record<ClaimStatus, string> = {
  verified: '✅ verified',
  unsupported: '❌ unsupported',
  unreachable: '⚠️ unreachable',
  needs_review: '🔍 needs review',
  unverified: '⏳ unverified',
};

/**
 * Quotes stored before entity decoding landed (legacy rows) may still hold `&#8217;` etc.: decode them and strip
 * control and invisible/bidi characters (decoded or stored raw). The result is still unescaped text.
 */
export const cleanQuote = (s: string) => stripInvisible(decodeEntities(s));

/** Verification status of every displayed link, looked up the way deep-case keyed its claim rows. */
export type LinkFlags = {
  signal: Map<string, ClaimStatus>;
  competitor: Map<string, ClaimStatus>;
  competitorPricing: Map<string, ClaimStatus>;
  input: Map<string, ClaimStatus>;
};

// One url can carry several items (quotes, competitors), so links are keyed by url + identifying text:
// a signal by its quote, a competitor by its name, its pricing by the `competitorPricingText` deep-case stored.
const linkKey = (url: string, text: string) => `${url}\n${text}`;
const inputKey = (label: string, value: number) => `${label}: ${value}`;

/**
 * Before tuning-2 a competitor had one claim, `"<name>: <pricing>"` (section `competitor`), checking name and pricing
 * together. Cases written then still carry it: it stands in for the product check, and for the pricing check when the
 * pricing quotes a figure, labelled so the owner knows which rule produced it.
 */
type CompetitorLike = { url: string; name: string; pricing: string };
const legacyCompetitorKey = (x: CompetitorLike) => linkKey(x.url, `${x.name}: ${x.pricing}`);
const OLD_CHECK = '(old check: name + pricing)';

/** Worst first: on a key collision the flag never looks better than its weakest claim. */
const SEVERITY: Record<ClaimStatus, number> = { unsupported: 4, unreachable: 3, needs_review: 2, unverified: 1, verified: 0 };

function setWorst(map: Map<string, ClaimStatus>, key: string, status: ClaimStatus) {
  const prev = map.get(key);
  if (prev === undefined || SEVERITY[status] > SEVERITY[prev]) map.set(key, status);
}

/** The status of every displayed link from the case's claim rows (worst status wins on a shared key). */
export function linkFlags(claimRows: ClaimRow[]): LinkFlags {
  const f: LinkFlags = { signal: new Map(), competitor: new Map(), competitorPricing: new Map(), input: new Map() };
  for (const r of claimRows) {
    if (r.section === 'signal') setWorst(f.signal, linkKey(r.sourceUrl, r.quote ?? ''), r.verified);
    else if (r.section === 'competitor') setWorst(f.competitor, linkKey(r.sourceUrl, r.text), r.verified);
    else if (r.section === 'competitor-pricing') setWorst(f.competitorPricing, linkKey(r.sourceUrl, r.text), r.verified);
    else if (r.section === 'numbers') setWorst(f.input, r.text, r.verified);
  }
  return f;
}

export const signalStatus = (f: LinkFlags, s: { url: string; quote: string }): ClaimStatus | undefined =>
  f.signal.get(linkKey(s.url, s.quote));

export const inputStatus = (f: LinkFlags, label: string, value: number): ClaimStatus | undefined =>
  f.input.get(inputKey(label, value));

/** A competitor check cell: the claim status behind it (null when none) and the exact text the export prints. */
export type CheckCell = { status: ClaimStatus | null; text: string };

const NOT_CHECKED: CheckCell = { status: null, text: 'not checked' };

/** The product and pricing checks of one competitor row. */
export function competitorChecks(f: LinkFlags, x: CompetitorLike): { product: CheckCell; pricing: CheckCell } {
  const legacyStatus = f.competitor.get(legacyCompetitorKey(x));
  const legacy: CheckCell | undefined = legacyStatus
    ? { status: legacyStatus, text: `${STATUS_LABEL[legacyStatus]} ${OLD_CHECK}` }
    : undefined;
  const productStatus = f.competitor.get(linkKey(x.url, x.name));
  const product: CheckCell = productStatus ? { status: productStatus, text: STATUS_LABEL[productStatus] } : legacy ?? NOT_CHECKED;
  // A stored pricing claim always decides the cell, so a checked price never shows "not published".
  const pricingStatus = f.competitorPricing.get(linkKey(x.url, competitorPricingText(x)));
  let pricing: CheckCell;
  if (pricingStatus) pricing = { status: pricingStatus, text: STATUS_LABEL[pricingStatus] };
  else if (!hasPriceFigure(x.pricing)) pricing = { status: null, text: '🔍 not published — check' };
  else pricing = legacy ?? NOT_CHECKED;
  return { product: { ...product }, pricing: { ...pricing } };
}

/** Statuses the checker could not settle: the owner must open the link himself. Real `unsupported` is not one. */
const FOR_OWNER = new Set<ClaimStatus>(['unreachable', 'needs_review', 'unverified']);
const NOT_CHECKED_REASON = 'not checked yet — open it yourself';
const FIXED_REASON: Partial<Record<ClaimStatus, string>> = {
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

/** One "For you to check" line. `text` is cleaned (cleanQuote) but unescaped; `count` > 1 when items were merged. */
export type ForYouItem = { label: string; text: string; url: string; reason: string; count: number };

/**
 * Everything the checker could not settle: unreachable, unsure and never-checked claims, displayed links that have no
 * claim at all (legacy cases, items past the cap), and competitors whose pricing is not published.
 * `no_claims` = the case has no claim rows (items may still be listed); `all_clear` = claims exist and nothing is left.
 */
export function forYouToCheck(
  sections: CaseSections,
  claimRows: ClaimRow[],
  flags: LinkFlags = linkFlags(claimRows),
): { state: 'no_claims' | 'all_clear' | 'items'; items: ForYouItem[] } {
  // Items sharing a url, reason and label (one unreachable page behind several claims) become one line: the first,
  // counted. The label stays in the key so a competitor's product and pricing items remain separate lines.
  const merged = new Map<string, ForYouItem>();
  const item = (label: string, text: string, url: string, reason: string) => {
    const key = `${url}\n${reason}\n${label}`;
    const prev = merged.get(key);
    if (prev) prev.count++;
    else merged.set(key, { label, text: cleanQuote(text), url, reason, count: 1 });
  };
  for (const r of claimRows) {
    if (FOR_OWNER.has(r.verified)) item(SECTION_LABEL[r.section] ?? r.section, r.text, r.sourceUrl, r.reviewNote?.trim() || FIXED_REASON[r.verified] || r.verified);
  }
  for (const s of sections.evidence.signals) {
    // An expired YouTube signal has no text left to check.
    if (s.quote === EXPIRED_PLACEHOLDER) continue;
    if (!flags.signal.has(linkKey(s.url, s.quote))) item('Signal', s.quote, s.url, NOT_CHECKED_REASON);
  }
  for (const { label, sourced } of listInputs(sections.numbers.inputs)) {
    if (sourced.source && !flags.input.has(inputKey(label, sourced.value))) {
      item('Number input', inputKey(label, sourced.value), sourced.source.url, NOT_CHECKED_REASON);
    }
  }
  for (const x of sections.competitors.list) {
    // A legacy claim is listed above when unsettled, like any claim; it covers the product (and a quoted price).
    const legacy = flags.competitor.has(legacyCompetitorKey(x));
    if (!legacy && !flags.competitor.has(linkKey(x.url, x.name))) item('Competitor', x.name, x.url, NOT_CHECKED_REASON);
    // An existing pricing claim always wins (its own status is listed above when unsettled); otherwise the predicate.
    if (flags.competitorPricing.has(linkKey(x.url, competitorPricingText(x)))) continue;
    if (!hasPriceFigure(x.pricing)) item('Competitor pricing', x.name, x.url, UNPUBLISHED_PRICE_REASON);
    else if (!legacy) item('Competitor pricing', competitorPricingText(x), x.url, NOT_CHECKED_REASON);
  }
  const items = [...merged.values()];
  const state = claimRows.length === 0 ? 'no_claims' : items.length === 0 ? 'all_clear' : 'items';
  return { state, items };
}
