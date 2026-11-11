import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, asc, desc, eq, inArray, isNull, like, sum } from 'drizzle-orm';
import type { Db } from '../db/client';
import { ideaReviews, ideas, judgePairs, llmCalls } from '../db/schema';
import { loadPrompt } from '../llm/prompts';
import type { ModelRouter } from '../llm/types';
import { combine } from '../pipeline/engine/elo';
import { judgePair } from '../pipeline/engine/judge';
import { setSetting } from '../validation/settings';
import { fewShotPairs, ideaView, syncJudgePairs } from './judge-pairs';

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
};

export type CalibrateDeps = { db: Db; router: ModelRouter; log?: (m: string) => void; limit?: number };

const SETTING_KEY = 'audit.judge.latest';

async function judgeSpendUsd(db: Db): Promise<number> {
  const [row] = await db.select({ total: sum(llmCalls.costUsd) }).from(llmCalls)
    .where(and(isNull(llmCalls.runId), like(llmCalls.promptVersion, 'judge.%')));
  return Number(row?.total ?? 0);
}

/** The newest review total (scale + edge + novelty + niche) of each of the given ideas. */
async function reviewTotals(db: Db, ideaIds: string[]): Promise<Map<string, number>> {
  if (ideaIds.length === 0) return new Map();
  const rows = await db.select().from(ideaReviews).where(inArray(ideaReviews.ideaId, ideaIds))
    .orderBy(desc(ideaReviews.createdAt), desc(ideaReviews.id));
  const out = new Map<string, number>();
  for (const r of rows) if (!out.has(r.ideaId)) out.set(r.ideaId, r.scale + r.edge + r.novelty + r.niche);
  return out;
}

/**
 * Judges the held-out (test) Board pairs, each twice with the order swapped, with the owner's training pairs as
 * few-shot examples. Accuracy is the share where the kept idea wins the combined result (a split, draw or error is a
 * miss); consistency is the share where both orders agree on a winner. Stores a summary in `audit.judge.latest`.
 */
export async function calibrateJudge(deps: CalibrateDeps): Promise<JudgeReport> {
  const { db, router } = deps;
  const log = deps.log ?? (() => {});
  const spentBefore = await judgeSpendUsd(db);
  await syncJudgePairs(db);
  const limit = Math.max(1, Math.min(deps.limit ?? JUDGE_PAIRS_MAX, JUDGE_PAIRS_MAX));
  const pairs = await db.select().from(judgePairs).where(eq(judgePairs.split, 'test')).orderBy(asc(judgePairs.pairHash)).limit(limit);
  const ideaIds = [...new Set(pairs.flatMap((p) => [p.keptIdeaId, p.killedIdeaId]))];
  // No example may share an idea with a pair being judged (idea-level leakage would inflate accuracy).
  const fewShot = pairs.length ? await fewShotPairs(db, undefined, router, { excludeIdeaIds: new Set(ideaIds) }) : [];
  const rows = ideaIds.length ? await db.select().from(ideas).where(inArray(ideas.id, ideaIds)) : [];
  const views = new Map(rows.map((r) => [r.id, ideaView(r)]));
  const ctx = { runId: null, promptVersion: loadPrompt('judge').version };

  const byConf: Record<1 | 2 | 3, { n: number; right: number }> = { 1: { n: 0, right: 0 }, 2: { n: 0, right: 0 }, 3: { n: 0, right: 0 } };
  let right = 0;
  let agree = 0;
  let judged = 0;
  for (const p of pairs) {
    const kept = views.get(p.keptIdeaId);
    const killed = views.get(p.killedIdeaId);
    if (!kept || !killed) continue;
    const jd = { router, ctx, fewShot };
    // `ab` shows the kept idea first ('a' is the kept idea); `ba` shows the killed idea first.
    const [ab, ba] = await Promise.all([judgePair(kept, killed, jd), judgePair(killed, kept, jd)]);
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
  };
  await setSetting(db, SETTING_KEY, {
    at: new Date().toISOString(), accuracy: report.accuracy, consistency: report.consistency, pairs: report.pairs, tooFew: report.tooFew,
  });
  return report;
}

const f2 = (n: number) => n.toFixed(2);
const goal = (v: number, g: number) => `${f2(v)} against the goal of ${f2(g)}: ${v >= g ? 'PASS' : 'FAIL'}`;

/** Markdown for output/audit/judge-<date>.md. */
export function renderJudgeReport(r: JudgeReport, date: string): string {
  const lines = [`# Judge calibration, ${date}`, ''];
  lines.push(`Judged ${r.pairs} held-out Board pair(s), each twice with the order swapped. Cost $${r.spentUsd.toFixed(4)}.`, '');
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
export function writeJudgeReport(r: JudgeReport, dir: string, date: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `judge-${date}.md`);
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
  deps.out(`Judged ${report.pairs} pair(s): accuracy ${f2(report.accuracy)} (goal ${f2(JUDGE_ACCURACY_GOAL)}), position consistency ${f2(report.consistency)} (goal ${f2(JUDGE_CONSISTENCY_GOAL)}), cost $${report.spentUsd.toFixed(4)}.`);
  deps.out(`Written to ${path}`);
  return { report, path };
}
