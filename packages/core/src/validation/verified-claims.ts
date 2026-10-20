import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { money } from '../case/export-markdown';
import { claims } from '../db/schema';
import { capField, stripInvisible } from '../llm/untrusted';

/** Claim sections whose texts state facts or figures a draft or landing page could quote (as deep-case writes them). */
const QUOTABLE_SECTIONS = ['evidence', 'numbers'];
const MAX_CLAIMS = 10;
const CLAIM_MAX = 400;

/**
 * Rulings P3-R19/R20: the claim texts of a case that verification confirmed. The decision is made on the normalised
 * text (invisible characters stripped, whitespace collapsed, capped) across all quotable sections: a text is quotable
 * only when every row with that normalised text, in any section, is `verified`. Unsupported, unsure, unreachable and
 * unchecked claims are never offered as quotable. Deduplicated, capped.
 */
export async function verifiedClaimTexts(db: Db, caseId: string): Promise<string[]> {
  const rows = await db.select({ text: claims.text, verified: claims.verified })
    .from(claims)
    .where(and(eq(claims.caseId, caseId), inArray(claims.section, QUOTABLE_SECTIONS)))
    .orderBy(asc(claims.createdAt), asc(claims.id));
  const ok = new Map<string, boolean>(); // insertion order = first appearance
  for (const r of rows) {
    const key = capField(stripInvisible(r.text), CLAIM_MAX);
    if (!key) continue;
    ok.set(key, (ok.get(key) ?? true) && r.verified === 'verified');
  }
  return [...ok].filter(([, verified]) => verified).map(([text]) => text).slice(0, MAX_CLAIMS);
}

/**
 * The case's own offer terms, which the owner sets and may always state (P3-R22): its price ("99 per month"). The case
 * schema has no separate pilot-offer field (pitch.pricingCopy is free model text that may carry unverified figures, so
 * it is not exempt). These appear outside the untrusted block, so the unit is restricted to a plain phrase (P3-R23).
 */
export function allowedOfferTerms(sections: unknown): string[] {
  const price = offerPrice(sections);
  return price ? [price] : [];
}

/**
 * The case price as text, with the currency sign the case export uses ("$1 per load processed", "$1.50 per invoice"),
 * or '' without a finite numeric price. Without the sign the model copied "Pricing is 1 per load processed" verbatim
 * into a live draft and landing page (2026-10-19). The unit is kept only when it passes `PRICE_UNIT` (P3-R23).
 */
export function offerPrice(sections: unknown): string {
  const price = casePrice(sections);
  if (!price) return '';
  return PRICE_UNIT.test(price.per) ? `${money(price.amount)} per ${price.per}` : money(price.amount);
}

/**
 * True when the case has a price whose unit was given but dropped by the charset rule (P3-R23), so prompts show the
 * amount only. The caller logs it once so the owner knows to edit the unit; the unit text itself is not echoed.
 */
export function priceUnitDropped(sections: unknown): boolean {
  const price = casePrice(sections);
  return !!price && price.per !== '' && !PRICE_UNIT.test(price.per);
}

/** The case price with a finite numeric amount and its unit trimmed ('' when absent); null without one. */
function casePrice(sections: unknown): { amount: number; per: string } | null {
  const price = (sections as { summary?: { price?: { amount?: unknown; per?: unknown } } } | null)?.summary?.price;
  if (!price || typeof price.amount !== 'number' || !Number.isFinite(price.amount)) return null;
  return { amount: price.amount, per: typeof price.per === 'string' ? price.per.trim() : '' };
}

/**
 * Ruling P3-R23: the price unit is model-written text that lands in the trusted part of a prompt, so it must be a short
 * plain phrase ("month", "load processed", "seat/month"). Anything else (punctuation, newlines, markup, digits, longer
 * than 20 characters) drops the unit and keeps the amount only.
 */
const PRICE_UNIT = /^[a-z][a-z /-]{0,19}$/i;

/** The figures rule for a prompt, outside the untrusted block: verified claims, plus the case's own offer terms. */
export function figuresRule(verified: string[], allowed: string[] = []): string {
  const terms = allowed.length
    ? ` Allowed offer terms (the case's own price; you may state these exactly): ${allowed.join('; ')}.`
    : '';
  return verified.length > 0
    ? 'Figures: quote a number only when it appears in the case\'s verifiedClaims list (each was checked against its source) ' +
      `or in the allowed offer terms. Every other figure in the case is unverified: do not state it.${terms}`
    : 'There are no verified figures: do not state any figures (no numbers, percentages or amounts taken from the case) ' +
      `other than the allowed offer terms.${terms}`;
}
