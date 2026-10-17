import { eq, inArray } from 'drizzle-orm';
import { AiScoresSchema, CRITERIA } from '../case/schema';
import { ideas } from '../db/schema';
import { loadPrompt } from '../llm/prompts';
import { capField, wrapUntrusted } from '../llm/untrusted';
import type { RunConfig, StageDeps } from './types';

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
  const scored: { id: string; total: number; index: number }[] = [];
  for (const [index, idea] of generated.entries()) {
    const text = `Title: ${capField(idea.title, 200)}\nOne-liner: ${capField(idea.oneLiner, 2000)}\nBuyer: ${capField(idea.buyer, 2000)}\nProblem: ${capField(idea.problem, 2000)}\nSolution: ${capField(idea.solution, 2000)}`;
    const scores = await router.structured(
      'screen',
      { prompt: prompt.render({ idea: wrapUntrusted('idea', text) }), schema: AiScoresSchema, schemaName: 'screen_scores' },
      { runId: run.id, promptVersion: prompt.version },
    );
    const total = CRITERIA.reduce((s, c) => s + scores[c].value, 0) / CRITERIA.length;
    await db.update(ideas).set({ screenScores: scores, screenTotal: total }).where(eq(ideas.id, idea.id));
    scored.push({ id: idea.id, total, index });
  }

  scored.sort((a, b) => b.total - a.total || a.index - b.index);
  const winners = scored.slice(0, run.config.advanceCount);
  const losers = scored.slice(run.config.advanceCount);
  if (winners.length) await db.update(ideas).set({ status: 'advanced' }).where(inArray(ideas.id, winners.map((w) => w.id)));
  if (losers.length) await db.update(ideas).set({ status: 'screened_out' }).where(inArray(ideas.id, losers.map((w) => w.id)));

  const advanced = [...owner.map((i) => i.id), ...winners.map((w) => w.id)];
  log(`screen: ${advanced.length} advanced, ${losers.length} screened out`);
  return { ideaIds: advanced };
}
