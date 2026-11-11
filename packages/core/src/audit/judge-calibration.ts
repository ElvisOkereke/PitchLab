import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, asc, count, desc, eq, gte, inArray, isNull, like, notInArray, sum } from 'drizzle-orm';
import type { Db } from '../db/client';
import { cases, ideaReviews, ideas, judgePairs, llmCalls } from '../db/schema';
import { loadPrompt } from '../llm/prompts';
import type { JudgeSketch } from '../pipeline/engine/judge';
import type { ModelRouter } from '../llm/types';
import { combine } from '../pipeline/engine/elo';
import { judgePair, judgePromptVersion, parseJudgePromptVersion } from '../pipeline/engine/judge';
import { getSetting, setSetting } from '../validation/settings';
import { FEWSHOT_PAIRS_MAX } from '../pipeline/engine/kinds';
import { reviewTotals } from './review';
import { fewShotPairsWithIds, ideaView, syncJudgePairs } from './judge-pairs';

/** Judge goals (spec §5): reported, never enforced. */
export const JUDGE_ACCURACY_GOAL = 0.7;
export const JUDGE_CONSISTENCY_GOAL = 0.8;
/** Under this many test pairs the numbers are noise. */
export const JUDGE_MIN_PAIRS = 10;
/** Most test pairs one calibration judges (two calls each) unless `limit` says fewer. */
export const JUDGE_PAIRS_MAX = 200;

export type JudgeReport = {
  pairs: number;
  accuracy: number;
  consistency: number;
  byConfidence: Record<1 | 2 | 3, { n: number; accuracy: number }>;
  /** Share of test pairs where the idea reviewer's score total ranks the kept idea higher (ties count half); null with no reviewed pair. */
  reviewerAccuracy: number | null;
  spentUsd: number;
  tooFew: boolean;
  /** Few-shot examples the judge was shown (picked exactly as the tournament picks them). */
  examples: number;
  /** Test pairs left out because they share an idea with an example (the judge could recognise it). */
  excludedPairs: number;
  /** Pairs judged without case text because only one of the two ideas has a case (`--context case`). */
  contextDropped?: number;
  /** The variant this run measured. */
  settings: JudgeVariantSettings;
  /** True when the settings equal the live configuration, so the run updates `audit.judge.latest`. */
  live: boolean;
};

export type JudgeVariantSettings = {
  /** Prompt name and version, e.g. `judge.v2`. */
  prompt: string;
  model: string;
  fewshot: number;
  context: 'idea' | 'case';
  /** ISO time; only pairs created at or after it were judged. */
  since: string | null;
  label: string | null;
};

export type CalibrateDeps = {
  db: Db; router: ModelRouter; log?: (m: string) => void; limit?: number;
  /** Prompt version to judge with ('v1', 'v2'); default the live one (setting `judge.promptVersion`). */
  prompt?: string;
  /** The judge model the router was built with for this run (`--model`); the router does the overriding. Counts as a variant. */
  model?: string;
  /** Few-shot examples shown, 0..12; default FEWSHOT_PAIRS_MAX. */
  fewshot?: number;
  /** `case` adds the idea's case summary text (capped, wrapped as untrusted). */
  context?: 'idea' | 'case';
  /** Only test pairs created at or after this time (a fresh holdout of new Board decisions). */
  since?: Date;
  label?: string;
};

const SETTING_KEY = 'audit.judge.latest';
const VARIANTS_KEY = 'audit.judge.variants';
/** Most variant summaries kept in `audit.judge.variants`. */
export const JUDGE_VARIANTS_MAX = 20;
export const JUDGE_FEWSHOT_LIMIT = 12;

/** The case text `--context case` shows: one-liner, why it wins and why now, from the case summary section. */
function caseTextOf(sections: unknown): string {
  const s = (sections as { summary?: Record<string, unknown> } | null)?.summary ?? {};
  return [['', s.oneLiner], ['Why it wins: ', s.whyItWins], ['Why now: ', s.whyNow]]
    .filter(([, v]) => typeof v === 'string' && v.trim())
    .map(([k, v]) => `${k}${v as string}`).join(' ');
}

async function judgeSpendUsd(db: Db): Promise<number> {
  const [row] = await db.select({ total: sum(llmCalls.costUsd) }).from(llmCalls)
    .where(and(isNull(llmCalls.runId), like(llmCalls.promptVersion, 'judge.%')));
  return Number(row?.total ?? 0);
}

/**
 * Judges the held-out (test) Board pairs, each twice with the order swapped, with the owner's training pairs as
 * few-shot examples picked exactly as the tournament picks them; test pairs that share an idea with an example are left
 * out (counted in `excludedPairs`). Accuracy is the share where the kept idea wins the combined result (a split, draw or error is a
 * miss); consistency is the share where both orders agree on a winner. A run with the live configuration stores a summary
 * in `audit.judge.latest`; a variant (other prompt, model, few-shot count, context or `since`) appends to `audit.judge.variants`
 * (last 20) and leaves the live summary alone.
 */
export async function calibrateJudge(deps: CalibrateDeps): Promise<JudgeReport> {
  const { db, router } = deps;
  const log = deps.log ?? (() => {});
  const spentBefore = await judgeSpendUsd(db);
  await syncJudgePairs(db);
  const limit = Math.max(1, Math.min(deps.limit ?? JUDGE_PAIRS_MAX, JUDGE_PAIRS_MAX));
  const promptNo = deps.prompt === undefined ? await judgePromptVersion(db) : parseJudgePromptVersion(deps.prompt);
  if (promptNo === null) throw new Error(`Not a judge prompt version: ${deps.prompt}`);
  const livePromptNo = await judgePromptVersion(db);
  const fewshotN = Math.max(0, Math.min(deps.fewshot ?? FEWSHOT_PAIRS_MAX, JUDGE_FEWSHOT_LIMIT));
  const context = deps.context ?? 'idea';
  const prompt = loadPrompt('judge', promptNo);
  const settings: JudgeVariantSettings = {
    prompt: prompt.version, model: deps.model ?? (await router.effectiveModel?.('judge')) ?? router.modelFor('judge'), fewshot: fewshotN, context,
    since: deps.since ? deps.since.toISOString() : null, label: deps.label?.trim() || null,
  };
  const live = promptNo === livePromptNo && deps.model === undefined && fewshotN === FEWSHOT_PAIRS_MAX && context === 'idea' && !deps.since && !deps.label?.trim();
  const isTest = deps.since ? and(eq(judgePairs.split, 'test'), gte(judgePairs.createdAt, deps.since)) : eq(judgePairs.split, 'test');
  const [{ n: testTotal } = { n: 0 }] = await db.select({ n: count() }).from(judgePairs).where(isTest);
  // The examples first, exactly as the tournament picks them (train split only), so calibration measures the same judge.
  const { shots: fewShot, ideaIds: shown } = testTotal > 0
    ? await fewShotPairsWithIds(db, fewshotN, router)
    : { shots: [], ideaIds: new Set<string>() };
  // Then only test pairs sharing no idea with an example (idea-level leakage would inflate accuracy).
  const clear = shown.size
    ? and(isTest, notInArray(judgePairs.keptIdeaId, [...shown]), notInArray(judgePairs.killedIdeaId, [...shown]))
    : isTest;
  const [{ n: clearTotal } = { n: 0 }] = shown.size ? await db.select({ n: count() }).from(judgePairs).where(clear) : [{ n: testTotal }];
  const excludedPairs = Math.max(0, testTotal - clearTotal);
  if (excludedPairs) log(`judge: ${excludedPairs} test pair(s) share an idea with the ${fewShot.length} example(s) and are left out`);
  const pairs = await db.select().from(judgePairs).where(clear).orderBy(asc(judgePairs.pairHash)).limit(limit);
  const ideaIds = [...new Set(pairs.flatMap((p) => [p.keptIdeaId, p.killedIdeaId]))];
  const rows = ideaIds.length ? await db.select().from(ideas).where(inArray(ideas.id, ideaIds)) : [];
  const caseTexts = new Map<string, string>();
  if (context === 'case' && ideaIds.length) {
    for (const c of await db.select({ id: cases.ideaId, sections: cases.sections }).from(cases).where(inArray(cases.ideaId, ideaIds))) {
      const t = caseTextOf(c.sections);
      if (t) caseTexts.set(c.id, t);
    }
  }
  const views = new Map(rows.map((r) => [r.id, ideaView(r)]));
  let contextDropped = 0;
  let callsOk = 0;
  const ctx = { runId: null, promptVersion: prompt.version };

  const byConf: Record<1 | 2 | 3, { n: number; right: number }> = { 1: { n: 0, right: 0 }, 2: { n: 0, right: 0 }, 3: { n: 0, right: 0 } };
  let right = 0;
  let agree = 0;
  let judged = 0;
  for (const p of pairs) {
    const kept = views.get(p.keptIdeaId);
    const killed = views.get(p.killedIdeaId);
    if (!kept || !killed) continue;
    // Case text goes on both sides or neither: a case on one side only would tell the judge which idea the owner engaged with.
    let shownKept: JudgeSketch = kept;
    let shownKilled: JudgeSketch = killed;
    if (context === 'case') {
      const kt = caseTexts.get(p.keptIdeaId);
      const xt = caseTexts.get(p.killedIdeaId);
      if (kt && xt) { shownKept = { ...kept, caseText: kt }; shownKilled = { ...killed, caseText: xt }; } else if (kt || xt) contextDropped++;
    }
    const jd = { router, ctx, fewShot, promptVersion: promptNo };
    // `ab` shows the kept idea first ('a' is the kept idea); `ba` shows the killed idea first.
    const [ab, ba] = await Promise.all([judgePair(shownKept, shownKilled, jd), judgePair(shownKilled, shownKept, jd)]);
    callsOk += (ab.verdict === 'error' ? 0 : 1) + (ba.verdict === 'error' ? 0 : 1);
    const result = combine(ab.verdict, ba.verdict);
    const consistent = result !== 'draw';
    judged++;
    if (consistent) agree++;
    if (result === 'a') right++;
    const failed = ab.verdict === 'error' || ba.verdict === 'error';
    const conf = (failed ? 1 : Math.min(ab.confidence, ba.confidence)) as 1 | 2 | 3;
    byConf[conf].n++;
    if (result === 'a') byConf[conf].right++;
    if (failed) log(`judge: pair ${p.pairHash.slice(0, 8)} had a failed call: ${ab.error ?? ba.error ?? ''}`);
  }

  if (judged > 0 && callsOk === 0) {
    throw new Error('Every judge call failed, so there is no accuracy to report (check the judge model and API key). Nothing was stored.');
  }

  const totals = await reviewTotals(db, ideaIds);
  let revN = 0;
  let revScore = 0;
  for (const p of pairs) {
    const k = totals.get(p.keptIdeaId);
    const x = totals.get(p.killedIdeaId);
    if (k === undefined || x === undefined) continue;
    revN++;
    revScore += k > x ? 1 : k === x ? 0.5 : 0;
  }

  const bucket = (b: { n: number; right: number }) => ({ n: b.n, accuracy: b.n ? b.right / b.n : 0 });
  const report: JudgeReport = {
    pairs: judged,
    accuracy: judged ? right / judged : 0,
    consistency: judged ? agree / judged : 0,
    byConfidence: { 1: bucket(byConf[1]), 2: bucket(byConf[2]), 3: bucket(byConf[3]) },
    reviewerAccuracy: revN ? revScore / revN : null,
    spentUsd: Math.max(0, (await judgeSpendUsd(db)) - spentBefore),
    tooFew: judged < JUDGE_MIN_PAIRS,
    examples: fewShot.length,
    excludedPairs,
    contextDropped,
    settings,
    live,
  };
  const at = new Date().toISOString();
  if (live) {
    await setSetting(db, SETTING_KEY, { at, model: settings.model, promptVersion: settings.prompt, accuracy: report.accuracy, consistency: report.consistency, pairs: report.pairs, tooFew: report.tooFew });
  } else {
    // A variant never touches the live summary the scorecard reads.
    const prev = await getSetting(db, VARIANTS_KEY);
    const list = Array.isArray(prev) ? prev : [];
    await setSetting(db, VARIANTS_KEY, [...list, { at, label: settings.label, settings, accuracy: report.accuracy, consistency: report.consistency, pairs: report.pairs }].slice(-JUDGE_VARIANTS_MAX));
  }
  return report;
}

const f2 = (n: number) => n.toFixed(2);
const goal = (v: number, g: number) => `${f2(v)} against the goal of ${f2(g)}: ${v >= g ? 'PASS' : 'FAIL'}`;

function settingsLines(r: JudgeReport): string[] {
  const s = r.settings;
  return [
    `Configuration (${r.live ? 'live' : 'variant, not written to the scorecard summary'}): prompt ${s.prompt}, model ${s.model}, few-shot ${s.fewshot}, context ${s.context}, since ${s.since ?? 'all'}${s.label ? `, label "${s.label}"` : ''}.`,
  ];
}

/** Markdown for output/audit/judge-<date>.md. */
export function renderJudgeReport(r: JudgeReport, date: string): string {
  const lines = [`# Judge calibration, ${date}${r.settings.label ? `: ${r.settings.label}` : ''}`, ''];
  lines.push(...settingsLines(r), '');
  lines.push(`Judged ${r.pairs} held-out Board pair(s), each twice with the order swapped. Cost $${r.spentUsd.toFixed(4)}.`, '');
  lines.push(`The judge saw ${r.examples} few-shot example(s), picked as the tournament picks them. ${r.excludedPairs} held-out pair(s) share an idea with an example and were left out.`, '');
  if (r.contextDropped) lines.push(`Case context: ${r.contextDropped} pair(s) had case text on only one side, so they were judged without it (it would reveal which idea you engaged with).`, '');
  if (r.tooFew) lines.push(`**Too few pairs:** ${r.pairs} is under ${JUDGE_MIN_PAIRS}, so these numbers are noise. Keep or kill more cases, then run it again.`, '');
  lines.push('## Goals', '');
  lines.push(`- Accuracy (the kept idea wins): ${goal(r.accuracy, JUDGE_ACCURACY_GOAL)}`);
  lines.push(`- Position consistency (both orders agree): ${goal(r.consistency, JUDGE_CONSISTENCY_GOAL)}`);
  lines.push('', '## By confidence', '', '| Confidence | Pairs | Accuracy |', '|---|---|---|');
  for (const c of [1, 2, 3] as const) lines.push(`| ${c} | ${r.byConfidence[c].n} | ${r.byConfidence[c].n ? f2(r.byConfidence[c].accuracy) : 'n/a'} |`);
  lines.push('', '## Reviewer comparison', '');
  lines.push(r.reviewerAccuracy === null
    ? 'Reviewer accuracy: no pair has a review on both ideas yet (run `gen audit review`).'
    : `Reviewer accuracy (the review score total ranks the kept idea higher): ${f2(r.reviewerAccuracy)}.`);
  lines.push('');
  return lines.join('\n');
}

/** Writes the report to `<dir>/judge-<date>.md` and returns the path. */
export function writeJudgeReport(r: JudgeReport, dir: string, date: string, now: Date = new Date()): string {
  mkdirSync(dir, { recursive: true });
  // A variant gets its own file (label slug) so same-day variants do not overwrite the live report or each other.
  const slug = r.live ? '' : `-${(r.settings.label ?? 'variant').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'variant'}`;
  const hms = now.toISOString().slice(11, 19).replace(/:/g, '');
  const path = join(dir, `judge-${date}${slug ? `${slug}-${hms}` : ''}.md`);
  writeFileSync(path, renderJudgeReport(r, date), 'utf8');
  return path;
}

/** The `gen audit judge` work: calibrate, write the report under `dir`, print a summary and the path. */
export async function runJudgeAudit(
  deps: CalibrateDeps & { dir: string; date: string; out: (s: string) => void },
): Promise<{ report: JudgeReport; path: string }> {
  const report = await calibrateJudge(deps);
  const path = writeJudgeReport(report, deps.dir, deps.date);
  if (report.tooFew) deps.out(`Too few pairs: ${report.pairs} held-out pair(s) is under ${JUDGE_MIN_PAIRS}, so the numbers are noise.`);
  if (report.excludedPairs) deps.out(`Left out ${report.excludedPairs} held-out pair(s) that share an idea with the ${report.examples} few-shot example(s).`);
  if (report.contextDropped) deps.out(`${report.contextDropped} pair(s) had case text on only one side and were judged without it.`);
  deps.out(`Judged ${report.pairs} pair(s): accuracy ${f2(report.accuracy)} (goal ${f2(JUDGE_ACCURACY_GOAL)}), position consistency ${f2(report.consistency)} (goal ${f2(JUDGE_CONSISTENCY_GOAL)}), cost $${report.spentUsd.toFixed(4)}.`);
  deps.out(`Written to ${path}`);
  return { report, path };
}
