import { and, cosineDistance, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { AiScoresSchema, CRITERIA, type AiScores } from '../case/schema';
import type { Db } from '../db/client';
import { cases, ideas } from '../db/schema';
import { loadPrompt } from '../llm/prompts';
import { capField, wrapUntrusted } from '../llm/untrusted';
import { cosine } from './dedupe';
import { ideaBlock } from './idea-text';
import type { RunConfig, StageDeps } from './types';

const MAX_WINNER_SIMILARITY = 0.8;
/** At most this many generated ideas per declared mechanism reach the gate in one run. */
export const MAX_PER_MECHANISM = 2;
/** A candidate this close to an idea that already has a case (any run) is a regenerated copy and is skipped. */
export const MAX_CASE_SIMILARITY = 0.82;
/** A candidate this close to an idea (any run) the gate already killed is skipped: it would die the same way. */
export const MAX_KILLED_SIMILARITY = 0.75;

/**
 * The screen total: mean of the 7 criteria with novelty counted twice, (sum of the 7 values + novelty) / 8.
 * (Tuning-4 removed the crowd penalty: it saturated on almost every idea. Old screenScores rows may still hold a
 * `knownCompetitors` list; it is ignored.)
 */
export function weightedScreenTotal(scores: AiScores): number {
  return (CRITERIA.reduce((s, c) => s + scores[c].value, 0) + scores.novelty.value) / (CRITERIA.length + 1);
}

type Scored = { id: string; title: string; total: number; index: number; embedding: number[] | null; mechanism: string | null };

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
async function skipReason(db: Db, s: Scored, perMechanism: Map<string, number>, advancedVecs: number[][]): Promise<string | null> {
  if (s.mechanism && (perMechanism.get(s.mechanism) ?? 0) >= MAX_PER_MECHANISM) {
    return `${MAX_PER_MECHANISM} ideas with mechanism ${s.mechanism} already advanced`;
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
  for (const [index, idea] of generated.entries()) {
    const scores = await router.structured(
      'screen',
      { prompt: prompt.render({ idea: wrapUntrusted('idea', ideaBlock(idea)) }), schema: AiScoresSchema, schemaName: 'screen_scores' },
      { runId: run.id, promptVersion: prompt.version },
    );
    // Rank by the novelty-weighted mean.
    const total = weightedScreenTotal(scores);
    log(`screen: "${capField(idea.title, 120)}" total ${total.toFixed(2)}`);
    await db.update(ideas).set({ screenScores: scores, screenTotal: total }).where(eq(ideas.id, idea.id));
    scored.push({ id: idea.id, title: idea.title, total, index, embedding: idea.embedding, mechanism: idea.mechanism });
  }

  // Top advanceCount by score, in rank order, skipping (→ screened_out) a candidate when
  //   (a) MAX_PER_MECHANISM generated ideas with its mechanism already advanced (a null mechanism is never capped),
  //   (b) it is a near-twin (cosine > 0.8, embeddings from dedupe) of an idea already advanced in this run, or
  //   (c) it is close (cosine >= 0.82) to an idea from any run that already has a case (a regenerated copy), or
  //   (d) it is close (cosine >= 0.75) to an idea from any run (this one included) that the gate already killed.
  // An idea without an embedding is never skipped for similarity. Owner ideas are never skipped and use no slot.
  scored.sort((a, b) => b.total - a.total || a.index - b.index);
  const advancedVecs = owner.flatMap((i) => (i.embedding ? [i.embedding] : []));
  const perMechanism = new Map<string, number>();
  const winners: typeof scored = [];
  const losers: typeof scored = [];
  for (const s of scored) {
    if (winners.length >= run.config.advanceCount) {
      losers.push(s);
      continue;
    }
    const skip = await skipReason(db, s, perMechanism, advancedVecs);
    if (skip) {
      log(`screen: skipped "${capField(s.title, 120)}": ${skip}`);
      losers.push(s);
      continue;
    }
    winners.push(s);
    if (s.embedding) advancedVecs.push(s.embedding);
    if (s.mechanism) perMechanism.set(s.mechanism, (perMechanism.get(s.mechanism) ?? 0) + 1);
  }
  if (winners.length) await db.update(ideas).set({ status: 'advanced' }).where(inArray(ideas.id, winners.map((w) => w.id)));
  if (losers.length) await db.update(ideas).set({ status: 'screened_out' }).where(inArray(ideas.id, losers.map((w) => w.id)));

  const advanced = [...owner.map((i) => i.id), ...winners.map((w) => w.id)];
  log(`screen: ${advanced.length} advanced, ${losers.length} screened out`);
  return { ideaIds: advanced };
}
