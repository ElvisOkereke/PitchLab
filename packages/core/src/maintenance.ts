import { and, eq, inArray, isNotNull, lt, notExists, sql } from 'drizzle-orm';
import type { Db } from './db/client';
import { cases, claims, knowledgeItems, knowledgeSources, pageFetches, signals } from './db/schema';

const DAY = 86_400_000;
export const FETCH_RETENTION_DAYS = 90;
export const YOUTUBE_RETENTION_DAYS = 30;
export const EXPIRED_PLACEHOLDER = '[expired YouTube data]';
export const YOUTUBE_CLAIM_NOTE = 'YouTube quote removed after 30 days';

export type MaintenanceResult = {
  prunedFetches: number;
  expiredSources: number;
  deletedItems: number;
  redactedSignals: number;
  redactedClaims: number;
  /** One message per failed step (the other steps still ran). */
  errors: string[];
};

/**
 * Housekeeping: prune the fetch log, delete expired sources (and entries left empty), redact expired YouTube data. Idempotent.
 * Each step runs in its own transaction and is isolated: a failing step is reported in `errors` and the others still run.
 */
export async function runMaintenance(db: Db, now: Date = new Date()): Promise<MaintenanceResult> {
  const fetchCutoff = new Date(now.getTime() - FETCH_RETENTION_DAYS * DAY);
  const ytCutoff = new Date(now.getTime() - YOUTUBE_RETENTION_DAYS * DAY);
  const errors: string[] = [];
  const step = async <T>(name: string, fallback: T, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      return fallback;
    }
  };

  const prunedFetches = await step('prune fetches', 0, async () => (await db.transaction((tx) =>
    tx.delete(pageFetches).where(lt(pageFetches.at, fetchCutoff)).returning({ id: pageFetches.id }))).length);

  const { expiredSources, deletedItems } = await step('expire sources', { expiredSources: 0, deletedItems: 0 }, () => db.transaction(async (tx) => {
    const gone = await tx.delete(knowledgeSources)
      .where(and(isNotNull(knowledgeSources.expiresAt), lt(knowledgeSources.expiresAt, now)))
      .returning({ itemId: knowledgeSources.itemId });
    const itemIds = [...new Set(gone.map((g) => g.itemId))];
    let deleted = 0;
    if (itemIds.length) {
      const empty = (await tx.select({ id: knowledgeItems.id }).from(knowledgeItems)
        .where(and(inArray(knowledgeItems.id, itemIds), notExists(tx.select({ one: sql`1` }).from(knowledgeSources).where(eq(knowledgeSources.itemId, knowledgeItems.id))))))
        .map((r) => r.id);
      if (empty.length) {
        // signals.knowledge_item_id is provenance only (the signal text is redacted below); without this the FK blocks the delete.
        await tx.update(signals).set({ knowledgeItemId: null }).where(inArray(signals.knowledgeItemId, empty));
        deleted = (await tx.delete(knowledgeItems).where(inArray(knowledgeItems.id, empty)).returning({ id: knowledgeItems.id })).length;
      }
    }
    return { expiredSources: gone.length, deletedItems: deleted };
  }));

  const redactedSignals = await step('redact signals', 0, () => db.transaction(async (tx) => {
    // One statement. signals.quote is NOT NULL, so `<>` never skips a row through NULL semantics. sha256() is built into PG 11+.
    const res = await tx.update(signals).set({
      quote: EXPIRED_PLACEHOLDER,
      title: EXPIRED_PLACEHOLDER,
      embedding: null,
      quoteHash: sql`encode(sha256(convert_to(${EXPIRED_PLACEHOLDER} || ${signals.id}::text, 'UTF8')), 'hex')`,
    }).where(and(eq(signals.source, 'youtube'), lt(signals.createdAt, ytCutoff), sql`${signals.quote} <> ${EXPIRED_PLACEHOLDER}`))
      .returning({ id: signals.id });
    return res.length;
  }));

  const redactedClaims = await step('redact claims', 0, () => db.transaction(async (tx) => {
    const host = sql`lower(regexp_replace(${claims.sourceUrl}, '^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^/?#@]*@)?([^/?#:]*).*$', '\\1'))`;
    const old = tx.select({ id: cases.id }).from(cases).where(lt(cases.createdAt, ytCutoff));
    // youtube.com and any subdomain (www., m., music.), plus youtu.be; "notyoutube.com" does not match.
    const isYoutube = sql`(${host} in ('youtube.com', 'youtu.be') or ${host} like '%.youtube.com')`;
    const res = await tx.update(claims)
      .set({ quote: null, reviewNote: YOUTUBE_CLAIM_NOTE })
      .where(and(isNotNull(claims.quote), inArray(claims.caseId, old), isYoutube))
      .returning({ id: claims.id });
    return res.length;
  }));

  return { prunedFetches, expiredSources, deletedItems, redactedSignals, redactedClaims, errors };
}

/** runMaintenance for startup paths: logs one count line (only when something changed) and never throws. */
export async function runMaintenanceQuietly(db: Db, log: (line: string) => void, now?: Date): Promise<void> {
  try {
    const m = await runMaintenance(db, now);
    const total = m.prunedFetches + m.expiredSources + m.deletedItems + m.redactedSignals + m.redactedClaims;
    if (total > 0) log(`Maintenance: ${total} old records cleaned up.`);
    for (const e of m.errors) log(`Maintenance step failed: ${e}`);
  } catch (err) {
    log(`Maintenance skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}
