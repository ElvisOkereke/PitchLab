import { and, cosineDistance, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { ideas } from '../db/schema';
import { capField } from '../llm/untrusted';
import type { RunConfig, StageDeps } from './types';

const PROMPT_VERSION = 'embed';

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

const validEmbedding = (v: unknown): v is number[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) && v.some((x) => x !== 0);

export async function dedupe(
  { db, router, log }: StageDeps,
  run: { id: string; config: RunConfig },
  input: { ideaIds: string[] },
): Promise<{ ideaIds: string[] }> {
  if (input.ideaIds.length === 0) return { ideaIds: [] };

  const rows = await db.select().from(ideas).where(inArray(ideas.id, input.ideaIds));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = input.ideaIds.map((id) => {
    const r = byId.get(id);
    if (!r) throw new Error(`dedupe: unknown idea ${id}`);
    return r;
  });

  const vectors = await router.embed(
    ordered.map((i) => `${i.title}\n${i.oneLiner}\n${i.problem}`),
    { runId: run.id, promptVersion: PROMPT_VERSION },
  );
  if (vectors.length !== ordered.length) throw new Error('dedupe: embedding count mismatch');

  const threshold = run.config.dedupeThreshold;
  const kept: { id: string; vec: number[] }[] = [];
  const keptIds: string[] = [];

  for (let i = 0; i < ordered.length; i++) {
    const idea = ordered[i]!;
    const vec = vectors[i];
    if (!validEmbedding(vec)) throw new Error(`invalid embedding for idea ${idea.id}`);
    await db.update(ideas).set({ embedding: vec }).where(eq(ideas.id, idea.id));

    let best: { id: string; sim: number } | null = null;
    const similarity = sql<number>`1 - (${cosineDistance(ideas.embedding, vec)})`;
    const [past] = await db
      .select({ id: ideas.id, sim: similarity })
      .from(ideas)
      .where(and(ne(ideas.runId, run.id), isNotNull(ideas.embedding), sql`${similarity} <> 'NaN'::float8`))
      .orderBy(desc(similarity))
      .limit(1);
    const pastSim = past ? Number(past.sim) : NaN;
    if (past && Number.isFinite(pastSim)) best = { id: past.id, sim: pastSim };
    for (const k of kept) {
      const sim = cosine(vec, k.vec);
      if (!Number.isFinite(sim)) continue;
      if (!best || sim > best.sim) best = { id: k.id, sim };
    }

    if (idea.origin === 'owner') {
      if (best) log(`dedupe: owner idea "${capField(idea.title, 120)}" nearest ${best.id} similarity ${best.sim.toFixed(3)} (kept)`);
      kept.push({ id: idea.id, vec });
      keptIds.push(idea.id);
    } else if (best && best.sim >= threshold) {
      await db.update(ideas).set({ status: 'duplicate', duplicateOf: best.id }).where(eq(ideas.id, idea.id));
    } else {
      kept.push({ id: idea.id, vec });
      keptIds.push(idea.id);
    }
  }
  log(`dedupe: ${keptIds.length}/${ordered.length} ideas kept`);
  return { ideaIds: keptIds };
}
