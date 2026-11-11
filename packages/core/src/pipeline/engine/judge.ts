import { z } from 'zod';
import type { Db } from '../../db/client';
import { getSetting } from '../../validation/settings';
import { loadPrompt, type LoadedPrompt } from '../../llm/prompts';
import type { CallCtx, ModelRouter } from '../../llm/types';
import { capField, wrapUntrusted } from '../../llm/untrusted';
import { errorMessage } from '../../tools/scrub';
import type { FewShot, SketchView } from './schema';

/** The judge's criteria, in the order of importance the prompt gives them (spec §4). */
export const JUDGE_CRITERIA = ['need', 'nonTrivial', 'earn', 'edge', 'evidence'] as const;
export type Criterion = (typeof JUDGE_CRITERIA)[number];

/** A sketch as the judge sees it, plus its cited evidence lines (voice, strength label, short quote or title). */
export type JudgeSketch = SketchView & { evidence?: string[]; /** The idea's case summary text (calibration `--context case`); capped and wrapped with the sketch. */ caseText?: string };

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
/** Most characters of case text one sketch shows. */
export const CASE_TEXT_MAX = 1200;
/** The judge prompt version the tournament uses when setting `judge.promptVersion` is unset or invalid. */
export const JUDGE_DEFAULT_PROMPT = 1;

const JudgeAnswerSchema = z.object({
  winner: z.enum(['A', 'B']),
  confidence: z.number().int().min(1).max(3),
  reasons: z.object(Object.fromEntries(JUDGE_CRITERIA.map((c) => [c, z.string()])) as Record<Criterion, z.ZodString>),
});

const prompts = new Map<number, LoadedPrompt>();
const judgePrompt = (version: number) => {
  let p = prompts.get(version);
  if (!p) prompts.set(version, p = loadPrompt('judge', version));
  return p;
};

/** 'v2' or '2' (or the number 2) as 2; anything else null. */
export function parseJudgePromptVersion(v: unknown): number | null {
  const m = /^v?(\d+)$/.exec(String(v ?? '').trim());
  return m && Number(m[1]) >= 1 ? Number(m[1]) : null;
}

/** The live judge prompt version: setting `judge.promptVersion` ('v1', 'v2', ...), default v1; an unknown or missing version falls back to v1. */
export async function judgePromptVersion(db: Db): Promise<number> {
  const n = parseJudgePromptVersion(await getSetting(db, 'judge.promptVersion'));
  if (n === null) return JUDGE_DEFAULT_PROMPT;
  try { judgePrompt(n); return n; } catch { return JUDGE_DEFAULT_PROMPT; }
}

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
  if (withEvidence && s.caseText) lines.push(`Case summary: ${capField(s.caseText, CASE_TEXT_MAX)}`);
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
 * One judge call (model stage `judge`, prompt `judge.v<promptVersion>`, default v1): which of two sketches the owner should rather build, on the
 * spec §4 criteria in order, with the owner's few-shot examples. `a` is shown first. All sketch and example text is
 * wrapped as untrusted. A call that throws or answers outside the schema gives verdict `error` (never throws).
 */
export async function judgePair(
  a: JudgeSketch,
  b: JudgeSketch,
  deps: { router: ModelRouter; ctx: CallCtx; fewShot: FewShot[]; /** Pinned prompt version (default 1). */ promptVersion?: number },
): Promise<JudgeResult> {
  try {
    const p = judgePrompt(deps.promptVersion ?? JUDGE_DEFAULT_PROMPT);
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
