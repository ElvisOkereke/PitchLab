import { and, cosineDistance, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { AiScoresSchema, CRITERIA } from '../case/schema';
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

type Scored = { id: string; title: string; total: number; index: number; embedding: number[] | null; mechanism: string | null };

/** Why a ranked candidate must not advance, or null when it may. */
async function skipReason(db: Db, s: Scored, perMechanism: Map<string, number>, advancedVecs: number[][]): Promise<string | null> {
  if (s.mechanism && (perMechanism.get(s.mechanism) ?? 0) >= MAX_PER_MECHANISM) {
    return `${MAX_PER_MECHANISM} ideas with mechanism ${s.mechanism} already advanced`;
  }
  if (!s.embedding) return null;
  if (advancedVecs.some((v) => cosine(s.embedding!, v) > MAX_WINNER_SIMILARITY)) return 'near-twin of an idea already advanced in this run';
  const similarity = sql<number>`1 - (${cosineDistance(ideas.embedding, s.embedding)})`;
  const [hit] = await db
    .select({ id: ideas.id, sim: similarity })
    .from(ideas)
    .innerJoin(cases, eq(cases.ideaId, ideas.id))
    .where(and(ne(ideas.id, s.id), isNotNull(ideas.embedding), sql`${similarity} <> 'NaN'::float8`))
    .orderBy(desc(similarity))
    .limit(1);
  const sim = hit ? Number(hit.sim) : NaN;
  if (Number.isFinite(sim) && sim >= MAX_CASE_SIMILARITY) {
    return `similarity ${sim.toFixed(3)} to idea ${hit!.id}, which already has a case`;
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
    const total = CRITERIA.reduce((s, c) => s + scores[c].value, 0) / CRITERIA.length;
    await db.update(ideas).set({ screenScores: scores, screenTotal: total }).where(eq(ideas.id, idea.id));
    scored.push({ id: idea.id, title: idea.title, total, index, embedding: idea.embedding, mechanism: idea.mechanism });
  }

  // Top advanceCount by score, in rank order, skipping (→ screened_out) a candidate when
  //   (a) MAX_PER_MECHANISM generated ideas with its mechanism already advanced (a null mechanism is never capped),
  //   (b) it is a near-twin (cosine > 0.8, embeddings from dedupe) of an idea already advanced in this run, or
  //   (c) it is close (cosine >= 0.82) to an idea from any run that already has a case (a regenerated copy).
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
