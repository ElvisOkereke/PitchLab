import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { claims } from '../db/schema';
import { loadPrompt } from '../llm/prompts';
import { capField, wrapUntrusted } from '../llm/untrusted';
import { isBannedSource } from '../tools/banned-sources';
import type { PageResult } from '../tools/fetch-page';
import type { RunConfig, StageDeps } from './types';

const WINDOW = 4000;
const STEP = 1000;

const VerdictSchema = z.object({ supported: z.boolean(), confidence: z.number() });

/** Lowercase, every run of non-letter/non-digit characters becomes one space, trimmed. */
export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const words = (s: string) => new Set(normalize(s).split(' ').filter(Boolean));

/** The 4000-char window (step 1000) of `text` containing the most distinct `needle` words; ties go to the earliest. */
export function bestWindow(text: string, needle: string): string {
  if (text.length <= WINDOW) return text;
  const wanted = words(needle);
  let best = 0;
  let bestScore = -1;
  for (let start = 0; start < text.length; start += STEP) {
    const w = words(text.slice(start, start + WINDOW));
    let score = 0;
    for (const x of wanted) if (w.has(x)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = start;
    }
    if (start + WINDOW >= text.length) break;
  }
  return text.slice(best, best + WINDOW);
}

/** A judge verdict at or above this confidence is final: verified when supported, unsupported when not. */
export const MIN_JUDGE_CONFIDENCE = 0.6;
/**
 * A verdict with confidence in [REVIEW_CONFIDENCE_FLOOR, MIN_JUDGE_CONFIDENCE) is too unsure to call either way, so the
 * claim goes to the owner as `needs_review` (whichever way the judge leaned). Below the floor it is `unsupported`.
 */
export const REVIEW_CONFIDENCE_FLOOR = 0.3;
export const UNREACHABLE_NOTE = 'page could not be loaded by the checker — open it yourself';
const MIN_QUOTE_WORDS = 6;
const MIN_QUOTE_CHARS = 30;
/**
 * A page that fetched fine but yields less readable text than this is treated as unreadable (typically rendered
 * client-side by JavaScript, so the fetcher sees an empty shell). Its claims are `unreachable`, not judged:
 * asking the judge about an empty page would wrongly flag a real source as `unsupported`.
 */
export const MIN_READABLE_CHARS = 200;

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export async function verify(
  { db, router, fetchPage, log }: StageDeps,
  run: { id: string; config: RunConfig },
  input: { caseIds: string[] },
): Promise<{ caseIds: string[] }> {
  if (input.caseIds.length === 0) return { caseIds: input.caseIds };

  const prompt = loadPrompt('verify-claim');
  const rows = await db.select().from(claims).where(inArray(claims.caseId, input.caseIds));
  const cache = new Map<string, Promise<PageResult>>();
  const normCache = new Map<string, string>();
  const normPage = (url: string, text: string) => {
    let n = normCache.get(url);
    if (n === undefined) normCache.set(url, (n = ` ${normalize(text)} `));
    return n;
  };
  const getPage = (url: string) => {
    let p = cache.get(url);
    if (!p) cache.set(url, (p = fetchPage(url)));
    return p;
  };

  const tally = { verified: 0, unsupported: 0, unreachable: 0, needs_review: 0, skipped: 0 };
  for (const claim of rows) {
    if (!claim.sourceUrl?.trim()) {
      tally.skipped++;
      continue;
    }
    if (isBannedSource(claim.sourceUrl)) {
      // A banned (or non-http / unparseable / IP) source never supports a claim: no fetch, no judge.
      tally.unsupported++;
      await db.update(claims).set({ verified: 'unsupported', confidence: null, reviewNote: null, checkedAt: new Date() }).where(eq(claims.id, claim.id));
      continue;
    }
    const page = await getPage(claim.sourceUrl);
    let verified: 'verified' | 'unsupported' | 'unreachable' | 'needs_review';
    let confidence: number | null;
    let reviewNote: string | null = null;

    if (!page.ok) {
      verified = 'unreachable';
      confidence = null;
      reviewNote = UNREACHABLE_NOTE;
    } else if (isBannedSource(page.finalUrl)) {
      // Redirected into a banned domain: the page is not an acceptable source, so no judge.
      verified = 'unsupported';
      confidence = null;
    } else {
      const quote = normalize(claim.quote ?? '');
      const substantive = quote.split(' ').length >= MIN_QUOTE_WORDS && quote.length >= MIN_QUOTE_CHARS;
      if (substantive && normPage(claim.sourceUrl, page.text).includes(` ${quote} `)) {
        verified = 'verified';
        confidence = 1;
      } else if (page.text.replace(/\s+/g, ' ').trim().length < MIN_READABLE_CHARS) {
        verified = 'unreachable';
        confidence = null;
        reviewNote = UNREACHABLE_NOTE;
      } else {
        const excerpt = bestWindow(page.text, quote ? (claim.quote ?? '') : claim.text);
        const verdict = await router.structured(
          'verify',
          {
            prompt: prompt.render({
              section: claim.section,
              claim: wrapUntrusted('claim', capField(claim.text, 2000)),
              quote: wrapUntrusted('quote', capField(claim.quote, 2000) || '(none given)'),
              page: wrapUntrusted('page-excerpt', excerpt.slice(0, WINDOW)),
            }),
            schema: VerdictSchema,
            schemaName: 'claim_verdict',
          },
          { runId: run.id, promptVersion: prompt.version },
        );
        confidence = clamp01(verdict.confidence);
        if (confidence >= MIN_JUDGE_CONFIDENCE) {
          verified = verdict.supported ? 'verified' : 'unsupported';
        } else if (confidence >= REVIEW_CONFIDENCE_FLOOR) {
          verified = 'needs_review';
          reviewNote = `checker unsure (confidence ${confidence.toFixed(2)})`;
        } else {
          verified = 'unsupported';
        }
      }
    }
    tally[verified]++;
    await db.update(claims).set({ verified, confidence, reviewNote, checkedAt: new Date() }).where(eq(claims.id, claim.id));
  }

  log(
    `verify: ${tally.verified} verified, ${tally.unsupported} unsupported, ${tally.unreachable} unreachable, ` +
      `${tally.needs_review} need review, ${tally.skipped} skipped`,
  );
  return { caseIds: input.caseIds };
}

