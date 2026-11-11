import { and, eq, inArray, like, ne, sum } from 'drizzle-orm';
import { fewShotPairs } from '../../audit/judge-pairs';
import type { Db } from '../../db/client';
import { knowledgeItems, llmCalls, signals, sketches, tournamentMatches } from '../../db/schema';
import { parseAssessment, strengthLabel } from '../../library/strength';
import { loadPrompt } from '../../llm/prompts';
import type { CallCtx } from '../../llm/types';
import { capField } from '../../llm/untrusted';
import { errorMessage } from '../../tools/scrub';
import { seededRandom } from '../seed-context';
import type { RunConfig, StageDeps } from '../types';
import { byeKey, combine, pairKey, swissPairs, topByCell, topByElo, update, type MatchResult, type Verdict } from './elo';
import { judgePair, type JudgeResult, type JudgeSketch } from './judge';
import { ELO_START, JUDGE_CALLS_MAX, MAX_PER_BUSINESS_MODEL, MAX_PER_CELL, SWISS_ROUNDS, TOP_SKETCHES } from './kinds';
import type { FewShot } from './schema';

export { topByCell, topByElo } from './elo';

/** Evidence the judge sees per sketch: its first cited signals and library entries. */
const EVIDENCE_SIGNALS_MAX = 3;
const EVIDENCE_LIBRARY_MAX = 3;
const QUOTE_MAX = 160;
const LIBRARY_TITLE_MAX = 120;

type Deps = Pick<StageDeps, 'db' | 'router' | 'log'>;
type SketchRow = {
  id: string; title: string; buyer: string; problem: string; howItEarns: string; edge: string; whyNotTrivial: string;
  cell: string | null; elo: number | null; signalIds: string[]; libraryItemIds: string[];
};
type MatchRow = typeof tournamentMatches.$inferSelect;

const labelOf = (assessment: unknown): string => {
  const a = parseAssessment(assessment);
  return a ? `, ${strengthLabel(a)}` : '';
};

/**
 * Each sketch's evidence lines for the judge: a cited signal shows its voice, the strength label of the library entry it
 * was promoted from (when assessed) and a short quote; a cited library entry shows its kind, strength label and title.
 * Missing rows and missing assessments are skipped, never an error. Bounded: a few ids per sketch, one query per table.
 */
async function loadEvidence(db: Db, rows: SketchRow[]): Promise<Map<string, string[]>> {
  const sigIds = [...new Set(rows.flatMap((r) => r.signalIds.slice(0, EVIDENCE_SIGNALS_MAX)))];
  const libIds = [...new Set(rows.flatMap((r) => r.libraryItemIds.slice(0, EVIDENCE_LIBRARY_MAX)))];
  const sig = new Map((sigIds.length
    ? await db.select({ id: signals.id, voice: signals.voice, quote: signals.quote, assessment: knowledgeItems.assessment })
      .from(signals).leftJoin(knowledgeItems, eq(signals.knowledgeItemId, knowledgeItems.id)).where(inArray(signals.id, sigIds))
    : []).map((s) => [s.id, `signal, ${s.voice ?? 'untagged'} voice${labelOf(s.assessment)}: "${capField(s.quote, QUOTE_MAX)}"`] as const));
  const lib = new Map((libIds.length
    ? await db.select({ id: knowledgeItems.id, kind: knowledgeItems.kind, title: knowledgeItems.title, assessment: knowledgeItems.assessment })
      .from(knowledgeItems).where(inArray(knowledgeItems.id, libIds))
    : []).map((k) => [k.id, `library ${k.kind} entry${labelOf(k.assessment)}: ${capField(k.title, LIBRARY_TITLE_MAX)}`] as const));
  return new Map(rows.map((r) => [r.id, [
    ...r.signalIds.slice(0, EVIDENCE_SIGNALS_MAX).flatMap((id) => sig.get(id) ?? []),
    ...r.libraryItemIds.slice(0, EVIDENCE_LIBRARY_MAX).flatMap((id) => lib.get(id) ?? []),
  ]]));
}

const matchKey = (round: number, a: string, b: string) => `${round}|${a}|${b}`;

/**
 * Plays `rounds` Swiss rounds (spec §4) over `sketchIds` in one phase and returns every sketch's rating.
 *
 * - Each sketch starts at `o.start` (when given), else its stored elo, else ELO_START (Ruling R3).
 * - Pairing is seeded by run id and phase, so a resumed run computes the same pairs; pairs already played in another
 *   phase of the run are not replayed where avoidable.
 * - Each match is judged twice, A/B then B/A; only agreeing calls decide it (an error or a split is a draw, logged).
 * - Each match is stored in `tournament_matches` before ratings move; a stored match (same phase, round and pair) is
 *   replayed instead of judged again, so a resume neither re-pays nor double-counts.
 * - Stops when the next match would pass `maxCalls` (stored matches count: they were paid for).
 * - Stored matches of this phase that the replay no longer reaches (a changed sketch set) are removed.
 * - Writes `sketches.elo` once, at the end, in one transaction: an interrupted phase leaves the pre-phase ratings, so a
 *   resume starts from them again. A caller re-running a finished phase must restore the pre-phase ratings first (the
 *   main stage resets them to null) or pass them as `o.start`.
 */
export async function runTournament(
  { db, router, log }: Deps,
  run: { id: string },
  o: { phase: 'main' | 'final'; sketchIds: string[]; rounds: number; maxCalls: number; start?: Map<string, number> },
): Promise<Map<string, number>> {
  const ids = [...new Set(o.sketchIds)];
  if (ids.length === 0) return new Map();
  const found = await db.select({
    id: sketches.id, title: sketches.title, buyer: sketches.buyer, problem: sketches.problem, howItEarns: sketches.howItEarns,
    edge: sketches.edge, whyNotTrivial: sketches.whyNotTrivial, cell: sketches.cell, elo: sketches.elo,
    signalIds: sketches.signalIds, libraryItemIds: sketches.libraryItemIds,
  }).from(sketches).where(inArray(sketches.id, ids));
  const byId = new Map(found.map((r) => [r.id, r as SketchRow]));
  for (const id of ids) if (!byId.has(id)) throw new Error(`tournament: unknown sketch ${id}`);

  const ratings = new Map(ids.map((id) => [id, o.start?.get(id) ?? byId.get(id)!.elo ?? ELO_START]));
  const stored = new Map((await db.select().from(tournamentMatches)
    .where(and(eq(tournamentMatches.runId, run.id), eq(tournamentMatches.phase, o.phase))))
    .map((m) => [matchKey(m.round, m.aId, m.bId), m]));
  const played = new Set((await db.select({ a: tournamentMatches.aId, b: tournamentMatches.bId }).from(tournamentMatches)
    .where(and(eq(tournamentMatches.runId, run.id), ne(tournamentMatches.phase, o.phase))))
    .map((m) => pairKey(m.a, m.b)));

  // Loaded only when a call is needed: a full replay touches neither.
  let judgeInputs: Promise<{ views: Map<string, JudgeSketch>; fewShot: FewShot[] }> | null = null;
  const loadJudgeInputs = () => (judgeInputs ??= (async () => {
    const evidence = await loadEvidence(db, [...byId.values()]);
    const views = new Map([...byId.values()].map((r) => [r.id, {
      title: r.title, buyer: r.buyer, problem: r.problem, howItEarns: r.howItEarns, edge: r.edge, whyNotTrivial: r.whyNotTrivial,
      evidence: evidence.get(r.id) ?? [],
    }]));
    let fewShot: FewShot[] = [];
    try {
      fewShot = await fewShotPairs(db);
    } catch (err) {
      log(`tournament: few-shot pairs unavailable (${errorMessage(err)}), judging without them`);
    }
    return { views, fewShot };
  })());
  const ctx: CallCtx = { runId: run.id, promptVersion: loadPrompt('judge').version };

  const judgeMatch = async (round: number, a: string, b: string): Promise<MatchResult> => {
    const { views, fewShot } = await loadJudgeInputs();
    const deps = { router, ctx, fewShot };
    const ab = await judgePair(views.get(a)!, views.get(b)!, deps);
    const ba = await judgePair(views.get(b)!, views.get(a)!, deps);
    const result = combine(ab.verdict as Verdict, ba.verdict as Verdict);
    const failed = ([['A first', ab], ['B first', ba]] as const).filter(([, r]) => r.verdict === 'error');
    for (const [order, r] of failed) log(`tournament: judge error (${o.phase} round ${round}, ${a} vs ${b}, ${order}: ${r.error ?? 'invalid answer'}); the match counts as a draw`);
    const ok = [ab, ba].filter((r): r is JudgeResult & { verdict: 'a' | 'b' } => r.verdict !== 'error');
    const confidence = ok.length ? ok.reduce((s, r) => s + r.confidence, 0) / ok.length : 0;
    const reasons = { ab: ab.reasons, ba: ba.reasons, ...(failed.length ? { errors: failed.map(([order, r]) => `${order}: ${r.error ?? 'invalid answer'}`) } : {}) };
    const [inserted] = await db.insert(tournamentMatches).values({
      runId: run.id, phase: o.phase, round, aId: a, bId: b, verdictAB: ab.verdict, verdictBA: ba.verdict, result, confidence, reasons,
    }).onConflictDoNothing().returning({ result: tournamentMatches.result });
    if (inserted) return inserted.result;
    // Another worker stored this match first: its result counts, so both agree.
    const [existing] = await db.select({ result: tournamentMatches.result }).from(tournamentMatches).where(and(
      eq(tournamentMatches.runId, run.id), eq(tournamentMatches.phase, o.phase), eq(tournamentMatches.round, round),
      eq(tournamentMatches.aId, a), eq(tournamentMatches.bId, b)));
    return existing!.result;
  };

  const rand = seededRandom(run.id + o.phase);
  const used = new Set<string>();
  let calls = 0;
  let stopped = false;
  for (let round = 1; round <= o.rounds && !stopped; round++) {
    const pairs = swissPairs(ids.map((id) => ({ id, elo: ratings.get(id)!, cell: byId.get(id)!.cell })), round, played, rand);
    if (pairs.length === 0) {
      log(`tournament: no new pairs left in ${o.phase} round ${round}; stopping`);
      break;
    }
    const paired = new Set(pairs.flat());
    for (const id of ids) if (!paired.has(id)) played.add(byeKey(id));

    const results: Promise<MatchResult>[] = [];
    for (const [a, b] of pairs) {
      if (calls + 2 > o.maxCalls) { stopped = true; break; }
      calls += 2;
      const key = matchKey(round, a, b);
      const prior: MatchRow | undefined = stored.get(key);
      used.add(key);
      results.push(prior ? Promise.resolve(prior.result) : judgeMatch(round, a, b));
    }
    // Pairs in a round are disjoint, so updating in pair order after the round equals updating after each match.
    const settled = await Promise.all(results);
    settled.forEach((result, i) => {
      const [a, b] = pairs[i]!;
      const [ra, rb] = update(ratings.get(a)!, ratings.get(b)!, result);
      ratings.set(a, ra);
      ratings.set(b, rb);
      played.add(pairKey(a, b));
    });
    if (stopped) log(`tournament: ${o.phase} judge budget reached (${calls} of ${o.maxCalls} calls), stopping in round ${round}`);
  }

  const stale = [...stored.entries()].filter(([k]) => !used.has(k)).map(([, m]) => m.id);
  await db.transaction(async (tx) => {
    if (stale.length) await tx.delete(tournamentMatches).where(inArray(tournamentMatches.id, stale));
    for (const [id, elo] of ratings) await tx.update(sketches).set({ elo }).where(eq(sketches.id, id));
  });
  if (stale.length) log(`tournament: removed ${stale.length} stored ${o.phase} matches no longer played`);
  return ratings;
}

export type TournamentOutput = {
  /** The top TOP_SKETCHES by Elo under the hard cell and business model caps (fewer when the caps bind; all with 12 or fewer). */
  sketchIds: string[];
  signalIds: string[];
  matches: number;
  /** Judge spend of the run so far (llm_calls with a judge.* prompt version). */
  spentUsd: number;
  /** Every input sketch's rating after the main tournament (a later phase can start from these). */
  ratings: Record<string, number>;
};

/**
 * The tournament stage (engine v2, spec §4): SWISS_ROUNDS swapped-pair Swiss rounds over the archive's kept sketches,
 * at most JUDGE_CALLS_MAX judge calls, then the top TOP_SKETCHES by Elo with at most MAX_PER_CELL per cell and
 * MAX_PER_BUSINESS_MODEL per business model. If every judge call failed, the top are picked by diversity cell in sketch
 * order with a warning; the run goes on. Idempotent (R20): ratings restart from null and stored matches are replayed.
 * The input is passed on (Ruling R1).
 */
export async function tournament(
  { db, router, log }: StageDeps,
  run: { id: string; config: RunConfig },
  input: { sketchIds: string[] } & Record<string, unknown>,
): Promise<Record<string, unknown> & TournamentOutput> {
  const signalIds = Array.isArray(input.signalIds) ? (input.signalIds as string[]) : [];
  const sketchIds = Array.isArray(input.sketchIds) ? input.sketchIds : [];
  if (sketchIds.length === 0) return { ...input, sketchIds: [], signalIds, matches: 0, spentUsd: 0, ratings: {} };

  // The main phase is the first: every sketch starts fresh, so a re-run replays its stored matches from ELO_START.
  await db.update(sketches).set({ elo: null }).where(inArray(sketches.id, sketchIds));
  const ratings = await runTournament({ db, router, log }, run, { phase: 'main', sketchIds, rounds: SWISS_ROUNDS, maxCalls: JUDGE_CALLS_MAX });

  const rows = await db.select({ id: sketches.id, elo: sketches.elo, cell: sketches.cell, businessModel: sketches.businessModel, createdAt: sketches.createdAt })
    .from(sketches).where(inArray(sketches.id, sketchIds));
  const ms = await db.select({ ab: tournamentMatches.verdictAB, ba: tournamentMatches.verdictBA }).from(tournamentMatches)
    .where(and(eq(tournamentMatches.runId, run.id), eq(tournamentMatches.phase, 'main')));
  const allFailed = ms.length > 0 && ms.every((m) => m.ab === 'error' && m.ba === 'error');
  const top = allFailed ? topByCell(rows) : topByElo(rows);
  const want = Math.min(TOP_SKETCHES, rows.length);
  if (top.length < want) log(`tournament: caps left ${top.length} of ${want} (at most ${MAX_PER_CELL} per cell and ${MAX_PER_BUSINESS_MODEL} per business model)`);
  if (allFailed) log(`tournament: warning: every judge call failed (${ms.length} matches); the top ${top.length} are picked by diversity cell in sketch order`);

  const [spend] = await db.select({ total: sum(llmCalls.costUsd) }).from(llmCalls)
    .where(and(eq(llmCalls.runId, run.id), like(llmCalls.promptVersion, 'judge.%')));
  const spentUsd = Number(spend?.total ?? 0);
  log(`tournament: ${ms.length} matches over ${sketchIds.length} sketches, top ${top.length} go on; judge spend $${spentUsd.toFixed(2)}`);
  return { ...input, sketchIds: top, signalIds, matches: ms.length, spentUsd, ratings: Object.fromEntries(ratings) };
}
