import { z } from 'zod';
import { loadPrompt, type LoadedPrompt } from '../../llm/prompts';
import type { CallCtx, ModelRouter } from '../../llm/types';
import { capField, wrapUntrusted } from '../../llm/untrusted';
import { errorMessage } from '../../tools/scrub';
import type { FewShot, SketchView } from './schema';

/** The judge's criteria, in the order of importance the prompt gives them (spec §4). */
export const JUDGE_CRITERIA = ['need', 'nonTrivial', 'earn', 'edge', 'evidence'] as const;
export type Criterion = (typeof JUDGE_CRITERIA)[number];

/** A sketch as the judge sees it, plus its cited evidence lines (voice, strength label, short quote or title). */
export type JudgeSketch = SketchView & { evidence?: string[] };

export type JudgeResult = {
  verdict: 'a' | 'b' | 'error';
  confidence: 1 | 2 | 3;
  reasons: Record<Criterion, string>;
  /** Why the call failed (the message only, scrubbed); set with verdict `error`. */
  error?: string;
};

/** Output limit for one judge call (a cap, not a cost): a winner, a confidence and five one-sentence reasons. */
const JUDGE_MAX_TOKENS = 800;
const REASON_MAX = 300;
const FIELD_MAX = 300;
const TITLE_MAX = 200;

const JudgeAnswerSchema = z.object({
  winner: z.enum(['A', 'B']),
  confidence: z.number().int().min(1).max(3),
  reasons: z.object(Object.fromEntries(JUDGE_CRITERIA.map((c) => [c, z.string()])) as Record<Criterion, z.ZodString>),
});

let prompt: LoadedPrompt | null = null;
const judgePrompt = () => (prompt ??= loadPrompt('judge'));

const noReasons = (): Record<Criterion, string> => Object.fromEntries(JUDGE_CRITERIA.map((c) => [c, ''])) as Record<Criterion, string>;

function block(s: JudgeSketch, withEvidence: boolean): string {
  const lines = [
    `Title: ${capField(s.title, TITLE_MAX)}`,
    `Buyer: ${capField(s.buyer, FIELD_MAX)}`,
    `Problem: ${capField(s.problem, FIELD_MAX)}`,
    `How it earns: ${capField(s.howItEarns, FIELD_MAX)}`,
    `Edge: ${capField(s.edge, FIELD_MAX)}`,
  ];
  if (s.whyNotTrivial) lines.push(`Why not trivial: ${capField(s.whyNotTrivial, FIELD_MAX)}`);
  if (withEvidence) {
    lines.push('Cited evidence:');
    lines.push(...(s.evidence?.length ? s.evidence.map((e) => `- ${capField(e, FIELD_MAX)}`) : ['(none cited)']));
  }
  return lines.join('\n');
}

function examples(fewShot: FewShot[]): string {
  if (!fewShot.length) return '(none yet)';
  return fewShot.map((p, i) => [
    `Example ${i + 1}: the owner kept "${capField(p.kept.title, TITLE_MAX)}" over "${capField(p.killed.title, TITLE_MAX)}" because ${capField(p.reason, FIELD_MAX)}`,
    'Kept:',
    block(p.kept, false),
    'Killed:',
    block(p.killed, false),
  ].join('\n')).join('\n\n');
}

/**
 * One judge call (model stage `judge`, prompt `judge.v1`): which of two sketches the owner should rather build, on the
 * spec §4 criteria in order, with the owner's few-shot examples. `a` is shown first. All sketch and example text is
 * wrapped as untrusted. A call that throws or answers outside the schema gives verdict `error` (never throws).
 */
export async function judgePair(
  a: JudgeSketch,
  b: JudgeSketch,
  deps: { router: ModelRouter; ctx: CallCtx; fewShot: FewShot[] },
): Promise<JudgeResult> {
  try {
    const p = judgePrompt();
    const out = await deps.router.structured('judge', {
      prompt: p.render({
        examples: wrapUntrusted('examples', examples(deps.fewShot)),
        sketchA: wrapUntrusted('sketch-a', block(a, true)),
        sketchB: wrapUntrusted('sketch-b', block(b, true)),
      }),
      schema: JudgeAnswerSchema,
      schemaName: 'judge_verdict',
      maxTokens: JUDGE_MAX_TOKENS,
    }, deps.ctx);
    const reasons = Object.fromEntries(JUDGE_CRITERIA.map((c) => [c, capField(out.reasons[c], REASON_MAX)])) as Record<Criterion, string>;
    return { verdict: out.winner === 'A' ? 'a' : 'b', confidence: out.confidence as 1 | 2 | 3, reasons };
  } catch (err) {
    // The message only: a validation error's issues can quote the model's answer.
    return { verdict: 'error', confidence: 1, reasons: noReasons(), error: errorMessage(err) };
  }
}
