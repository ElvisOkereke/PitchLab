import { and, cosineDistance, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { AiScoresSchema, CRITERIA, type AiScores } from '../case/schema';
import type { Db } from '../db/client';
import { cases, ideas } from '../db/schema';
import { loadPrompt } from '../llm/prompts';
import { capField, wrapUntrusted } from '../llm/untrusted';
import { valueMultiple, type Barriers } from './business-models';
import { cosine } from './dedupe';
import { ideaBlock } from './idea-text';
import type { ideas as ideasTable } from '../db/schema';
import type { RunConfig, StageDeps } from './types';

const MAX_WINNER_SIMILARITY = 0.8;
/** At most this many generated ideas per business model reach the gate in one run (a null model is not capped). */
export const MAX_PER_BUSINESS_MODEL = 2;
/** A candidate this close to an idea that already has a case (any run) is a regenerated copy and is skipped. */
export const MAX_CASE_SIMILARITY = 0.82;
/** A candidate this close to an idea (any run) the gate already killed is skipped: it would die the same way. */
export const MAX_KILLED_SIMILARITY = 0.75;

/**
 * Money case band from the value multiple (value to the user per year over price per year): >=10 -> 5, >=5 -> 4,
 * >=3 -> 3, >=1.5 -> 2, else 1. A null multiple (cannot be worked out) is 2.
 */
export function moneyBand(multiple: number | null): number {
  if (multiple === null || !Number.isFinite(multiple)) return 2;
  return multiple >= 10 ? 5 : multiple >= 5 ? 4 : multiple >= 3 ? 3 : multiple >= 1.5 ? 2 : 1;
}

/** Barrier score: easy to start (low toStart) and hard to copy (high toCopy) score high. round(((6 - toStart) + toCopy) / 2), 1-5; null is 3. */
export function barrierScore(b: Pick<Barriers, 'toStart' | 'toCopy'> | null | undefined): number {
  if (!b) return 3;
  return Math.min(5, Math.max(1, Math.round((6 - b.toStart + b.toCopy) / 2)));
}

/** Screen scores as stored: the model's seven criteria plus the two computed by code. */
export type ScreenScores = AiScores & { moneyCase: { value: number; note: string }; barrier: { value: number; note: string } };

/**
 * The screen total: the mean of 10 values, the 7 criteria plus novelty again plus moneyCase and barrier,
 * (sum of the 7 + novelty + moneyCase + barrier) / 10. Scores without moneyCase and barrier (screen.v3 and earlier)
 * keep the old form, (sum of the 7 + novelty) / 8.
 * (Tuning-4 removed the crowd penalty: it saturated on almost every idea. Old screenScores rows may still hold a
 * `knownCompetitors` list; it is ignored.)
 */
export function weightedScreenTotal(scores: AiScores | ScreenScores): number {
  const base = CRITERIA.reduce((s, c) => s + scores[c].value, 0) + scores.novelty.value;
  const extra = 'moneyCase' in scores && 'barrier' in scores ? [scores.moneyCase.value, scores.barrier.value] : [];
  return (base + extra.reduce((a, b) => a + b, 0)) / (CRITERIA.length + 1 + extra.length);
}

type Scored = {
  id: string; title: string; total: number; index: number; embedding: number[] | null;
  businessModel: string | null; audience: string | null;
};
const isConsumer = (s: { audience: string | null }) => s.audience === 'consumer' || s.audience === 'both';

/** The most similar other idea (by embedding) matching `extra`, or null; NaN similarities are ignored. */
async function closest(db: Db, s: Scored & { embedding: number[] }, extra: 'has_case' | 'gated_out'): Promise<{ id: string; sim: number } | null> {
  const similarity = sql<number>`1 - (${cosineDistance(ideas.embedding, s.embedding)})`;
  const base = and(ne(ideas.id, s.id), isNotNull(ideas.embedding), sql`${similarity} <> 'NaN'::float8`);
  const query = db.select({ id: ideas.id, sim: similarity }).from(ideas);
  const [hit] = await (extra === 'has_case'
    ? query.innerJoin(cases, eq(cases.ideaId, ideas.id)).where(base)
    : query.where(and(base, eq(ideas.status, 'gated_out')))
  )
    .orderBy(desc(similarity))
    .limit(1);
  const sim = hit ? Number(hit.sim) : NaN;
  return Number.isFinite(sim) ? { id: hit!.id, sim } : null;
}

/** Why a ranked candidate must not advance, or null when it may. */
async function skipReason(db: Db, s: Scored, perModel: Map<string, number>, advancedVecs: number[][]): Promise<string | null> {
  if (s.businessModel && (perModel.get(s.businessModel) ?? 0) >= MAX_PER_BUSINESS_MODEL) {
    return `${MAX_PER_BUSINESS_MODEL} ideas with business model ${s.businessModel} already advanced`;
  }
  if (!s.embedding) return null;
  const withVec = { ...s, embedding: s.embedding };
  if (advancedVecs.some((v) => cosine(withVec.embedding, v) > MAX_WINNER_SIMILARITY)) return 'near-twin of an idea already advanced in this run';
  const caseHit = await closest(db, withVec, 'has_case');
  if (caseHit && caseHit.sim >= MAX_CASE_SIMILARITY) {
    return `similarity ${caseHit.sim.toFixed(3)} to idea ${caseHit.id}, which already has a case`;
  }
  const killHit = await closest(db, withVec, 'gated_out');
  if (killHit && killHit.sim >= MAX_KILLED_SIMILARITY) {
    return `similarity ${killHit.sim.toFixed(3)} to idea ${killHit.id}, which the gate already killed`;
  }
  return null;
}

/** The idea block plus the new money and barrier fields, each capped; lines for absent fields are left out. */
function screenIdeaText(idea: typeof ideasTable.$inferSelect): string {
  const lines = [ideaBlock(idea)];
  if (idea.audience) lines.push(`Audience: ${idea.audience}`);
  if (idea.businessModel) lines.push(`Business model: ${idea.businessModel}`);
  if (idea.revenueMechanics) lines.push(`Revenue mechanics: ${capField(idea.revenueMechanics, 600)}`);
  if (idea.valueToUser) lines.push(`Value to the user: ${idea.valueToUser.amountPerYear} per year (${idea.valueToUser.kind}): ${capField(idea.valueToUser.basis, 400)}`);
  if (idea.priceHint) lines.push(`Price: ${idea.priceHint.amount} per ${capField(idea.priceHint.unit, 60)}: ${capField(idea.priceHint.basis, 300)}`);
  if (idea.barriers) lines.push(`Barrier to start (1 easy, 5 hard): ${idea.barriers.toStart}, ${capField(idea.barriers.toStartWhy, 300)}`, `Barrier to copy (1 easy, 5 hard): ${idea.barriers.toCopy}, ${capField(idea.barriers.toCopyWhy, 300)}`);
  return lines.join('\n');
}

export async function screen(
  { db, router, log }: StageDeps,
  run: { id: string; config: RunConfig },
  input: { ideaIds: string[] },
): Promise<{ ideaIds: string[] }> {
  if (input.ideaIds.length === 0) return { ideaIds: [] };

  const rows = await db.select().from(ideas).where(inArray(ideas.id, input.ideaIds));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = input.ideaIds.map((id) => {
    const r = byId.get(id);
    if (!r) throw new Error(`screen: unknown idea ${id}`);
    return r;
  });

  const owner = ordered.filter((i) => i.origin === 'owner');
  const generated = ordered.filter((i) => i.origin !== 'owner');

  for (const i of owner) await db.update(ideas).set({ status: 'advanced' }).where(eq(ideas.id, i.id));

  const prompt = loadPrompt('screen');
  const scored: Scored[] = [];
  let noMultiple = 0;
  for (const [index, idea] of generated.entries()) {
    const multiple = idea.valueToUser && idea.priceHint ? valueMultiple(idea.valueToUser, idea.priceHint) : null;
    if (multiple === null) noMultiple++;
    const money = moneyBand(multiple);
    const barrier = barrierScore(idea.barriers);
    const moneyNote = multiple === null ? 'no value multiple (value or price missing or not annual)' : `value multiple ${multiple.toFixed(1)}x`;
    const barrierNote = idea.barriers ? `toStart ${idea.barriers.toStart}, toCopy ${idea.barriers.toCopy}` : 'no barrier ratings';
    const computed = [
      `Money case (computed from ${multiple === null ? 'a value multiple that cannot be worked out' : `the value multiple ${multiple.toFixed(1)}x`}): ${money} of 5`,
      `Barrier (computed from ${barrierNote}; easy to start and hard to copy score high): ${barrier} of 5`,
    ].join('\n');
    // The model scores the seven criteria only; the two computed scores are added here and cannot be overridden.
    const modelScores = await router.structured(
      'screen',
      { prompt: prompt.render({ idea: wrapUntrusted('idea', screenIdeaText(idea)), computed }), schema: AiScoresSchema, schemaName: 'screen_scores' },
      { runId: run.id, promptVersion: prompt.version },
    );
    const scores: ScreenScores = { ...modelScores, moneyCase: { value: money, note: moneyNote }, barrier: { value: barrier, note: barrierNote } };
    const total = weightedScreenTotal(scores);
    log(`screen: "${capField(idea.title, 120)}" total ${total.toFixed(2)}`);
    await db.update(ideas).set({ screenScores: scores, screenTotal: total }).where(eq(ideas.id, idea.id));
    scored.push({ id: idea.id, title: idea.title, total, index, embedding: idea.embedding, businessModel: idea.businessModel, audience: idea.audience });
  }
  if (generated.length) log(`screen: ${noMultiple} of ${generated.length} ideas had no value multiple (moneyCase set to 2)`);

  // Top advanceCount by score, in rank order, skipping (-> screened_out) a candidate when
  //   (a) MAX_PER_BUSINESS_MODEL generated ideas with its business model already advanced (a null model is never capped),
  //   (b) it is a near-twin (cosine > 0.8, embeddings from dedupe) of an idea already advanced in this run, or
  //   (c) it is close (cosine >= 0.82) to an idea from any run that already has a case (a regenerated copy), or
  //   (d) it is close (cosine >= 0.75) to an idea from any run (this one included) that the gate already killed.
  // An idea without an embedding is never skipped for similarity. Owner ideas are never skipped and use no slot.
  scored.sort((a, b) => b.total - a.total || a.index - b.index);
  const ownerVecs = owner.flatMap((i) => (i.embedding ? [i.embedding] : []));
  const tally = (list: Scored[]) => {
    const m = new Map<string, number>();
    for (const w of list) if (w.businessModel) m.set(w.businessModel, (m.get(w.businessModel) ?? 0) + 1);
    return m;
  };
  const vecsOf = (list: Scored[]) => [...ownerVecs, ...list.flatMap((w) => (w.embedding ? [w.embedding] : []))];
  let winners: typeof scored = [];
  const losers: typeof scored = [];
  for (const s of scored) {
    if (winners.length >= run.config.advanceCount) {
      losers.push(s);
      continue;
    }
    const skip = await skipReason(db, s, tally(winners), vecsOf(winners));
    if (skip) {
      log(`screen: skipped "${capField(s.title, 120)}": ${skip}`);
      losers.push(s);
      continue;
    }
    winners.push(s);
  }

  // Keep at least one consumer or both entrant when any such candidate passes the checks above: the best one takes
  // the place of the lowest-ranked business entrant.
  if (winners.length && !winners.some(isConsumer)) {
    const victim = [...winners].reverse().find((w) => !isConsumer(w));
    if (victim) {
      const rest = winners.filter((w) => w !== victim);
      for (const c of losers.filter(isConsumer)) {
        if (await skipReason(db, c, tally(rest), vecsOf(rest))) continue;
        log(`screen: "${capField(c.title, 120)}" replaces "${capField(victim.title, 120)}" to keep a consumer entrant`);
        winners = [...rest, c].sort((a, b) => b.total - a.total || a.index - b.index);
        losers.splice(losers.indexOf(c), 1, victim);
        break;
      }
    }
  }
  if (winners.length) await db.update(ideas).set({ status: 'advanced' }).where(inArray(ideas.id, winners.map((w) => w.id)));
  if (losers.length) await db.update(ideas).set({ status: 'screened_out' }).where(inArray(ideas.id, losers.map((w) => w.id)));

  const advanced = [...owner.map((i) => i.id), ...winners.map((w) => w.id)];
  log(`screen: ${advanced.length} advanced, ${losers.length} screened out`);
  return { ideaIds: advanced };
}
