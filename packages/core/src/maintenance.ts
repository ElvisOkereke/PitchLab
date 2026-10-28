import { and, eq, inArray, isNotNull, lt, lte, notExists, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from './db/client';
import { pacificDate } from './research/sources/youtube';
import { cases, claims, knowledgeItems, knowledgeSources, pageFetches, signals } from './db/schema';

const DAY = 86_400_000;
export const FETCH_RETENTION_DAYS = 90;
export const QUOTA_ROW_RETENTION_DAYS = 7;
export const YOUTUBE_RETENTION_DAYS = 30;
export const EXPIRED_PLACEHOLDER = '[expired YouTube data]';
export const YOUTUBE_CLAIM_NOTE = 'YouTube quote removed after 30 days';

/** Whitespace-collapsed text, as harvest's collapse() stores a promoted library quote (whitespace runs to one space, trimmed). */
const collapsed = (col: SQL) => sql`btrim(regexp_replace(${col}, '\\s+', ' ', 'g'))`;

/** youtube.com and any subdomain (www., m., music.), plus youtu.be; "notyoutube.com" does not match. */
function isYoutubeUrl(url: SQL): SQL {
  const host = sql`lower(regexp_replace(${url}, '^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^/?#@]*@)?([^/?#:]*).*$', '\\1'))`;
  return sql`(${host} in ('youtube.com', 'youtu.be') or ${host} like '%.youtube.com')`;
}

export type MaintenanceResult = {
  prunedFetches: number;
  prunedQuotaRows: number;
  expiredSources: number;
  deletedItems: number;
  redactedSignals: number;
  redactedClaims: number;
  /** Cases whose evidence signals had a YouTube quote replaced. */
  redactedCases: number;
  /** One message per failed step (the other steps still ran). */
  errors: string[];
};

/**
 * Housekeeping: prune the fetch log, delete expired sources (and entries left empty), redact expired YouTube data, prune old YouTube quota rows. Idempotent.
 * Each step runs in its own transaction and is isolated: a failing step is reported in `errors` and the others still run.
 */
export async function runMaintenance(db: Db, now: Date = new Date()): Promise<MaintenanceResult> {
  const fetchCutoff = new Date(now.getTime() - FETCH_RETENTION_DAYS * DAY);
  const ytCutoff = new Date(now.getTime() - YOUTUBE_RETENTION_DAYS * DAY);
  const nowParam = sql`${now.toISOString()}::timestamptz`;
  /** Correlated on alias `s`: an unexpired YouTube library source for this url (raw qualified column names, never unqualified). */
  const liveYoutubeSource = (urlCol: SQL) =>
    sql`s.source_type = 'youtube' and s.expires_at is not null and s.expires_at > ${nowParam} and s.url = ${urlCol}`;
  /** A copy of YouTube text is backed while an unexpired YouTube source for the same url contains it (copies may be excerpts). */
  const backedBySource = (urlCol: SQL, text: SQL) => sql`exists (select 1 from knowledge_sources s where ${liveYoutubeSource(urlCol)}
      and strpos(${collapsed(sql`s.quote`)}, ${collapsed(text)}) > 0)`;
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
      .where(and(isNotNull(knowledgeSources.expiresAt), lte(knowledgeSources.expiresAt, now)))
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
      // knowledge_items.quote is a verbatim copy of one source's quote. A surviving entry whose quote no remaining source has
      // (it came from an expired source) takes the quote of its oldest remaining verified source (the one it would have kept
      // first), or none. The summary and title are model paraphrases and are kept. The embedding is of title + summary only.
      const survivors = itemIds.filter((id) => !empty.includes(id));
      if (survivors.length) {
        const best = sql`(select s.quote from knowledge_sources s where s.item_id = knowledge_items.id and s.quote_verified and s.quote is not null order by s.fetched_at, s.id limit 1)`;
        await tx.update(knowledgeItems).set({ quote: best, quoteVerified: sql`(${best} is not null)` })
          .where(and(inArray(knowledgeItems.id, survivors), isNotNull(knowledgeItems.quote),
            sql`not exists (select 1 from knowledge_sources s where s.item_id = knowledge_items.id and s.quote = knowledge_items.quote)`));
      }
    }
    return { expiredSources: gone.length, deletedItems: deleted };
  }));

  const redactedSignals = await step('redact signals', 0, () => db.transaction(async (tx) => {
    // One statement. signals.quote is NOT NULL, so `<>` never skips a row through NULL semantics. sha256() is built into PG 11+.
    // A YouTube signal is a copy of a library source's quote: it goes when no unexpired YouTube source has the same url and
    // (collapsed) quote, so a signal promoted late never outlives its source, and in any case 30 days after it was created.
    const backed = sql`exists (select 1 from knowledge_sources s where ${liveYoutubeSource(sql`signals.url`)}
      and ${collapsed(sql`s.quote`)} = ${collapsed(sql`signals.quote`)})`;
    const res = await tx.update(signals).set({
      quote: EXPIRED_PLACEHOLDER,
      title: EXPIRED_PLACEHOLDER,
      embedding: null,
      quoteHash: sql`encode(sha256(convert_to(${EXPIRED_PLACEHOLDER} || ${signals.id}::text, 'UTF8')), 'hex')`,
    }).where(and(eq(signals.source, 'youtube'), sql`${signals.quote} <> ${EXPIRED_PLACEHOLDER}`, or(lt(signals.createdAt, ytCutoff), sql`not ${backed}`)))
      .returning({ id: signals.id });
    return res.length;
  }));

  const redactedClaims = await step('redact claims', 0, () => db.transaction(async (tx) => {
    const old = tx.select({ id: cases.id }).from(cases).where(lt(cases.createdAt, ytCutoff));
    // Verbatim YouTube text on a claim: its quote, and the text of a 'signal' claim (the signal quote, capped). One statement,
    // so a row is processed once: the quote goes (with the note), and a signal claim's text becomes the placeholder.
    // Backing is checked on the quote, or on the text when the quote is already gone. Redacted rows no longer match.
    const signalText = sql`(${claims.section} = 'signal' and ${claims.text} <> ${EXPIRED_PLACEHOLDER})`;
    const backed = backedBySource(sql`claims.source_url`, sql`coalesce(claims.quote, claims.text)`);
    const res = await tx.update(claims)
      .set({
        quote: null,
        reviewNote: sql`(case when ${claims.quote} is not null then ${YOUTUBE_CLAIM_NOTE} else ${claims.reviewNote} end)`,
        text: sql`(case when ${claims.section} = 'signal' then ${EXPIRED_PLACEHOLDER} else ${claims.text} end)`,
      })
      .where(and(isYoutubeUrl(sql`${claims.sourceUrl}`), or(isNotNull(claims.quote), signalText), or(inArray(claims.caseId, old), sql`not ${backed}`)))
      .returning({ id: claims.id });
    return res.length;
  }));

  const redactedCases = await step('redact case evidence', 0, async () => {
    // cases.sections.evidence.signals[] entries are { quote, url, sourceName, voice? }: quote is the verbatim signal text
    // (sourceName is a site label). Same rule as claims, per entry. One set-based statement; entries keep their order.
    const signalsPath = sql`cases.sections->'evidence'->'signals'`;
    const expired = (e: SQL) => sql`(${isYoutubeUrl(sql`(${e}->>'url')`)} and (${e}->>'quote') <> ${EXPIRED_PLACEHOLDER}
      and (cases.created_at < ${ytCutoff.toISOString()}::timestamptz or not ${backedBySource(sql`(${e}->>'url')`, sql`(${e}->>'quote')`)}))`;
    const res = await db.transaction((tx) => tx.execute(sql`
      update cases set sections = jsonb_set(cases.sections, '{evidence,signals}', (
        select jsonb_agg(case when ${expired(sql`t.e`)} then jsonb_set(t.e, '{quote}', to_jsonb(${EXPIRED_PLACEHOLDER}::text)) else t.e end order by t.i)
        from jsonb_array_elements(${signalsPath}) with ordinality as t(e, i)))
      where jsonb_typeof(${signalsPath}) = 'array'
        and exists (select 1 from jsonb_array_elements(${signalsPath}) as u(e) where ${expired(sql`u.e`)})
      returning cases.id`));
    return (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])).length;
  });

  const prunedQuotaRows = await step('prune quota rows', 0, async () => {
    // Keys look like youtube.quota.YYYY-MM-DD; ISO dates sort as text, and only well-formed keys are considered.
    const cutoff = pacificDate(new Date(now.getTime() - QUOTA_ROW_RETENTION_DAYS * DAY));
    const res = await db.execute(sql`
      delete from settings
      where key ~ '^youtube\\.quota\\.[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        and substring(key from 15) < ${cutoff}
      returning key`);
    return (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])).length;
  });

  return { prunedFetches, prunedQuotaRows, expiredSources, deletedItems, redactedSignals, redactedClaims, redactedCases, errors };
}

/** runMaintenance for startup paths: logs one count line (only when something changed) and never throws. */
export async function runMaintenanceQuietly(db: Db, log: (line: string) => void, now?: Date): Promise<void> {
  try {
    const m = await runMaintenance(db, now);
    const total = m.prunedFetches + m.prunedQuotaRows + m.expiredSources + m.deletedItems + m.redactedSignals + m.redactedClaims + m.redactedCases;
    if (total > 0) log(`Maintenance: ${total} old records cleaned up.`);
    for (const e of m.errors) log(`Maintenance step failed: ${e}`);
  } catch (err) {
    log(`Maintenance skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}
