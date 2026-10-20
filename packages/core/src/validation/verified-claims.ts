import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
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

/** The figures rule for a prompt, outside the untrusted block. */
export function figuresRule(verified: string[]): string {
  return verified.length > 0
    ? 'Figures: quote a number only when it appears in the case\'s verifiedClaims list (each was checked against its source). Every other figure in the case is unverified: do not state it.'
    : 'There are no verified figures: do not state any figures (no numbers, percentages or amounts taken from the case).';
}
