import { and, desc, eq, sql } from 'drizzle-orm';
import { getMarket } from '../../dashboard/markets';
import { QUEUE_MARKET_ID } from '../../dashboard/runs';
import type { Db } from '../../db/client';
import { knowledgeItems, lenses } from '../../db/schema';
import { BACKGROUND_TOPICS } from '../topics';

export const MIN_TOPICS = 10;
export const MAX_TOPICS = 20;
/** Queries planned per run (inside 10 to 20). */
export const TARGET_TOPICS = 16;
/** Subreddits read per run, rotated from this list day by day. */
export const SUBREDDITS = ['entrepreneur', 'smallbusiness', 'SaaS', 'sidehustle', 'startups', 'EntrepreneurRideAlong', 'microsaas', 'indiehackers'] as const;
export const SUBREDDITS_PER_RUN = 3;

export type FeedTopics = { queries: string[]; subreddits: string[] };

/** A lens pattern cut to a short search phrase (first 6 words, letters and digits only, at most 60 characters). */
export function shortPhrase(s: string): string {
  const words = s.replace(/[^\p{L}\p{N}\s'-]+/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 6);
  let out = '';
  for (const w of words) {
    if ((out ? `${out} ${w}` : w).length > 60) break;
    out = out ? `${out} ${w}` : w;
  }
  return out;
}

const dayNumber = (now: Date): number => Math.floor(now.getTime() / 86_400_000);
const rotate = <T>(xs: T[], by: number): T[] => (xs.length === 0 ? xs : [...xs.slice(by % xs.length), ...xs.slice(0, by % xs.length)]);

/**
 * 10 to 20 feed queries, the same all day: the market's sectors, the active lenses' patterns (shortened) and the
 * library's rising trends, taken in turn from each pool, with the starting point of each pool moving on every day.
 * Short of 10, the background topic list fills the rest. Also three rotating subreddits.
 */
export async function planFeedTopics(db: Db, now: Date = new Date()): Promise<FeedTopics> {
  const day = dayNumber(now);
  const market = await getMarket(db, QUEUE_MARKET_ID);
  const sectors = (market?.sectors ?? []).map(shortPhrase).filter(Boolean);
  const lensPatterns = (await db.select({ id: lenses.id, pattern: lenses.pattern }).from(lenses).where(eq(lenses.active, true)).orderBy(lenses.id)).map((l) => shortPhrase(l.pattern)).filter(Boolean);
  const rising = await db.select({ topic: sql<string>`coalesce(${knowledgeItems.facts}->>'topic', ${knowledgeItems.title})` }).from(knowledgeItems)
    .where(and(eq(knowledgeItems.kind, 'trend'), eq(knowledgeItems.status, 'active'), sql`${knowledgeItems.facts}->>'direction' = 'rising'`))
    .orderBy(desc(knowledgeItems.updatedAt), knowledgeItems.id).limit(40);
  const trends = rising.map((r) => shortPhrase(r.topic)).filter(Boolean);

  const pools = [rotate(sectors, day * 3), rotate(lensPatterns, day * 3), rotate(trends, day * 3)];
  const seen = new Set<string>();
  const queries: string[] = [];
  const add = (q: string): boolean => {
    const key = q.toLowerCase();
    if (!q || seen.has(key)) return false;
    seen.add(key);
    queries.push(q);
    return true;
  };
  for (let i = 0; queries.length < TARGET_TOPICS && pools.some((p) => i < p.length); i++) {
    for (const p of pools) if (i < p.length && queries.length < TARGET_TOPICS) add(p[i]!);
  }
  const fill = rotate(BACKGROUND_TOPICS.map((t) => shortPhrase(t.topic)), day * 7);
  for (const q of fill) {
    if (queries.length >= MIN_TOPICS) break;
    add(q);
  }
  return { queries: queries.slice(0, MAX_TOPICS), subreddits: rotate([...SUBREDDITS], day * SUBREDDITS_PER_RUN).slice(0, SUBREDDITS_PER_RUN).map((s) => `r/${s}`) };
}
