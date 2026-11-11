import { and, asc, cosineDistance, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { parse } from 'tldts';
import type { Db } from '../db/client';
import { knowledgeItems, knowledgeSources } from '../db/schema';
import { MERGE_SIMILARITY } from './store';
import { computeStrength, parseAssessment, type StrengthInput } from './strength';

export * from './strength';

/** Corroboration reads at most this many neighbour entries. */
export const CORROBORATION_NEIGHBOURS = 50;
/** One maintenance run refreshes at most this many assessed entries (the rest wait for the next run). */
export const REFRESH_MAX = 5000;
const REFRESH_BATCH = 100;
const CORROBORATION_SIMILARITY = MERGE_SIMILARITY;
const DOMAIN_ROWS_MAX = 1000;

/** The registrable domain of a source host (lower case); the host itself when it has none (a single label or an IP). */
function registrable(host: string): string {
  const h = host.trim().toLowerCase();
  return parse(h).domain ?? h;
}

/** A live (unexpired) source, for queries that read knowledge_sources directly. */
const liveSourceAt = (now: Date) => or(isNull(knowledgeSources.expiresAt), gt(knowledgeSources.expiresAt, now));

/**
 * Corroborating registrable domains: the entry's own live sources on distinct registrable domains beyond the first
 * (near-duplicates merge into one entry, so their sources live inside it), plus distinct registrable domains of other
 * active entries at cosine similarity 0.9 or more that are not among the entry's own domains. Reads at most
 * CORROBORATION_NEIGHBOURS neighbour entries (the closest first).
 */
export async function countCorroboration(db: Db, itemId: string, now: Date = new Date()): Promise<number> {
  const own = await db.select({ domain: knowledgeSources.domain, live: sql<boolean>`(${liveSourceAt(now)})` }).from(knowledgeSources)
    .where(eq(knowledgeSources.itemId, itemId)).orderBy(asc(knowledgeSources.domain)).limit(DOMAIN_ROWS_MAX);
  const ownDomains = new Set(own.map((r) => registrable(r.domain)));
  const ownExtra = Math.max(0, new Set(own.filter((r) => r.live).map((r) => registrable(r.domain))).size - 1);
  const [self] = await db.select({ embedding: knowledgeItems.embedding }).from(knowledgeItems).where(eq(knowledgeItems.id, itemId));
  if (!self?.embedding) return ownExtra;
  const neighbours = await db.select({ id: knowledgeItems.id }).from(knowledgeItems)
    .where(and(
      ne(knowledgeItems.id, itemId), eq(knowledgeItems.status, 'active'), isNotNull(knowledgeItems.embedding),
      sql`1 - (${cosineDistance(knowledgeItems.embedding, self.embedding)}) >= ${CORROBORATION_SIMILARITY}`,
    ))
    .orderBy(asc(cosineDistance(knowledgeItems.embedding, self.embedding)), asc(knowledgeItems.id))
    .limit(CORROBORATION_NEIGHBOURS);
  if (neighbours.length === 0) return ownExtra;
  const rows = await db.selectDistinct({ domain: knowledgeSources.domain }).from(knowledgeSources)
    .where(and(inArray(knowledgeSources.itemId, neighbours.map((n) => n.id)), liveSourceAt(now)))
    .orderBy(asc(knowledgeSources.domain)).limit(DOMAIN_ROWS_MAX);
  const domains = new Set(rows.map((r) => registrable(r.domain)).filter((d) => !ownDomains.has(d)));
  return ownExtra + domains.size;
}

/** What computeStrength needs for one entry, read from the entry, its live sources and its neighbours. */
export async function strengthInput(db: Db, itemId: string, now: Date): Promise<StrengthInput | null> {
  const [item] = await db.select({ voice: knowledgeItems.voice, quoteVerified: knowledgeItems.quoteVerified }).from(knowledgeItems).where(eq(knowledgeItems.id, itemId));
  if (!item) return null;
  const [agg] = await db.select({
    newest: sql<Date | string | null>`max(coalesce(${knowledgeSources.publishedAt}, ${knowledgeSources.fetchedAt}))`,
    types: sql<string[] | null>`array_agg(distinct ${knowledgeSources.sourceType})`,
  }).from(knowledgeSources).where(and(eq(knowledgeSources.itemId, itemId), liveSourceAt(now)));
  const newest = agg?.newest ? new Date(agg.newest) : null;
  return {
    voice: item.voice, quoteVerified: item.quoteVerified, corroboration: await countCorroboration(db, itemId, now),
    fetchedAt: newest && Number.isFinite(newest.getTime()) ? newest : null, sourceTypes: agg?.types ?? [],
  };
}

/**
 * Recomputes strength and corroboration of every assessed active entry (at most REFRESH_MAX per call, in id order).
 * Directness, bias and why are never touched. Returns how many entries changed.
 */
export async function refreshAssessments(db: Db, now: Date): Promise<{ updated: number }> {
  let updated = 0;
  let seen = 0;
  let after: string | null = null;
  while (seen < REFRESH_MAX) {
    const batch: { id: string; assessment: unknown }[] = await db.select({ id: knowledgeItems.id, assessment: knowledgeItems.assessment }).from(knowledgeItems)
      .where(and(eq(knowledgeItems.status, 'active'), isNotNull(knowledgeItems.assessment), after ? gt(knowledgeItems.id, after) : undefined))
      .orderBy(asc(knowledgeItems.id)).limit(REFRESH_BATCH);
    if (batch.length === 0) break;
    for (const row of batch) {
      seen++;
      after = row.id;
      const current = parseAssessment(row.assessment);
      if (!current) continue;
      const input = await strengthInput(db, row.id, now);
      if (!input) continue;
      const strength = computeStrength(input, now);
      if (strength === current.strength && input.corroboration === current.corroboration) continue;
      await db.update(knowledgeItems)
        .set({ assessment: sql`${knowledgeItems.assessment} || ${JSON.stringify({ strength, corroboration: input.corroboration })}::jsonb` })
        .where(eq(knowledgeItems.id, row.id));
      updated++;
    }
    if (batch.length < REFRESH_BATCH) break;
  }
  return { updated };
}
