import { and, asc, cosineDistance, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { knowledgeItems } from '../db/schema';
import { capField } from '../llm/untrusted';
import { parseFacts, type KnowledgeKind } from './kinds';
import { itemLive, liveSource } from './live';

/** Web-safe: drizzle-orm, schema, kinds, live and llm/untrusted (no imports) only. Bound parameters only. */

export type CtxStartup = { id: string; name: string; whatItDoes: string; outcome: string; why?: string; url: string };
export type CtxPricing = { id: string; product: string; pricePoints: { amount: number; currency: string; unit: string }[]; buyer: string; url: string };
export type CtxChange = { id: string; kind: 'trend' | 'rule_change'; gist: string; keyFact: string; url: string };
export type CtxMarket = { id: string; segment: string; geography: string; keyFact: string; url: string };
export type IdeationContext = { alreadySold: CtxStartup[]; lessons: CtxStartup[]; pricing: CtxPricing[]; changing: CtxChange[]; markets: CtxMarket[] };

const DEFAULT_SOLD = 15;
const DEFAULT_LESSONS = 8;
const DEFAULT_PRICING = 15;
const DEFAULT_CHANGING = 10;
const DEFAULT_MARKETS = 6;
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
  if (limit === 0) return [];
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
  return db.select({ id: knowledgeItems.id, kind: knowledgeItems.kind, facts: knowledgeItems.facts, url: urlExpr(now) })
    .from(knowledgeItems).where(and(...conds))
    .orderBy(asc(cosineDistance(knowledgeItems.embedding, queryVector)), asc(knowledgeItems.id))
    .limit(limit * OVERFETCH + extraRows);
}

function startups(rows: { id: string; facts: unknown; url: string }[]): CtxStartup[] {
  const out: CtxStartup[] = [];
  for (const r of rows) {
    try {
      const f = parseFacts('startup', r.facts) as { name: string; whatItDoes: string; outcome: string; why?: string };
      out.push({ id: r.id, name: f.name, whatItDoes: f.whatItDoes, outcome: f.outcome, ...(f.why ? { why: f.why } : {}), url: r.url });
    } catch { /* invalid facts: skipped */ }
  }
  return out;
}

export async function ideationContext(
  db: Db,
  queryVector: number[],
  opts: { countries?: string[]; alreadySoldMax?: number; lessonsMax?: number; pricingMax?: number; changingMax?: number; marketsMax?: number; now?: Date },
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
      pricing.push({ id: r.id, product: f.product, pricePoints: f.pricePoints, buyer: f.buyer, url: r.url });
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
      markets.push({ id: r.id, segment: f.segment, geography: f.geography, keyFact: f.sizeClues.slice(0, 2).map((c) => `${c.metric} ${c.value} ${c.unit} (${c.year})`).join('; '), url: r.url });
    } catch { /* invalid facts: skipped */ }
  }
  return { alreadySold: startups(soldRows).slice(0, soldMax), lessons, pricing: pricing.slice(0, pricingMax), changing, markets: markets.slice(0, marketsMax) };
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
function shiftMonths(d: Date, months: number): string {
  const x = new Date(d.getTime());
  x.setUTCMonth(x.getUTCMonth() + months);
  return isoDay(x);
}

function changes(rows: { id: string; kind: string; facts: unknown; url: string }[]): CtxChange[] {
  const out: CtxChange[] = [];
  for (const r of rows) {
    try {
      const kind = r.kind === 'trend' ? 'trend' : 'rule_change';
      if (kind === 'trend') {
        const f = parseFacts('trend', r.facts) as { topic: string; direction: string; evidence: { metric: string; value: string; period: string }[] };
        const e = f.evidence[0]!;
        out.push({ id: r.id, kind, gist: f.topic, keyFact: `${f.direction}: ${e.metric} ${e.value} (${e.period})`, url: r.url });
      } else {
        const f = parseFacts('rule_change', r.facts) as { title: string; change: string; jurisdiction: string; status: string; effectiveDate: string | null; publishedDate: string | null };
        const when = f.effectiveDate ? `effective ${f.effectiveDate}` : f.publishedDate ? `published ${f.publishedDate}` : 'date unknown';
        out.push({ id: r.id, kind, gist: `${f.title}: ${f.change}`, keyFact: `${f.status}, ${when}, ${f.jurisdiction}`, url: r.url });
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

const startupLine = (s: CtxStartup): string =>
  capField(`[${s.id}] ${capField(s.name, 80)} (${s.outcome}): ${capField(s.whatItDoes, 140)}${s.why ? ` | why: ${capField(s.why, 100)}` : ''} | ${capField(s.url, 80)}`, LINE_MAX);

const pricingLine = (p: CtxPricing): string => {
  const pts = p.pricePoints.slice(0, 4).map((x) => `${x.amount} ${capField(x.currency, 8)}/${capField(x.unit, 16)}`).join(', ') || 'no price points';
  return capField(`[${p.id}] ${capField(p.product, 80)}: ${pts} | buyer: ${capField(p.buyer, 60)} | ${capField(p.url, 80)}`, LINE_MAX);
};

/** Plain text, one capped line per entry. The caller wraps each block with wrapUntrusted. */
const changeLine = (c: CtxChange): string =>
  capField(`[${c.id}] ${c.kind === 'trend' ? 'trend' : 'rule change'}: ${capField(c.gist, 140)} | ${capField(c.keyFact, 100)} | ${capField(c.url, 80)}`, LINE_MAX);

const marketLine = (m: CtxMarket): string =>
  capField(`[${m.id}] ${capField(m.segment, 80)} (${capField(m.geography, 40)}): ${capField(m.keyFact, 140)} | ${capField(m.url, 80)}`, LINE_MAX);

export function renderIdeationContext(ctx: IdeationContext): { alreadySold: string; lessons: string; pricing: string; changing: string; markets: string } {
  return {
    alreadySold: section(ctx.alreadySold.map(startupLine)),
    lessons: section(ctx.lessons.map(startupLine)),
    pricing: section(ctx.pricing.map(pricingLine)),
    changing: section(ctx.changing.map(changeLine)),
    markets: section(ctx.markets.map(marketLine)),
  };
}
