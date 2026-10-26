import { createHash } from 'node:crypto';
import { and, asc, cosineDistance, count, desc, eq, ilike, inArray, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { knowledgeItems, knowledgeSources } from '../db/schema';
import type { KnowledgeDraft, KnowledgeVoice } from './kinds';

/** Web-safe: drizzle-orm, schema, kinds and node:crypto only (server-side). Bound parameters only. */

export const MERGE_SIMILARITY = 0.9;
export const PAGE_SIZE = 50;
export const RETRIEVAL_MAX = 30;
const MAX_LISTED = 100;
const POOL_MIN = 60;
const POOL_MAX = 300;
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

export async function upsertKnowledgeItem(
  db: Db,
  d: KnowledgeDraft,
  embedding: number[],
  ctx: { missionId?: string },
): Promise<{ outcome: 'added' | 'merged' | 'duplicate'; itemId: string }> {
  const hash = contentHash(d);
  return db.transaction(async (tx) => {
    const addSource = (itemId: string) =>
      tx.insert(knowledgeSources).values({
        itemId, url: d.source.url, domain: d.source.domain, sourceType: d.source.sourceType,
        publishedAt: d.source.publishedAt ?? null, quote: d.source.quote ?? null, quoteVerified: d.source.quoteVerified,
      }).onConflictDoNothing();

    const [exact] = await tx.select({ id: knowledgeItems.id }).from(knowledgeItems).where(eq(knowledgeItems.contentHash, hash));
    if (exact) {
      await addSource(exact.id);
      return { outcome: 'duplicate' as const, itemId: exact.id };
    }

    const [nearest] = await tx
      .select({ id: knowledgeItems.id, voice: knowledgeItems.voice, quoteVerified: knowledgeItems.quoteVerified, sim: similarity(embedding) })
      .from(knowledgeItems)
      .where(and(eq(knowledgeItems.kind, d.kind), sql`${knowledgeItems.embedding} is not null`))
      .orderBy(cosineDistance(knowledgeItems.embedding, embedding), asc(knowledgeItems.id))
      .limit(1);
    if (nearest && Number(nearest.sim) >= MERGE_SIMILARITY) {
      await addSource(nearest.id);
      const patch: Partial<typeof knowledgeItems.$inferInsert> = {
        updatedAt: new Date(),
        voice: moreIndependent(nearest.voice, d.voice ?? null),
      };
      if (!nearest.quoteVerified && d.source.quoteVerified && d.quote) {
        patch.quote = d.quote;
        patch.quoteVerified = true;
      }
      await tx.update(knowledgeItems).set(patch).where(eq(knowledgeItems.id, nearest.id));
      return { outcome: 'merged' as const, itemId: nearest.id };
    }

    const [row] = await tx.insert(knowledgeItems).values({
      kind: d.kind, title: d.title, summary: d.summary, quote: d.quote ?? null, quoteVerified: d.source.quoteVerified && !!d.quote,
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
const sourceCountExpr = sql<number>`(select count(*) from knowledge_sources s where s.item_id = knowledge_items.id)`.mapWith(Number);
const newestExpr = sql<Date | null>`(select max(coalesce(s.published_at, s.fetched_at)) from knowledge_sources s where s.item_id = knowledge_items.id)`.mapWith(toDate);

const rowShape = {
  id: knowledgeItems.id, kind: knowledgeItems.kind, title: knowledgeItems.title, summary: knowledgeItems.summary,
  quote: knowledgeItems.quote, quoteVerified: knowledgeItems.quoteVerified, audience: knowledgeItems.audience,
  countries: knowledgeItems.countries, industries: knowledgeItems.industries, voice: knowledgeItems.voice,
  status: knowledgeItems.status, sourceCount: sourceCountExpr, newestSourceAt: newestExpr, updatedAt: knowledgeItems.updatedAt,
};

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

export async function searchLibrary(db: Db, f: LibraryFilter): Promise<{ rows: LibraryRow[]; total: number }> {
  const conds: (SQL | undefined)[] = [];
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
  if (f.sourceType) conds.push(sql`exists (select 1 from knowledge_sources s where s.item_id = knowledge_items.id and s.source_type = ${f.sourceType})`);
  if (f.maxAgeDays != null) {
    const cutoff = new Date(Date.now() - f.maxAgeDays * 86_400_000).toISOString();
    conds.push(sql`${newestExpr} >= ${cutoff}::timestamptz`);
  }
  const where = and(...conds);
  const page = Math.max(1, Math.floor(f.page ?? 1));

  const [{ total } = { total: 0 }] = await db.select({ total: count() }).from(knowledgeItems).where(where);
  const order = f.queryVector
    ? [asc(cosineDistance(knowledgeItems.embedding, f.queryVector)), desc(knowledgeItems.updatedAt), asc(knowledgeItems.id)]
    : [desc(knowledgeItems.updatedAt), asc(knowledgeItems.id)];
  const rows = await db.select(rowShape).from(knowledgeItems).where(where).orderBy(...order).limit(PAGE_SIZE).offset((page - 1) * PAGE_SIZE);
  return { rows: rows as LibraryRow[], total: Number(total) };
}

export async function getLibraryItem(db: Db, id: string): Promise<(LibraryRow & { facts: unknown; sources: SourceRow[] }) | null> {
  const [row] = await db.select({ ...rowShape, facts: knowledgeItems.facts }).from(knowledgeItems).where(eq(knowledgeItems.id, id));
  if (!row) return null;
  const sources = await db.select({
    id: knowledgeSources.id, url: knowledgeSources.url, domain: knowledgeSources.domain, sourceType: knowledgeSources.sourceType,
    publishedAt: knowledgeSources.publishedAt, fetchedAt: knowledgeSources.fetchedAt, quote: knowledgeSources.quote,
    quoteVerified: knowledgeSources.quoteVerified,
  }).from(knowledgeSources).where(eq(knowledgeSources.itemId, id)).orderBy(asc(knowledgeSources.fetchedAt), asc(knowledgeSources.id));
  return { ...(row as LibraryRow & { facts: unknown }), sources };
}

export type LibraryCoverage = {
  byKind: Record<string, number>;
  bySourceType: Record<string, number>;
  byVoice: Record<string, number>;
  problemIndependentShare: number | null;
  verifiedQuoteShare: number | null;
  countries: string[];
  industries: string[];
  newest: Date | null;
  oldest: Date | null;
};

export async function libraryCoverage(db: Db): Promise<LibraryCoverage> {
  const active = eq(knowledgeItems.status, 'active');
  const tally = (rows: { k: string | null; n: number }[]) =>
    Object.fromEntries(rows.filter((r) => r.k != null).map((r) => [r.k as string, Number(r.n)]));

  const byKindRows = await db.select({ k: knowledgeItems.kind, n: count() }).from(knowledgeItems).where(active).groupBy(knowledgeItems.kind);
  const byVoiceRows = await db.select({ k: knowledgeItems.voice, n: count() }).from(knowledgeItems).where(active).groupBy(knowledgeItems.voice);
  const bySourceRows = await db.select({ k: knowledgeSources.sourceType, n: sql<number>`count(distinct ${knowledgeSources.itemId})`.mapWith(Number) })
    .from(knowledgeSources).innerJoin(knowledgeItems, eq(knowledgeItems.id, knowledgeSources.itemId)).where(active).groupBy(knowledgeSources.sourceType);

  const [problems] = await db.select({
    total: count(),
    independent: sql<number>`count(*) filter (where ${knowledgeItems.voice} in ('operator', 'neutral'))`.mapWith(Number),
  }).from(knowledgeItems).where(and(active, eq(knowledgeItems.kind, 'problem')));
  const [quotes] = await db.select({
    total: count(),
    verified: sql<number>`count(*) filter (where ${knowledgeItems.quoteVerified})`.mapWith(Number),
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
    countries: countryRows.map((r) => r.v),
    industries: industryRows.map((r) => r.v),
    newest: span?.newest ?? null,
    oldest: span?.oldest ?? null,
  };
}

export async function retrieveForRun(
  db: Db,
  queryVector: number[],
  opts: { limit: number; kinds?: ('problem' | 'pricing')[]; countries?: string[] },
): Promise<LibraryRow[]> {
  const limit = Math.min(Math.max(Math.floor(opts.limit), 0), RETRIEVAL_MAX);
  if (limit === 0) return [];
  const kinds = opts.kinds?.length ? opts.kinds : (['problem', 'pricing'] as const);
  const conds: (SQL | undefined)[] = [
    eq(knowledgeItems.status, 'active'),
    eq(knowledgeItems.quoteVerified, true),
    inArray(knowledgeItems.kind, [...kinds]),
    sql`${knowledgeItems.embedding} is not null`,
  ];
  if (opts.countries?.length) {
    const arr = sql`array[${sql.join(opts.countries.map((c) => sql`${c}`), sql`, `)}]::text[]`;
    conds.push(sql`(${knowledgeItems.countries} && ${arr} or 'global' = any(${knowledgeItems.countries}) or cardinality(${knowledgeItems.countries}) = 0)`);
  }
  const domainExpr = sql<string | null>`(select s.domain from knowledge_sources s where s.item_id = knowledge_items.id order by s.fetched_at, s.id limit 1)`;
  const pool = Math.min(Math.max(limit * 8, POOL_MIN), POOL_MAX);
  const cands = await db.select({ ...rowShape, sim: similarity(queryVector), domain: domainExpr })
    .from(knowledgeItems).where(and(...conds))
    .orderBy(cosineDistance(knowledgeItems.embedding, queryVector), asc(knowledgeItems.id)).limit(pool);

  const now = Date.now();
  const scored = cands.map((c) => {
    const ageYears = c.newestSourceAt ? Math.max(0, (now - c.newestSourceAt.getTime()) / YEAR_MS) : 0;
    const score = Number(c.sim)
      + (c.voice === 'operator' || c.voice === 'neutral' ? VOICE_BONUS : 0)
      - Math.max(0, ageYears - AGE_FREE_YEARS) * AGE_PENALTY_PER_YEAR;
    return { c, score };
  }).sort((a, b) => b.score - a.score);

  const perDomain = new Map<string, number>();
  const out: LibraryRow[] = [];
  for (const { c } of scored) {
    const dom = c.domain ?? c.id;
    const used = perDomain.get(dom) ?? 0;
    if (used >= PER_DOMAIN) continue;
    perDomain.set(dom, used + 1);
    const { sim: _sim, domain: _domain, ...row } = c;
    void _sim; void _domain;
    out.push(row as LibraryRow);
    if (out.length >= limit) break;
  }
  return out;
}
