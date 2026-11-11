import { and, cosineDistance, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { cases, ideas, lenses, sketches } from '../../db/schema';
import { cosine } from '../dedupe';
import type { RunConfig, StageDeps } from '../types';
import { SKETCH_DUPLICATE_SIM, SKETCH_KILLED_SIM, type BuyerKind } from './kinds';

const PROMPT_VERSION = 'embed';
const PROSUMER = /freelanc|creator|\bsolo\b|independent|small team/i;

/** The buyer kind: a consumer lens is consumer; a buyer who is a freelancer, creator, solo, independent or small team is prosumer; else business. */
export function buyerKind(buyer: string, lensAudience: string): BuyerKind {
  if (lensAudience === 'consumer') return 'consumer';
  return PROSUMER.test(buyer) ? 'prosumer' : 'business';
}

/** The diversity cell: buyer kind, edge kind and business model, joined by `|`. */
export function cellOf(s: { buyerKind: string; edgeKind: string; businessModel?: string | null }): string {
  return `${s.buyerKind}|${s.edgeKind}|${s.businessModel ?? 'none'}`;
}

const validEmbedding = (v: unknown): v is number[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) && v.some((x) => x !== 0);

/** The highest similarity (finite only) from `table.embedding` to `vec` among rows matching `where`. */
async function maxSim(db: Db, source: 'ideas' | 'sketches' | 'killed_cases', vec: number[], runId: string): Promise<number> {
  const sim = (col: typeof ideas.embedding | typeof sketches.embedding) => sql<number>`1 - (${cosineDistance(col, vec)})`;
  let rows: { sim: number }[];
  if (source === 'sketches') {
    const s = sim(sketches.embedding);
    rows = await db.select({ sim: s }).from(sketches)
      .where(and(ne(sketches.runId, runId), isNotNull(sketches.embedding), sql`${s} <> 'NaN'::float8`)).orderBy(desc(s)).limit(1);
  } else if (source === 'ideas') {
    const s = sim(ideas.embedding);
    rows = await db.select({ sim: s }).from(ideas)
      .where(and(ne(ideas.runId, runId), isNotNull(ideas.embedding), sql`${s} <> 'NaN'::float8`)).orderBy(desc(s)).limit(1);
  } else {
    const s = sim(ideas.embedding);
    rows = await db.select({ sim: s }).from(ideas).innerJoin(cases, eq(cases.ideaId, ideas.id))
      .where(and(eq(cases.stage, 'killed'), ne(ideas.runId, runId), isNotNull(ideas.embedding), sql`${s} <> 'NaN'::float8`)).orderBy(desc(s)).limit(1);
  }
  const v = rows[0] ? Number(rows[0].sim) : NaN;
  return Number.isFinite(v) ? v : -1;
}

async function maxKilledSim(db: Db, vec: number[], runId: string): Promise<number> {
  const s = sql<number>`1 - (${cosineDistance(ideas.embedding, vec)})`;
  const [gate] = await db.select({ sim: s }).from(ideas)
    .where(and(eq(ideas.status, 'gated_out'), ne(ideas.runId, runId), isNotNull(ideas.embedding), sql`${s} <> 'NaN'::float8`)).orderBy(desc(s)).limit(1);
  const g = gate ? Number(gate.sim) : NaN;
  return Math.max(Number.isFinite(g) ? g : -1, await maxSim(db, 'killed_cases', vec, runId));
}

export type ArchiveOutput = { sketchIds: string[]; signalIds: string[]; uniqueShare: number; cells: number };

/**
 * The archive stage (engine v2, spec §3; code only): embeds the run's sketches, marks `duplicate` (cosine at least
 * SKETCH_DUPLICATE_SIM to an earlier sketch or idea of any other run) or `near_killed` (at least SKETCH_KILLED_SIM to a
 * gate-killed idea or owner-killed case), then within-run twins (first kept), files the kept ones under their diversity
 * cell and reports unique share and cells filled. Idempotent: statuses are reset first. The input is passed on (R1).
 */
export async function archive(
  { db, router, log }: StageDeps,
  run: { id: string; config: RunConfig },
  input: { sketchIds: string[] } & Record<string, unknown>,
): Promise<Record<string, unknown> & ArchiveOutput> {
  const signalIds = Array.isArray(input.signalIds) ? (input.signalIds as string[]) : [];
  if (input.sketchIds.length === 0) return { ...input, sketchIds: [], signalIds, uniqueShare: 0, cells: 0 };

  const rows = await db.select().from(sketches).where(inArray(sketches.id, input.sketchIds));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = input.sketchIds.map((id) => {
    const r = byId.get(id);
    if (!r) throw new Error(`archive: unknown sketch ${id}`);
    return r;
  });
  const lensIds = [...new Set(ordered.map((r) => r.lensId).filter((x): x is string => !!x))];
  const audience = new Map(lensIds.length
    ? (await db.select({ id: lenses.id, audience: lenses.audience }).from(lenses).where(inArray(lenses.id, lensIds))).map((l) => [l.id, l.audience] as const)
    : []);

  const vectors = await router.embed(
    ordered.map((s) => `${s.title}\n${s.buyer}\n${s.problem}\n${s.howItEarns}`),
    { runId: run.id, promptVersion: PROMPT_VERSION },
  );
  if (vectors.length !== ordered.length) throw new Error('archive: embedding count mismatch');

  const kept: { id: string; vec: number[]; cell: string }[] = [];
  let duplicates = 0, nearKilled = 0;
  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i]!;
    const vec = vectors[i];
    if (!validEmbedding(vec)) throw new Error(`archive: invalid embedding for sketch ${s.id}`);
    const cell = cellOf({ buyerKind: buyerKind(s.buyer, (s.lensId && audience.get(s.lensId)) || 'business'), edgeKind: s.edgeKind, businessModel: s.businessModel });

    let status: 'kept' | 'duplicate' | 'near_killed' = 'kept';
    const earlier = Math.max(await maxSim(db, 'sketches', vec, run.id), await maxSim(db, 'ideas', vec, run.id));
    if (earlier >= SKETCH_DUPLICATE_SIM) status = 'duplicate';
    else if (await maxKilledSim(db, vec, run.id) >= SKETCH_KILLED_SIM) status = 'near_killed';
    else if (kept.some((k) => cosine(vec, k.vec) >= SKETCH_DUPLICATE_SIM)) status = 'duplicate';

    await db.update(sketches).set({ embedding: vec, cell, status }).where(eq(sketches.id, s.id));
    if (status === 'kept') kept.push({ id: s.id, vec, cell });
    else if (status === 'duplicate') duplicates++;
    else nearKilled++;
  }

  const cells = new Set(kept.map((k) => k.cell)).size;
  const uniqueShare = kept.length / ordered.length;
  log(`archive: ${kept.length}/${ordered.length} sketches kept (${duplicates} duplicate, ${nearKilled} near killed), unique share ${uniqueShare.toFixed(2)}, ${cells} cells`);
  if (kept.length === 0) log('archive: no sketch left; the run ends here');
  return { ...input, sketchIds: kept.map((k) => k.id), signalIds, uniqueShare, cells };
}
