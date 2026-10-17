import { eq, inArray } from 'drizzle-orm';
import { AiScoresSchema, CRITERIA } from '../case/schema';
import { ideas } from '../db/schema';
import { loadPrompt } from '../llm/prompts';
import { wrapUntrusted } from '../llm/untrusted';
import { cosine } from './dedupe';
import { ideaBlock } from './idea-text';
import type { RunConfig, StageDeps } from './types';

const MAX_WINNER_SIMILARITY = 0.8;

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
  const scored: { id: string; total: number; index: number; embedding: number[] | null }[] = [];
  for (const [index, idea] of generated.entries()) {
    const scores = await router.structured(
      'screen',
      { prompt: prompt.render({ idea: wrapUntrusted('idea', ideaBlock(idea)) }), schema: AiScoresSchema, schemaName: 'screen_scores' },
      { runId: run.id, promptVersion: prompt.version },
    );
    const total = CRITERIA.reduce((s, c) => s + scores[c].value, 0) / CRITERIA.length;
    await db.update(ideas).set({ screenScores: scores, screenTotal: total }).where(eq(ideas.id, idea.id));
    scored.push({ id: idea.id, total, index, embedding: idea.embedding });
  }

  // Top advanceCount by score, skipping a candidate that is a near-twin (cosine > 0.8, embeddings from dedupe)
  // of an idea already advanced in this run. An idea without an embedding is never skipped.
  scored.sort((a, b) => b.total - a.total || a.index - b.index);
  const advancedVecs = owner.flatMap((i) => (i.embedding ? [i.embedding] : []));
  const winners: typeof scored = [];
  const losers: typeof scored = [];
  for (const s of scored) {
    const twin = s.embedding !== null && advancedVecs.some((v) => cosine(s.embedding!, v) > MAX_WINNER_SIMILARITY);
    if (winners.length < run.config.advanceCount && !twin) {
      winners.push(s);
      if (s.embedding) advancedVecs.push(s.embedding);
    } else {
      losers.push(s);
    }
  }
  if (winners.length) await db.update(ideas).set({ status: 'advanced' }).where(inArray(ideas.id, winners.map((w) => w.id)));
  if (losers.length) await db.update(ideas).set({ status: 'screened_out' }).where(inArray(ideas.id, losers.map((w) => w.id)));

  const advanced = [...owner.map((i) => i.id), ...winners.map((w) => w.id)];
  log(`screen: ${advanced.length} advanced, ${losers.length} screened out`);
  return { ideaIds: advanced };
}
