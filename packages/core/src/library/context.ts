import { and, asc, cosineDistance, desc, eq, inArray, notInArray, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { finds, knowledgeItems } from '../db/schema';
import { capField } from '../llm/untrusted';
import { parseFacts, type KnowledgeKind } from './kinds';
import { parseAssessment, strengthLabel } from './strength';
import { itemLive, liveSource } from './live';

/** Web-safe: drizzle-orm, schema, kinds, live and llm/untrusted (no imports) only. Bound parameters only. */

export type CtxStartup = { strength?: string; id: string; name: string; whatItDoes: string; outcome: string; why?: string; url: string };
export type CtxPricing = { strength?: string; id: string; product: string; pricePoints: { amount: number; currency: string; unit: string }[]; buyer: string; url: string };
export type CtxChange = { strength?: string; id: string; kind: 'trend' | 'rule_change'; gist: string; keyFact: string; url: string };
export type CtxMarket = { strength?: string; id: string; segment: string; geography: string; keyFact: string; url: string };
/** A find (a link the owner shared): what it is, who pays and how it earns. The creator's claims are never shown. */
export type CtxFind = { strength?: string; id: string; what: string; whoPays: string; howItEarns: string; url: string };
export type IdeationContext = {
  alreadySold: CtxStartup[]; lessons: CtxStartup[]; pricing: CtxPricing[]; changing: CtxChange[]; markets: CtxMarket[];
  /** Finds seen in the wild: pinned finds first (a finds seed), then by similarity, ties to the most recent. At most FINDS_MAX. */
  seenInTheWild: CtxFind[];
};

const DEFAULT_SOLD = 15;
const DEFAULT_LESSONS = 8;
const DEFAULT_PRICING = 15;
const DEFAULT_CHANGING = 10;
const DEFAULT_MARKETS = 6;
/** Most finds shown to one ideate call (spec §C); also the default. */
export const FINDS_MAX = 6;
/** A rule change is imminent or recent when its effective date is within this many months of now (before or after). */
const RULE_WINDOW_MONTHS = 18;
const HARD_MAX = 50;
/** Over-fetch so invalid facts can be skipped and lessons with a why can be preferred, still one bounded query per section. */
const OVERFETCH = 3;

const clamp = (v: number | undefined, dflt: number): number =>
  Math.min(Math.max(v !== undefined && Number.isFinite(v) ? Math.floor(v) : dflt, 0), HARD_MAX);

// Expired sources are never used: the link is the oldest live source, and entries whose sources have all expired are skipped.
const urlExpr = (now: Date) => sql<string>`coalesce((select s.url from knowledge_sources s where s.item_id = knowledge_items.id and ${liveSource(now)} order by s.fetched_at, s.id limit 1), '')`;

async function fetchKind(db: Db, kind: KnowledgeKind | KnowledgeKind[], queryVector: number[], countries: string[] | undefined, extra: SQL | undefined, limit: number, now: Date, extraRows = 0) {
  if (limit === 0) return []; // a section set to 0 issues no query
  const conds: (SQL | undefined)[] = [
    eq(knowledgeItems.status, 'active'),
    itemLive(now),
    Array.isArray(kind) ? inArray(knowledgeItems.kind, kind) : eq(knowledgeItems.kind, kind),
    sql`${knowledgeItems.embedding} is not null`,
    extra,
  ];
  if (countries?.length) {
    const arr = sql`array[${sql.join(countries.map((c) => sql`${c}`), sql`, `)}]::text[]`;
    conds.push(sql`(${knowledgeItems.countries} && ${arr} or 'global' = any(${knowledgeItems.countries}) or cardinality(${knowledgeItems.countries}) = 0)`);
  }
  return db.select({ id: knowledgeItems.id, kind: knowledgeItems.kind, facts: knowledgeItems.facts, assessment: knowledgeItems.assessment, url: urlExpr(now) })
    .from(knowledgeItems).where(and(...conds))
    .orderBy(asc(cosineDistance(knowledgeItems.embedding, queryVector)), asc(knowledgeItems.id))
    .limit(limit * OVERFETCH + extraRows);
}

/** The strength label of a stored assessment, when it has one. */
const strengthOf = (assessment: unknown): { strength?: string } => {
  const a = parseAssessment(assessment);
  return a ? { strength: strengthLabel(a) } : {};
};

function startups(rows: { id: string; facts: unknown; assessment?: unknown; url: string }[]): CtxStartup[] {
  const out: CtxStartup[] = [];
  for (const r of rows) {
    try {
      const f = parseFacts('startup', r.facts) as { name: string; whatItDoes: string; outcome: string; why?: string };
      out.push({ id: r.id, name: f.name, whatItDoes: f.whatItDoes, outcome: f.outcome, ...(f.why ? { why: f.why } : {}), ...strengthOf(r.assessment), url: r.url });
    } catch { /* invalid facts: skipped */ }
  }
  return out;
}

export async function ideationContext(
  db: Db,
  queryVector: number[],
  opts: {
    countries?: string[]; alreadySoldMax?: number; lessonsMax?: number; pricingMax?: number; changingMax?: number; marketsMax?: number;
    /** At most FINDS_MAX (default FINDS_MAX). */
    seenInTheWildMax?: number;
    /** Find ids (rows of `finds`) shown first, in this order, when captured and live (a finds seed). */
    pinnedFindIds?: string[];
    now?: Date;
  },
): Promise<IdeationContext> {
  const now = opts.now ?? new Date();
  const soldMax = clamp(opts.alreadySoldMax, DEFAULT_SOLD);
  const lessonsMax = clamp(opts.lessonsMax, DEFAULT_LESSONS);
  const pricingMax = clamp(opts.pricingMax, DEFAULT_PRICING);
  const changingMax = clamp(opts.changingMax, DEFAULT_CHANGING);
  const marketsMax = clamp(opts.marketsMax, DEFAULT_MARKETS);
  const outcomeIn = (vals: string[]) => sql`${knowledgeItems.facts}->>'outcome' in (${sql.join(vals.map((v) => sql`${v}`), sql`, `)})`;

  const soldRows = await fetchKind(db, 'startup', queryVector, opts.countries, outcomeIn(['active', 'acquired', 'public']), soldMax, now);
  const lessonRows = await fetchKind(db, 'startup', queryVector, opts.countries, outcomeIn(['dead']), lessonsMax, now);
  const pricingRows = await fetchKind(db, 'pricing', queryVector, opts.countries, undefined, pricingMax, now);

  const lessonsAll = startups(lessonRows);
  const lessons = [...lessonsAll.filter((l) => l.why), ...lessonsAll.filter((l) => !l.why)].slice(0, lessonsMax);

  const pricing: CtxPricing[] = [];
  for (const r of pricingRows) {
    try {
      const f = parseFacts('pricing', r.facts) as { product: string; pricePoints: CtxPricing['pricePoints']; buyer: string };
      pricing.push({ id: r.id, product: f.product, pricePoints: f.pricePoints, buyer: f.buyer, ...strengthOf(r.assessment), url: r.url });
    } catch { /* invalid facts: skipped */ }
  }

  // Rule changes first when their effective date is within RULE_WINDOW_MONTHS of now (|effective - now|, past or future), then the
  // rest by similarity. Dates compare as ISO text, so a malformed stored date can never raise a cast error.
  const lo = shiftMonths(now, -RULE_WINDOW_MONTHS), hi = shiftMonths(now, RULE_WINDOW_MONTHS);
  const inWindow = sql`${knowledgeItems.facts}->>'effectiveDate' between ${lo} and ${hi}`;
  const nearRows = await fetchKind(db, 'rule_change', queryVector, opts.countries, inWindow, changingMax, now);
  const changeRows = await fetchKind(db, ['trend', 'rule_change'], queryVector, opts.countries, undefined, changingMax, now, nearRows.length);
  const nearIds = new Set(nearRows.map((r) => r.id));
  const changing = [...changes(nearRows), ...changes(changeRows.filter((r) => !nearIds.has(r.id)))].slice(0, changingMax);

  const marketRows = await fetchKind(db, 'market', queryVector, opts.countries, undefined, marketsMax, now);
  const markets: CtxMarket[] = [];
  for (const r of marketRows) {
    try {
      const f = parseFacts('market', r.facts) as { segment: string; geography: string; sizeClues: { metric: string; value: string; unit: string; year: string }[] };
      markets.push({ id: r.id, segment: f.segment, geography: f.geography, keyFact: f.sizeClues.slice(0, 2).map((c) => `${c.metric} ${c.value} ${c.unit} (${c.year})`).join('; '), ...strengthOf(r.assessment), url: r.url });
    } catch { /* invalid facts: skipped */ }
  }
  const seenInTheWild = await seenFinds(db, queryVector, Math.min(clamp(opts.seenInTheWildMax, FINDS_MAX), FINDS_MAX), opts.pinnedFindIds ?? [], now);
  return { alreadySold: startups(soldRows).slice(0, soldMax), lessons, pricing: pricing.slice(0, pricingMax), changing, markets: markets.slice(0, marketsMax), seenInTheWild };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toFinds(rows: { id: string; facts: unknown; assessment?: unknown; url: string }[]): CtxFind[] {
  const out: CtxFind[] = [];
  for (const r of rows) {
    try {
      const f = parseFacts('find', r.facts) as { what: string; whoPays: string; howItEarns: string };
      out.push({ id: r.id, what: f.what, whoPays: f.whoPays, howItEarns: f.howItEarns, ...strengthOf(r.assessment), url: r.url });
    } catch { /* invalid facts: skipped */ }
  }
  return out;
}

/**
 * The library entries of captured finds, in the given order (repeats dropped): active and live entries only, one
 * bounded query. Used for a finds seed (the pinned finds, and the topics harvest researches).
 */
export async function findEntries(db: Db, findIds: readonly string[], now: Date = new Date()): Promise<CtxFind[]> {
  const ids = [...new Set(findIds.filter((id) => UUID.test(id)).map((id) => id.toLowerCase()))].slice(0, HARD_MAX);
  if (!ids.length) return [];
  const rows = await db.select({ findId: finds.id, id: knowledgeItems.id, facts: knowledgeItems.facts, assessment: knowledgeItems.assessment, url: urlExpr(now) })
    .from(finds).innerJoin(knowledgeItems, eq(knowledgeItems.id, finds.knowledgeItemId))
    .where(and(inArray(finds.id, ids), eq(finds.status, 'done'), eq(knowledgeItems.status, 'active'), eq(knowledgeItems.kind, 'find'), itemLive(now)))
    .limit(ids.length);
  const byFind = new Map(rows.map((r) => [r.findId, r]));
  const seen = new Set<string>();
  const ordered: { id: string; facts: unknown; assessment?: unknown; url: string }[] = [];
  for (const id of ids) {
    const r = byFind.get(id);
    if (!r || seen.has(r.id)) continue; // two finds can share one library entry (merged)
    seen.add(r.id);
    ordered.push(r);
  }
  return toFinds(ordered);
}

/**
 * Finds for one ideate call: pinned finds first, then the rest by similarity (ties to the most recent entry). Finds
 * are proof that people pay somewhere, so the market's countries do not filter them (moving a find to a new market is
 * one of the ways ideate.v14 may use it).
 */
async function seenFinds(db: Db, queryVector: number[], max: number, pinnedFindIds: string[], now: Date): Promise<CtxFind[]> {
  if (max === 0) return []; // set to 0: no query
  const pinned = (await findEntries(db, pinnedFindIds, now)).slice(0, max);
  const left = max - pinned.length;
  if (left === 0) return pinned;
  const exclude = pinned.map((p) => p.id);
  const rows = await db.select({ id: knowledgeItems.id, facts: knowledgeItems.facts, assessment: knowledgeItems.assessment, url: urlExpr(now) })
    .from(knowledgeItems)
    .where(and(
      eq(knowledgeItems.status, 'active'), itemLive(now), eq(knowledgeItems.kind, 'find'), sql`${knowledgeItems.embedding} is not null`,
      exclude.length ? notInArray(knowledgeItems.id, exclude) : undefined,
    ))
    .orderBy(asc(cosineDistance(knowledgeItems.embedding, queryVector)), desc(knowledgeItems.createdAt), asc(knowledgeItems.id))
    .limit(left * OVERFETCH);
  return [...pinned, ...toFinds(rows).slice(0, left)];
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
function shiftMonths(d: Date, months: number): string {
  const x = new Date(d.getTime());
  x.setUTCMonth(x.getUTCMonth() + months);
  return isoDay(x);
}

function changes(rows: { id: string; kind: string; facts: unknown; assessment?: unknown; url: string }[]): CtxChange[] {
  const out: CtxChange[] = [];
  for (const r of rows) {
    try {
      const kind = r.kind === 'trend' ? 'trend' : 'rule_change';
      if (kind === 'trend') {
        const f = parseFacts('trend', r.facts) as { topic: string; direction: string; evidence: { metric: string; value: string; period: string }[] };
        const e = f.evidence[0]!;
        out.push({ id: r.id, kind, gist: f.topic, keyFact: `${f.direction}: ${e.metric} ${e.value} (${e.period})`, ...strengthOf(r.assessment), url: r.url });
      } else {
        const f = parseFacts('rule_change', r.facts) as { title: string; change: string; jurisdiction: string; status: string; effectiveDate: string | null; publishedDate: string | null };
        const when = f.effectiveDate ? `effective ${f.effectiveDate}` : f.publishedDate ? `published ${f.publishedDate}` : 'date unknown';
        out.push({ id: r.id, kind, gist: `${f.title}: ${f.change}`, keyFact: `${f.status}, ${when}, ${f.jurisdiction}`, ...strengthOf(r.assessment), url: r.url });
      }
    } catch { /* invalid facts: skipped */ }
  }
  return out;
}

const LINE_MAX = 300;
const SECTION_MAX = 6000;
const NONE = 'none found';

function section(lines: string[]): string {
  if (!lines.length) return NONE;
  const out: string[] = [];
  let size = 0;
  for (const l of lines) {
    if (size + l.length + 1 > SECTION_MAX) break;
    out.push(l);
    size += l.length + 1;
  }
  return out.join('\n');
}

/** ` | strength 4/5, first-hand` for an assessed entry, nothing otherwise. */
const strengthPart = (e: { strength?: string }): string => (e.strength ? ` | ${capField(e.strength, 40)}` : '');

const startupLine = (s: CtxStartup): string =>
  capField(`[${s.id}] ${capField(s.name, 80)} (${s.outcome}): ${capField(s.whatItDoes, 140)}${s.why ? ` | why: ${capField(s.why, 100)}` : ''}${strengthPart(s)} | ${capField(s.url, 80)}`, LINE_MAX);

const pricingLine = (p: CtxPricing): string => {
  const pts = p.pricePoints.slice(0, 4).map((x) => `${x.amount} ${capField(x.currency, 8)}/${capField(x.unit, 16)}`).join(', ') || 'no price points';
  return capField(`[${p.id}] ${capField(p.product, 80)}: ${pts} | buyer: ${capField(p.buyer, 60)}${strengthPart(p)} | ${capField(p.url, 80)}`, LINE_MAX);
};

const changeLine = (c: CtxChange): string =>
  capField(`[${c.id}] ${c.kind === 'trend' ? 'trend' : 'rule change'}: ${capField(c.gist, 140)} | ${capField(c.keyFact, 100)}${strengthPart(c)} | ${capField(c.url, 80)}`, LINE_MAX);

const findLine = (f: CtxFind): string =>
  capField(`[${f.id}] ${capField(f.what, 140)} | who pays: ${capField(f.whoPays, 60)} | earns: ${capField(f.howItEarns, 60)}${strengthPart(f)} | ${capField(f.url, 80)}`, LINE_MAX);

const marketLine = (m: CtxMarket): string =>
  capField(`[${m.id}] ${capField(m.segment, 80)} (${capField(m.geography, 40)}): ${capField(m.keyFact, 140)}${strengthPart(m)} | ${capField(m.url, 80)}`, LINE_MAX);

/** Plain text, one capped line per entry. The caller wraps each block with wrapUntrusted. */
export function renderIdeationContext(ctx: IdeationContext): { alreadySold: string; lessons: string; pricing: string; changing: string; markets: string; seenInTheWild: string } {
  return {
    alreadySold: section(ctx.alreadySold.map(startupLine)),
    lessons: section(ctx.lessons.map(startupLine)),
    pricing: section(ctx.pricing.map(pricingLine)),
    changing: section(ctx.changing.map(changeLine)),
    markets: section(ctx.markets.map(marketLine)),
    seenInTheWild: section(ctx.seenInTheWild.map(findLine)),
  };
}
