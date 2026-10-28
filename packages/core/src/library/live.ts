import { sql, type SQL } from 'drizzle-orm';

/**
 * Web-safe (drizzle-orm only). A library source is live until its `expires_at` (YouTube: 30 days after fetch). Expired sources
 * are never used or shown, even before maintenance deletes them. The SQL below is correlated on `knowledge_items` (outer query)
 * and aliases `knowledge_sources` as `s`. `now` is a bound parameter.
 */
const at = (now: Date): SQL => sql`${now.toISOString()}::timestamptz`;

/** Condition on alias `s`: the source has not expired. */
export const liveSource = (now: Date): SQL => sql`(s.expires_at is null or s.expires_at > ${at(now)})`;

/** The entry has a live source (or no sources at all): an entry whose sources have all expired is hidden. */
export const itemLive = (now: Date): SQL => sql`(exists (select 1 from knowledge_sources s where s.item_id = knowledge_items.id and ${liveSource(now)})
  or not exists (select 1 from knowledge_sources s where s.item_id = knowledge_items.id))`;

/** The entry quote is the text of an expired source and of no live one: hide it (maintenance replaces or clears it later). */
export const itemQuoteExpired = (now: Date): SQL => sql`(exists (select 1 from knowledge_sources s where s.item_id = knowledge_items.id
    and s.expires_at is not null and s.expires_at <= ${at(now)} and s.quote = knowledge_items.quote)
  and not exists (select 1 from knowledge_sources s where s.item_id = knowledge_items.id and ${liveSource(now)} and s.quote = knowledge_items.quote))`;
