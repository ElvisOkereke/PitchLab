import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { claims } from '../db/schema';
import { capField } from '../llm/untrusted';

/** Claim sections whose texts state facts or figures a draft or landing page could quote (as deep-case writes them). */
const QUOTABLE_SECTIONS = ['evidence', 'numbers'];
const MAX_CLAIMS = 10;
const CLAIM_MAX = 400;

/**
 * Ruling P3-R19: the claim texts of a case that verification confirmed, grouped by (section, text) as deep-case wrote
 * them; a text counts only when every row with that section and text is `verified`. Unsupported, unsure, unreachable and
 * unchecked claims are never offered as quotable. Deduplicated, capped.
 */
export async function verifiedClaimTexts(db: Db, caseId: string): Promise<string[]> {
  const rows = await db.select({ section: claims.section, text: claims.text, verified: claims.verified })
    .from(claims)
    .where(and(eq(claims.caseId, caseId), inArray(claims.section, QUOTABLE_SECTIONS)))
    .orderBy(asc(claims.createdAt), asc(claims.id));
  const ok = new Map<string, boolean>();
  for (const r of rows) {
    const key = `${r.section}\n${r.text}`;
    ok.set(key, (ok.get(key) ?? true) && r.verified === 'verified');
  }
  const out: string[] = [];
  for (const [key, verified] of ok) {
    const text = capField(key.slice(key.indexOf('\n') + 1), CLAIM_MAX);
    if (verified && text && !out.includes(text)) out.push(text);
  }
  return out.slice(0, MAX_CLAIMS);
}

/** The figures rule for a prompt, outside the untrusted block. */
export function figuresRule(verified: string[]): string {
  return verified.length > 0
    ? 'Figures: quote a number only when it appears in the case\'s verifiedClaims list (each was checked against its source). Every other figure in the case is unverified: do not state it.'
    : 'There are no verified figures: do not state any figures (no numbers, percentages or amounts taken from the case).';
}
