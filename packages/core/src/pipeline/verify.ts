import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { claims } from '../db/schema';
import { loadPrompt } from '../llm/prompts';
import { capField, wrapUntrusted } from '../llm/untrusted';
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

export const MIN_JUDGE_CONFIDENCE = 0.6;
const MIN_QUOTE_WORDS = 6;
const MIN_QUOTE_CHARS = 30;

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

  const tally = { verified: 0, unsupported: 0, unreachable: 0, skipped: 0 };
  for (const claim of rows) {
    if (!claim.sourceUrl?.trim()) {
      tally.skipped++;
      continue;
    }
    const page = await getPage(claim.sourceUrl);
    let verified: 'verified' | 'unsupported' | 'unreachable';
    let confidence: number | null;

    if (!page.ok) {
      verified = 'unreachable';
      confidence = null;
    } else {
      const quote = normalize(claim.quote ?? '');
      const substantive = quote.split(' ').length >= MIN_QUOTE_WORDS && quote.length >= MIN_QUOTE_CHARS;
      if (substantive && normPage(claim.sourceUrl, page.text).includes(` ${quote} `)) {
        verified = 'verified';
        confidence = 1;
      } else {
        const excerpt = bestWindow(page.text, quote ? (claim.quote ?? '') : claim.text);
        const verdict = await router.structured(
          'verify',
          {
            prompt: prompt.render({
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
        verified = verdict.supported && confidence >= MIN_JUDGE_CONFIDENCE ? 'verified' : 'unsupported';
      }
    }
    tally[verified]++;
    await db.update(claims).set({ verified, confidence, checkedAt: new Date() }).where(eq(claims.id, claim.id));
  }

  log(`verify: ${tally.verified} verified, ${tally.unsupported} unsupported, ${tally.unreachable} unreachable, ${tally.skipped} skipped`);
  return { caseIds: input.caseIds };
}

