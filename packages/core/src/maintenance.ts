import { createHash } from 'node:crypto';
import { and, eq, inArray, isNotNull, lt, notExists, sql } from 'drizzle-orm';
import type { Db } from './db/client';
import { cases, claims, knowledgeItems, knowledgeSources, pageFetches, signals } from './db/schema';

const DAY = 86_400_000;
export const FETCH_RETENTION_DAYS = 90;
export const YOUTUBE_RETENTION_DAYS = 30;
export const EXPIRED_PLACEHOLDER = '[expired YouTube data]';
export const YOUTUBE_CLAIM_NOTE = 'YouTube quote removed after 30 days';
const YOUTUBE_HOSTS = ['youtube.com', 'www.youtube.com', 'youtu.be'];

export type MaintenanceResult = {
  prunedFetches: number;
  expiredSources: number;
  deletedItems: number;
  redactedSignals: number;
  redactedClaims: number;
};

/** Housekeeping: prune the fetch log, delete expired sources (and entries left empty), redact expired YouTube data. Idempotent. */
export async function runMaintenance(db: Db, now: Date = new Date()): Promise<MaintenanceResult> {
  const fetchCutoff = new Date(now.getTime() - FETCH_RETENTION_DAYS * DAY);
  const ytCutoff = new Date(now.getTime() - YOUTUBE_RETENTION_DAYS * DAY);

  const prunedFetches = (await db.transaction((tx) =>
    tx.delete(pageFetches).where(lt(pageFetches.at, fetchCutoff)).returning({ id: pageFetches.id }))).length;

  const { expiredSources, deletedItems } = await db.transaction(async (tx) => {
    const gone = await tx.delete(knowledgeSources)
      .where(and(isNotNull(knowledgeSources.expiresAt), lt(knowledgeSources.expiresAt, now)))
      .returning({ itemId: knowledgeSources.itemId });
    const itemIds = [...new Set(gone.map((g) => g.itemId))];
    let deleted = 0;
    if (itemIds.length) {
      deleted = (await tx.delete(knowledgeItems)
        .where(and(inArray(knowledgeItems.id, itemIds), notExists(tx.select({ one: sql`1` }).from(knowledgeSources).where(eq(knowledgeSources.itemId, knowledgeItems.id)))))
        .returning({ id: knowledgeItems.id })).length;
    }
    return { expiredSources: gone.length, deletedItems: deleted };
  });

  const redactedSignals = await db.transaction(async (tx) => {
    const due = await tx.select({ id: signals.id }).from(signals)
      .where(and(eq(signals.source, 'youtube'), lt(signals.createdAt, ytCutoff), sql`${signals.quote} <> ${EXPIRED_PLACEHOLDER}`));
    for (const { id } of due) {
      const quoteHash = createHash('sha256').update(EXPIRED_PLACEHOLDER + id).digest('hex');
      await tx.update(signals).set({ quote: EXPIRED_PLACEHOLDER, title: EXPIRED_PLACEHOLDER, embedding: null, quoteHash }).where(eq(signals.id, id));
    }
    return due.length;
  });

  const redactedClaims = await db.transaction(async (tx) => {
    const hostOnly = sql`lower(regexp_replace(${claims.sourceUrl}, '^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^/?#@]*@)?([^/?#:]*).*$', '\\1'))`;
    const old = tx.select({ id: cases.id }).from(cases).where(lt(cases.createdAt, ytCutoff));
    const res = await tx.update(claims)
      .set({ quote: null, reviewNote: YOUTUBE_CLAIM_NOTE })
      .where(and(isNotNull(claims.quote), inArray(claims.caseId, old), sql`${hostOnly} in (${sql.join(YOUTUBE_HOSTS.map((h) => sql`${h}`), sql`, `)})`))
      .returning({ id: claims.id });
    return res.length;
  });

  return { prunedFetches, expiredSources, deletedItems, redactedSignals, redactedClaims };
}

/** runMaintenance for startup paths: logs one count line (only when something changed) and never throws. */
export async function runMaintenanceQuietly(db: Db, log: (line: string) => void, now?: Date): Promise<void> {
  try {
    const m = await runMaintenance(db, now);
    const total = m.prunedFetches + m.expiredSources + m.deletedItems + m.redactedSignals + m.redactedClaims;
    if (total > 0) log(`Maintenance: ${total} old records cleaned up.`);
  } catch (err) {
    log(`Maintenance skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}
