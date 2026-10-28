import { and, asc, cosineDistance, eq, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client';
import { knowledgeItems } from '../db/schema';
import { capField } from '../llm/untrusted';
import { parseFacts } from './kinds';
import { itemLive, liveSource } from './live';

/** Web-safe: drizzle-orm, schema, kinds, live and llm/untrusted (no imports) only. Bound parameters only. */

export type CtxStartup = { id: string; name: string; whatItDoes: string; outcome: string; why?: string; url: string };
export type CtxPricing = { id: string; product: string; pricePoints: { amount: number; currency: string; unit: string }[]; buyer: string; url: string };
export type IdeationContext = { alreadySold: CtxStartup[]; lessons: CtxStartup[]; pricing: CtxPricing[] };

const DEFAULT_SOLD = 15;
const DEFAULT_LESSONS = 8;
const DEFAULT_PRICING = 15;
const HARD_MAX = 50;
/** Over-fetch so invalid facts can be skipped and lessons with a why can be preferred, still one bounded query per section. */
const OVERFETCH = 3;

const clamp = (v: number | undefined, dflt: number): number =>
  Math.min(Math.max(v !== undefined && Number.isFinite(v) ? Math.floor(v) : dflt, 0), HARD_MAX);

// Expired sources are never used: the link is the oldest live source, and entries whose sources have all expired are skipped.
const urlExpr = (now: Date) => sql<string>`coalesce((select s.url from knowledge_sources s where s.item_id = knowledge_items.id and ${liveSource(now)} order by s.fetched_at, s.id limit 1), '')`;

async function fetchKind(db: Db, kind: 'startup' | 'pricing', queryVector: number[], countries: string[] | undefined, extra: SQL | undefined, limit: number, now: Date) {
  if (limit === 0) return [];
  const conds: (SQL | undefined)[] = [
    eq(knowledgeItems.status, 'active'),
    itemLive(now),
    eq(knowledgeItems.kind, kind),
    sql`${knowledgeItems.embedding} is not null`,
    extra,
  ];
  if (countries?.length) {
    const arr = sql`array[${sql.join(countries.map((c) => sql`${c}`), sql`, `)}]::text[]`;
    conds.push(sql`(${knowledgeItems.countries} && ${arr} or 'global' = any(${knowledgeItems.countries}) or cardinality(${knowledgeItems.countries}) = 0)`);
  }
  return db.select({ id: knowledgeItems.id, facts: knowledgeItems.facts, url: urlExpr(now) })
    .from(knowledgeItems).where(and(...conds))
    .orderBy(asc(cosineDistance(knowledgeItems.embedding, queryVector)), asc(knowledgeItems.id))
    .limit(limit * OVERFETCH);
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
  opts: { countries?: string[]; alreadySoldMax?: number; lessonsMax?: number; pricingMax?: number; now?: Date },
): Promise<IdeationContext> {
  const now = opts.now ?? new Date();
  const soldMax = clamp(opts.alreadySoldMax, DEFAULT_SOLD);
  const lessonsMax = clamp(opts.lessonsMax, DEFAULT_LESSONS);
  const pricingMax = clamp(opts.pricingMax, DEFAULT_PRICING);
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
  return { alreadySold: startups(soldRows).slice(0, soldMax), lessons, pricing: pricing.slice(0, pricingMax) };
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
export function renderIdeationContext(ctx: IdeationContext): { alreadySold: string; lessons: string; pricing: string } {
  return {
    alreadySold: section(ctx.alreadySold.map(startupLine)),
    lessons: section(ctx.lessons.map(startupLine)),
    pricing: section(ctx.pricing.map(pricingLine)),
  };
}
