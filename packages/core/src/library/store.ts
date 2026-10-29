import { createHash } from 'node:crypto';
import { and, asc, cosineDistance, count, desc, eq, gt, ilike, inArray, isNull, not, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { knowledgeItems, knowledgeSources, type FETCH_VIAS } from '../db/schema';
import type { KnowledgeDraft, KnowledgeVoice } from './kinds';
import { itemLive, itemQuoteExpired, liveSource } from './live';

/** Web-safe: drizzle-orm, schema, kinds, live and node:crypto only (server-side). Bound parameters only. */

export const MERGE_SIMILARITY = 0.9;
export const PAGE_SIZE = 50;
export const RETRIEVAL_MAX = 30;
const MAX_LISTED = 100;
const PER_DOMAIN = 3;
const VOICE_BONUS = 0.05;
const AGE_FREE_YEARS = 2;
const AGE_PENALTY_PER_YEAR = 0.05;
const YEAR_MS = 365.25 * 24 * 3600 * 1000;

export type LibraryRow = {
  id: string;
  kind: string;
  title: string;
  summary: string;
  quote: string | null;
  quoteVerified: boolean;
  audience: string;
  countries: string[];
  industries: string[];
  voice: KnowledgeVoice | null;
  status: 'active' | 'rejected';
  sourceCount: number;
  newestSourceAt: Date | null;
  updatedAt: Date;
};

export type SourceRow = {
  id: string;
  url: string;
  domain: string;
  sourceType: string;
  publishedAt: Date | null;
  fetchedAt: Date;
  quote: string | null;
  quoteVerified: boolean;
  voice: KnowledgeVoice | null;
  via: (typeof FETCH_VIAS)[number];
  /** The archive snapshot time when via is archive. */
  snapshotAt: Date | null;
  /** When a YouTube source is deleted (30 days after it was fetched). */
  expiresAt: Date | null;
};

/** Lowercase, runs of non-letter/non-digit become one space (same rule as pipeline/verify normalize, kept local to stay web-safe). */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function contentHash(d: KnowledgeDraft): string {
  return createHash('sha256').update(`${d.kind}\n${norm(d.title)}\n${norm(d.quote ?? d.summary)}`).digest('hex');
}

const VOICE_RANK: Record<string, number> = { operator: 3, neutral: 2, vendor: 1 };
const moreIndependent = (a: KnowledgeVoice | null | undefined, b: KnowledgeVoice | null | undefined): KnowledgeVoice | null =>
  (VOICE_RANK[a ?? ''] ?? 0) >= (VOICE_RANK[b ?? ''] ?? 0) ? (a ?? null) : (b ?? null);

const similarity = (vec: number[]): SQL<number> => sql<number>`1 - (${cosineDistance(knowledgeItems.embedding, vec)})`;

/**
 * Source types whose drafts are measured in code from an API series (World Bank, Wikipedia pageviews, HN story counts).
 * Their titles and summaries are near-templates ("Market size clues for Canada"), so two different countries or topics
 * embed almost identically: they never go through the near-duplicate merge, and are matched only by source url (the
 * same url again refreshes that entry's figures).
 */
export const MEASURED_SOURCE_TYPES: readonly string[] = ['worldbank', 'wikipedia', 'hn-trend'];

/** How long YouTube-sourced data may be kept (YouTube developer policy: 30 days, then refresh or delete). */
export const YOUTUBE_TTL_MS = 30 * 86_400_000;

export async function upsertKnowledgeItem(
  db: Db,
  d: KnowledgeDraft,
  embedding: number[],
  ctx: { missionId?: string; now?: Date },
): Promise<{ outcome: 'added' | 'merged' | 'duplicate'; itemId: string }> {
  const hash = contentHash(d);
  /** The quote text the collector verified against the fetched source, or null. The entry quote must be this text. */
  const verifiedQuote = d.source.quoteVerified && d.source.quote ? d.source.quote : null;
  return db.transaction(async (tx) => {
    // YouTube data may be kept for 30 days: such a source is stamped with an expiry, refreshed whenever it is collected again.
    const fetchedAt = ctx.now ?? new Date();
    const isYoutube = d.source.sourceType === 'youtube';
    const expiresAt = isYoutube ? new Date(fetchedAt.getTime() + YOUTUBE_TTL_MS) : null;
    // A later verified quote for the same url replaces an unverified one (with its voice); a verified row is never downgraded.
    const upgrade = sql`(excluded.quote_verified and not ${knowledgeSources.quoteVerified})`;
    const upgraded = (col: SQL, current: SQL) => sql`(case when ${upgrade} then ${col} else ${current} end)`;
    // The stored quote is (re)collected now only when it is the incoming text, or is replaced by it (upgrade).
    const recollected = sql`(${upgrade} or ${knowledgeSources.quote} is not distinct from excluded.quote)`;
    const refreshed = (col: SQL, current: SQL) => sql`(case when ${recollected} then ${col} else ${current} end)`;
    const addSource = (itemId: string) =>
      tx.insert(knowledgeSources).values({
        itemId, url: d.source.url, domain: d.source.domain, sourceType: d.source.sourceType,
        publishedAt: d.source.publishedAt ?? null, quote: d.source.quote ?? null, quoteVerified: d.source.quoteVerified,
        voice: d.source.voice ?? d.voice ?? null, via: d.source.via ?? 'direct', snapshotAt: d.source.snapshotAt ?? null,
        fetchedAt, expiresAt,
      }).onConflictDoUpdate({
        target: [knowledgeSources.itemId, knowledgeSources.url],
        set: {
          quote: upgraded(sql`excluded.quote`, sql`${knowledgeSources.quote}`),
          quoteVerified: upgraded(sql`excluded.quote_verified`, sql`${knowledgeSources.quoteVerified}`),
          voice: upgraded(sql`coalesce(excluded.voice, ${knowledgeSources.voice})`, sql`${knowledgeSources.voice}`),
          via: upgraded(sql`excluded.via`, sql`${knowledgeSources.via}`),
          snapshotAt: upgraded(sql`excluded.snapshot_at`, sql`${knowledgeSources.snapshotAt}`),
          // Re-collecting a YouTube source restarts its 30 days only when the stored comment is the one just fetched: another
          // comment on the same video does not extend a comment that was not re-fetched.
          ...(isYoutube ? {
            fetchedAt: refreshed(sql`excluded.fetched_at`, sql`${knowledgeSources.fetchedAt}`),
            expiresAt: refreshed(sql`excluded.expires_at`, sql`${knowledgeSources.expiresAt}`),
          } : {}),
        },
      });

    /** Shared by the duplicate and merge paths: add the source, upgrade voice, adopt a verified quote. */
    const absorb = async (existing: { id: string; voice: KnowledgeVoice | null; quoteVerified: boolean }) => {
      await addSource(existing.id);
      const patch: Partial<typeof knowledgeItems.$inferInsert> = {
        updatedAt: new Date(),
        voice: moreIndependent(existing.voice, d.voice ?? null),
      };
      if (!existing.quoteVerified && verifiedQuote) {
        patch.quote = verifiedQuote;
        patch.quoteVerified = true;
      }
      await tx.update(knowledgeItems).set(patch).where(eq(knowledgeItems.id, existing.id));
    };

    if (MEASURED_SOURCE_TYPES.includes(d.source.sourceType)) {
      // Same kind, url and measured source: refresh the figures in place (title, summary, facts, embedding) and the
      // source's fetch time. An entry that only cites the url from another source (a quoted article) is never overwritten.
      const [same] = await tx
        .select({ id: knowledgeItems.id })
        .from(knowledgeItems)
        .innerJoin(knowledgeSources, eq(knowledgeSources.itemId, knowledgeItems.id))
        .where(and(
          eq(knowledgeItems.kind, d.kind),
          eq(knowledgeSources.url, d.source.url),
          eq(knowledgeSources.sourceType, d.source.sourceType),
        ))
        .orderBy(asc(knowledgeItems.createdAt), asc(knowledgeItems.id))
        .limit(1);
      if (same) {
        // The content hash is unique: keep the stored one if another entry already has the new text.
        const [clash] = await tx.select({ id: knowledgeItems.id }).from(knowledgeItems)
          .where(and(eq(knowledgeItems.contentHash, hash), not(eq(knowledgeItems.id, same.id))));
        await tx.update(knowledgeItems).set({
          title: d.title, summary: d.summary, facts: d.facts, embedding, updatedAt: new Date(), ...(clash ? {} : { contentHash: hash }),
        }).where(eq(knowledgeItems.id, same.id));
        await tx.update(knowledgeSources).set({ fetchedAt, publishedAt: d.source.publishedAt ?? null })
          .where(and(eq(knowledgeSources.itemId, same.id), eq(knowledgeSources.url, d.source.url)));
        return { outcome: 'duplicate' as const, itemId: same.id };
      }
    }

    const [exact] = await tx
      .select({ id: knowledgeItems.id, voice: knowledgeItems.voice, quoteVerified: knowledgeItems.quoteVerified })
      .from(knowledgeItems).where(eq(knowledgeItems.contentHash, hash));
    if (exact) {
      await absorb(exact);
      return { outcome: 'duplicate' as const, itemId: exact.id };
    }

    // Measured drafts skip the near-duplicate merge (see MEASURED_SOURCE_TYPES).
    const [nearest] = MEASURED_SOURCE_TYPES.includes(d.source.sourceType) ? [] : await tx
      .select({ id: knowledgeItems.id, voice: knowledgeItems.voice, quoteVerified: knowledgeItems.quoteVerified, sim: similarity(embedding) })
      .from(knowledgeItems)
      .where(and(eq(knowledgeItems.kind, d.kind), sql`${knowledgeItems.embedding} is not null`))
      .orderBy(cosineDistance(knowledgeItems.embedding, embedding), asc(knowledgeItems.id))
      .limit(1);
    if (nearest && Number(nearest.sim) >= MERGE_SIMILARITY) {
      await absorb(nearest);
      return { outcome: 'merged' as const, itemId: nearest.id };
    }

    const [row] = await tx.insert(knowledgeItems).values({
      kind: d.kind, title: d.title, summary: d.summary, quote: verifiedQuote ?? d.quote ?? null, quoteVerified: verifiedQuote !== null,
      audience: d.audience, countries: d.countries, industries: d.industries, voice: d.voice ?? null,
      facts: d.facts, embedding, contentHash: hash, missionId: ctx.missionId ?? null,
    }).returning({ id: knowledgeItems.id });
    await addSource(row!.id);
    return { outcome: 'added' as const, itemId: row!.id };
  });
}

export async function rejectItem(db: Db, id: string, reason?: string): Promise<boolean> {
  const r = await db.update(knowledgeItems)
    .set({ status: 'rejected', rejectReason: reason ?? null, updatedAt: new Date() })
    .where(eq(knowledgeItems.id, id)).returning({ id: knowledgeItems.id });
  return r.length > 0;
}

export async function restoreItem(db: Db, id: string): Promise<boolean> {
  const r = await db.update(knowledgeItems)
    .set({ status: 'active', rejectReason: null, updatedAt: new Date() })
    .where(eq(knowledgeItems.id, id)).returning({ id: knowledgeItems.id });
  return r.length > 0;
}

const toDate = (v: unknown): Date | null => (v == null ? null : v instanceof Date ? v : new Date(v as string));
// Read-side expressions count and show live (unexpired) sources only; see ./live.
const sourceCountExpr = (now: Date) =>
  sql<number>`(select count(*) from knowledge_sources s where s.item_id = knowledge_items.id and ${liveSource(now)})`.mapWith(Number);
const newestExpr = (now: Date) =>
  sql<Date | null>`(select max(coalesce(s.published_at, s.fetched_at)) from knowledge_sources s where s.item_id = knowledge_items.id and ${liveSource(now)})`.mapWith(toDate);
const quoteExpr = (now: Date) => sql<string | null>`(case when ${itemQuoteExpired(now)} then null else ${knowledgeItems.quote} end)`;
const quoteVerifiedExpr = (now: Date) => sql<boolean>`(${knowledgeItems.quoteVerified} and not ${itemQuoteExpired(now)})`;
/** Live-source condition for queries that join knowledge_sources directly. */
const liveJoined = (now: Date) => or(isNull(knowledgeSources.expiresAt), gt(knowledgeSources.expiresAt, now));

const rowShape = (now: Date) => ({
  id: knowledgeItems.id, kind: knowledgeItems.kind, title: knowledgeItems.title, summary: knowledgeItems.summary,
  quote: quoteExpr(now), quoteVerified: quoteVerifiedExpr(now), audience: knowledgeItems.audience,
  countries: knowledgeItems.countries, industries: knowledgeItems.industries, voice: knowledgeItems.voice,
  status: knowledgeItems.status, sourceCount: sourceCountExpr(now), newestSourceAt: newestExpr(now), updatedAt: knowledgeItems.updatedAt,
});

export type LibraryFilter = {
  text?: string;
  queryVector?: number[];
  kinds?: string[];
  audience?: string;
  country?: string;
  industry?: string;
  voice?: string;
  sourceType?: string;
  maxAgeDays?: number;
  status?: 'active' | 'rejected' | 'all';
  page?: number;
};

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function searchLibrary(db: Db, f: LibraryFilter, now: Date = new Date()): Promise<{ rows: LibraryRow[]; total: number }> {
  const conds: (SQL | undefined)[] = [itemLive(now)];
  const status = f.status ?? 'active';
  if (status !== 'all') conds.push(eq(knowledgeItems.status, status));
  if (f.text?.trim()) {
    const p = `%${escapeLike(f.text.trim())}%`;
    conds.push(sql`(${ilike(knowledgeItems.title, p)} or ${ilike(knowledgeItems.summary, p)})`);
  }
  if (f.kinds?.length) conds.push(inArray(knowledgeItems.kind, f.kinds as (typeof knowledgeItems.$inferSelect.kind)[]));
  if (f.audience) conds.push(eq(knowledgeItems.audience, f.audience as 'business' | 'consumer' | 'both'));
  if (f.country) conds.push(sql`${f.country} = any(${knowledgeItems.countries})`);
  if (f.industry) conds.push(sql`${f.industry} = any(${knowledgeItems.industries})`);
  if (f.voice) conds.push(eq(knowledgeItems.voice, f.voice as KnowledgeVoice));
  if (f.sourceType) conds.push(sql`exists (select 1 from knowledge_sources s where s.item_id = knowledge_items.id and s.source_type = ${f.sourceType} and ${liveSource(now)})`);
  if (f.maxAgeDays != null && Number.isFinite(f.maxAgeDays)) {
    const cutoff = new Date(Date.now() - f.maxAgeDays * 86_400_000).toISOString();
    conds.push(sql`${newestExpr(now)} >= ${cutoff}::timestamptz`);
  }
  const where = and(...conds);
  const page = Number.isFinite(f.page) ? Math.max(1, Math.floor(f.page!)) : 1;

  const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(knowledgeItems).where(where);
  const order = f.queryVector
    ? [asc(cosineDistance(knowledgeItems.embedding, f.queryVector)), desc(knowledgeItems.updatedAt), asc(knowledgeItems.id)]
    : [desc(knowledgeItems.updatedAt), asc(knowledgeItems.id)];
  const rows = await db.select(rowShape(now)).from(knowledgeItems).where(where).orderBy(...order).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE);
  return { rows: rows as LibraryRow[], total: Number(total) };
}

/** An entry with its live sources; null when missing or when all its sources have expired. */
export async function getLibraryItem(db: Db, id: string, now: Date = new Date()): Promise<(LibraryRow & { facts: unknown; sources: SourceRow[] }) | null> {
  const [row] = await db.select({ ...rowShape(now), facts: knowledgeItems.facts }).from(knowledgeItems).where(and(eq(knowledgeItems.id, id), itemLive(now)));
  if (!row) return null;
  const sources = await db.select({
    id: knowledgeSources.id, url: knowledgeSources.url, domain: knowledgeSources.domain, sourceType: knowledgeSources.sourceType,
    publishedAt: knowledgeSources.publishedAt, fetchedAt: knowledgeSources.fetchedAt, quote: knowledgeSources.quote,
    quoteVerified: knowledgeSources.quoteVerified, voice: knowledgeSources.voice,
    via: knowledgeSources.via, snapshotAt: knowledgeSources.snapshotAt, expiresAt: knowledgeSources.expiresAt,
  }).from(knowledgeSources).where(and(eq(knowledgeSources.itemId, id), liveJoined(now))).orderBy(asc(knowledgeSources.fetchedAt), asc(knowledgeSources.id));
  return { ...(row as LibraryRow & { facts: unknown }), sources };
}

/** Source types that count as social/community platforms in the coverage view. */
export const SOCIAL_SOURCE_TYPES = ['youtube', 'hn', 'stackexchange', 'github', 'appstore', 'producthunt'] as const; // not 'hn-trend' (story counts)

export type LibraryCoverage = {
  byKind: Record<string, number>;
  bySourceType: Record<string, number>;
  byVoice: Record<string, number>;
  problemIndependentShare: number | null;
  verifiedQuoteShare: number | null;
  /** Share of active entries' sources from social/community platforms (null when there are no sources). */
  socialShare: number | null;
  countries: string[];
  industries: string[];
  newest: Date | null;
  oldest: Date | null;
};

export async function libraryCoverage(db: Db, now: Date = new Date()): Promise<LibraryCoverage> {
  const active = and(eq(knowledgeItems.status, 'active'), itemLive(now));
  const activeLiveSource = and(active, liveJoined(now));
  const tally = (rows: { k: string | null; n: number }[]) =>
    Object.fromEntries(rows.filter((r) => r.k != null).map((r) => [r.k as string, Number(r.n)]));

  const byKindRows = await db.select({ k: knowledgeItems.kind, n: count() }).from(knowledgeItems).where(active).groupBy(knowledgeItems.kind);
  const byVoiceRows = await db.select({ k: knowledgeItems.voice, n: count() }).from(knowledgeItems).where(active).groupBy(knowledgeItems.voice);
  const bySourceRows = await db.select({ k: knowledgeSources.sourceType, n: sql<number>`count(distinct ${knowledgeSources.itemId})`.mapWith(Number) })
    .from(knowledgeSources).innerJoin(knowledgeItems, eq(knowledgeItems.id, knowledgeSources.itemId)).where(activeLiveSource).groupBy(knowledgeSources.sourceType);

  const [social] = await db.select({
    total: count(),
    social: sql<number>`count(*) filter (where ${inArray(knowledgeSources.sourceType, [...SOCIAL_SOURCE_TYPES])})`.mapWith(Number),
  }).from(knowledgeSources).innerJoin(knowledgeItems, eq(knowledgeItems.id, knowledgeSources.itemId)).where(activeLiveSource);

  const [problems] = await db.select({
    total: count(),
    independent: sql<number>`count(*) filter (where ${knowledgeItems.voice} in ('operator', 'neutral'))`.mapWith(Number),
  }).from(knowledgeItems).where(and(active, eq(knowledgeItems.kind, 'problem')));
  const [quotes] = await db.select({
    total: count(),
    verified: sql<number>`count(*) filter (where ${quoteVerifiedExpr(now)})`.mapWith(Number),
  }).from(knowledgeItems).where(active);

  const countryRows = await db.selectDistinct({ v: sql<string>`unnest(${knowledgeItems.countries})`.as('v') })
    .from(knowledgeItems).where(active).orderBy(sql`1`).limit(MAX_LISTED);
  const industryRows = await db.selectDistinct({ v: sql<string>`unnest(${knowledgeItems.industries})`.as('v') })
    .from(knowledgeItems).where(active).orderBy(sql`1`).limit(MAX_LISTED);

  const [span] = await db.select({
    newest: sql<Date | null>`max(${knowledgeItems.createdAt})`.mapWith(toDate),
    oldest: sql<Date | null>`min(${knowledgeItems.createdAt})`.mapWith(toDate),
  }).from(knowledgeItems).where(active);

  return {
    byKind: tally(byKindRows),
    bySourceType: tally(bySourceRows),
    byVoice: tally(byVoiceRows),
    problemIndependentShare: problems && Number(problems.total) > 0 ? problems.independent / Number(problems.total) : null,
    verifiedQuoteShare: quotes && Number(quotes.total) > 0 ? quotes.verified / Number(quotes.total) : null,
    socialShare: social && Number(social.total) > 0 ? social.social / Number(social.total) : null,
    countries: countryRows.map((r) => r.v),
    industries: industryRows.map((r) => r.v),
    newest: span?.newest ?? null,
    oldest: span?.oldest ?? null,
  };
}

/** The eligibility rule shared by retrieveForRun and countEligibleForRun. */
function eligibleConds(opts: { kinds?: ('problem' | 'pricing')[]; countries?: string[] }, now: Date): (SQL | undefined)[] {
  const kinds = opts.kinds?.length ? opts.kinds : (['problem', 'pricing'] as const);
  const conds: (SQL | undefined)[] = [
    eq(knowledgeItems.status, 'active'),
    eq(knowledgeItems.quoteVerified, true),
    // Expired data is never promoted: not an entry whose sources have all expired, nor a quote only an expired source had.
    itemLive(now),
    not(itemQuoteExpired(now)),
    inArray(knowledgeItems.kind, [...kinds]),
    sql`${knowledgeItems.embedding} is not null`,
  ];
  if (opts.countries?.length) {
    const arr = sql`array[${sql.join(opts.countries.map((c) => sql`${c}`), sql`, `)}]::text[]`;
    conds.push(sql`(${knowledgeItems.countries} && ${arr} or 'global' = any(${knowledgeItems.countries}) or cardinality(${knowledgeItems.countries}) = 0)`);
  }
  return conds;
}

/** How many entries retrieveForRun could return for these options (same eligibility, no limit). */
export async function countEligibleForRun(db: Db, opts: { kinds?: ('problem' | 'pricing')[]; countries?: string[]; now?: Date }): Promise<number> {
  const [r] = await db.select({ n: count() }).from(knowledgeItems).where(and(...eligibleConds(opts, opts.now ?? new Date())));
  return Number(r?.n ?? 0);
}

export async function retrieveForRun(
  db: Db,
  queryVector: number[],
  opts: { limit: number; kinds?: ('problem' | 'pricing')[]; countries?: string[]; now?: Date },
): Promise<LibraryRow[]> {
  const limit = Math.min(Math.max(Number.isFinite(opts.limit) ? Math.floor(opts.limit) : RETRIEVAL_MAX, 0), RETRIEVAL_MAX);
  if (limit === 0) return [];
  const now = opts.now ?? new Date();
  const conds = eligibleConds(opts, now);
  const domainExpr = sql<string>`coalesce((select s.domain from knowledge_sources s where s.item_id = knowledge_items.id and ${liveSource(now)} order by s.fetched_at, s.id limit 1), knowledge_items.id::text)`;
  const scoreExpr = sql<number>`(${similarity(queryVector)})
    + (case when ${knowledgeItems.voice} in ('operator', 'neutral') then ${VOICE_BONUS}::float8 else 0::float8 end)
    - greatest(0::float8, extract(epoch from (now() - coalesce(${newestExpr(now)}, now()))) / ${YEAR_MS / 1000}::float8 - ${AGE_FREE_YEARS}::float8) * ${AGE_PENALTY_PER_YEAR}::float8`;

  // One bounded query: score every eligible entry, keep the best 3 per domain, take the top `limit`.
  const base = db.select({
    id: knowledgeItems.id, kind: knowledgeItems.kind, title: knowledgeItems.title, summary: knowledgeItems.summary,
    quote: knowledgeItems.quote, quoteVerified: knowledgeItems.quoteVerified, audience: knowledgeItems.audience,
    countries: knowledgeItems.countries, industries: knowledgeItems.industries, voice: knowledgeItems.voice,
    status: knowledgeItems.status, updatedAt: knowledgeItems.updatedAt,
    sourceCount: sourceCountExpr(now).as('source_count'), newestSourceAt: newestExpr(now).as('newest_source_at'),
    score: scoreExpr.as('score'), dom: domainExpr.as('dom'),
  }).from(knowledgeItems).where(and(...conds)).as('base');
  const ranked = db.select({
    id: base.id, kind: base.kind, title: base.title, summary: base.summary, quote: base.quote, quoteVerified: base.quoteVerified,
    audience: base.audience, countries: base.countries, industries: base.industries, voice: base.voice, status: base.status,
    updatedAt: base.updatedAt, sourceCount: base.sourceCount, newestSourceAt: base.newestSourceAt, score: base.score,
    rn: sql<number>`row_number() over (partition by ${base.dom} order by ${base.score} desc, ${base.id})`.as('rn'),
  }).from(base).as('ranked');
  const rows = await db.select().from(ranked).where(sql`${ranked.rn} <= ${PER_DOMAIN}`)
    .orderBy(desc(ranked.score), asc(ranked.id)).limit(limit);

  return rows.map((r) => ({
    id: r.id, kind: r.kind, title: r.title, summary: r.summary, quote: r.quote, quoteVerified: r.quoteVerified,
    audience: r.audience, countries: r.countries, industries: r.industries, voice: r.voice, status: r.status,
    sourceCount: Number(r.sourceCount), newestSourceAt: toDate(r.newestSourceAt), updatedAt: r.updatedAt,
  }));
}
