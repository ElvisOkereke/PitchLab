import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { dataCalls, llmCalls, researchMissions, type runStatus } from '../db/schema';
import { SLICE_A_KINDS } from '../library/kinds';
import { libraryCoverage } from '../library/store';
import { BACKGROUND_TOPICS, GAP_COUNTRIES, GAP_INDUSTRIES } from '../research/topics';
import { getSetting, setSetting } from '../validation/settings';
import { torontoDayStart } from './command';

// Web-safe: imported by the dashboard. No env, router or collector runtime here.

type RunStatus = (typeof runStatus.enumValues)[number];

export const MissionInputSchema = z.object({
  topic: z.string().trim().min(3).max(200),
  kinds: z.array(z.enum(SLICE_A_KINDS)).min(1).max(3).default(['problem', 'pricing', 'startup']),
  countries: z.array(z.string().regex(/^([A-Z]{2}|global)$/)).max(10).default([]),
  audience: z.enum(['business', 'consumer', 'both']).optional(),
  budgetUsd: z.number().min(0.5).max(10).default(2),
});
export type MissionInput = z.input<typeof MissionInputSchema>;

export const MAX_QUEUED_MISSIONS = 3;
export const BACKGROUND_BUDGET_USD = 1;
export const RESEARCH_KEYS = { background: 'research.background', dailyCapUsd: 'research.dailyCapUsd' } as const;
const TOPIC_INDEX_KEY = 'research.topicIndex';
const DEFAULT_DAILY_CAP_USD = 5;
/** Every Nth background pick targets the least-covered country or industry instead of the next listed topic. */
const GAP_EVERY = 4;
/** Serialises queue inserts (transaction-scoped lock); a different key from the run and validation queues. */
const MISSION_LOCK_KEY = 0x6263_7133; // "bcq3"

type MissionOrigin = 'owner' | 'background';
export type QueueMissionResult = { ok: true; id: string } | { ok: false; reason: 'too_many_queued' };

async function insertMission(tx: Db, raw: MissionInput, origin: MissionOrigin): Promise<QueueMissionResult> {
  const input = MissionInputSchema.parse(raw);
  const [queued] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(researchMissions).where(eq(researchMissions.status, 'queued'));
  if ((queued?.n ?? 0) >= MAX_QUEUED_MISSIONS) return { ok: false, reason: 'too_many_queued' };
  const [row] = await tx.insert(researchMissions).values({
    topic: input.topic,
    kinds: input.kinds,
    countries: input.countries,
    audience: input.audience ?? null,
    budgetUsd: String(input.budgetUsd),
    origin,
    status: 'queued',
  }).returning({ id: researchMissions.id });
  return { ok: true, id: row!.id };
}

/** Queues a mission for `gen worker`. Refuses when MAX_QUEUED_MISSIONS are already waiting. */
export async function queueMission(db: Db, input: MissionInput, origin: MissionOrigin = 'owner'): Promise<QueueMissionResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${MISSION_LOCK_KEY})`);
    return insertMission(tx as unknown as Db, input, origin);
  });
}

export type MissionView = {
  id: string;
  topic: string;
  kinds: string[];
  countries: string[];
  audience: 'business' | 'consumer' | 'both' | null;
  origin: MissionOrigin;
  status: RunStatus;
  budgetUsd: number;
  costUsd: number;
  itemsAdded: number;
  itemsMerged: number;
  warnings: string[];
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};

/** Newest first; at most 50. */
export async function listMissions(db: Db, limit = 20): Promise<MissionView[]> {
  const rows = await db.select().from(researchMissions)
    .orderBy(desc(researchMissions.createdAt), desc(researchMissions.id)).limit(Math.min(Math.max(1, Math.floor(limit)), 50));
  return rows.map((r) => ({
    id: r.id, topic: r.topic, kinds: r.kinds, countries: r.countries, audience: r.audience ?? null, origin: r.origin, status: r.status,
    budgetUsd: Number(r.budgetUsd), costUsd: Number(r.costUsd), itemsAdded: r.itemsAdded, itemsMerged: r.itemsMerged,
    warnings: r.warnings, error: r.error, createdAt: r.createdAt, startedAt: r.startedAt, finishedAt: r.finishedAt,
  }));
}

/** Mean cost of the last 10 succeeded missions, or null when none has finished. */
export async function typicalMissionCost(db: Db): Promise<number | null> {
  const rows = await db.select({ c: researchMissions.costUsd }).from(researchMissions).where(eq(researchMissions.status, 'succeeded'))
    .orderBy(desc(researchMissions.finishedAt), desc(researchMissions.id)).limit(10);
  if (rows.length === 0) return null;
  return rows.reduce((s, r) => s + Number(r.c), 0) / rows.length;
}

export type ResearchSettings = { background: boolean; dailyCapUsd: number };

export async function getResearchSettings(db: Db): Promise<ResearchSettings> {
  const bg = await getSetting(db, RESEARCH_KEYS.background);
  const cap = await getSetting(db, RESEARCH_KEYS.dailyCapUsd);
  return {
    background: bg === true,
    dailyCapUsd: typeof cap === 'number' && Number.isFinite(cap) && cap >= 0 && cap <= 50 ? cap : DEFAULT_DAILY_CAP_USD,
  };
}

export async function saveResearchSettings(db: Db, s: ResearchSettings): Promise<void> {
  const parsed = z.object({ background: z.boolean(), dailyCapUsd: z.number().min(0).max(50) }).parse(s);
  await setSetting(db, RESEARCH_KEYS.background, parsed.background);
  await setSetting(db, RESEARCH_KEYS.dailyCapUsd, parsed.dailyCapUsd);
}

/** Model and data spend of background missions created since Toronto midnight. */
export async function backgroundSpendToday(db: Db, now: Date): Promise<number> {
  const since = torontoDayStart(now);
  const ids = db.select({ id: researchMissions.id }).from(researchMissions)
    .where(and(eq(researchMissions.origin, 'background'), gte(researchMissions.createdAt, since)));
  const [llm] = await db.select({ s: sql<string>`coalesce(sum(${llmCalls.costUsd}), 0)` }).from(llmCalls).where(inArray(llmCalls.missionId, ids));
  const [data] = await db.select({ s: sql<string>`coalesce(sum(${dataCalls.costUsd}), 0)` }).from(dataCalls).where(inArray(dataCalls.missionId, ids));
  return Number(llm?.s ?? 0) + Number(data?.s ?? 0);
}

const countryGap = (c: string): MissionInput => ({
  topic: `problems and pricing for small businesses and households in ${c}`, countries: [c], kinds: ['problem', 'pricing', 'startup'], budgetUsd: BACKGROUND_BUDGET_USD,
});
const industryGap = (i: string): MissionInput => ({
  topic: `problems and pricing in ${i}`, kinds: ['problem', 'pricing', 'startup'], budgetUsd: BACKGROUND_BUDGET_USD,
});

/** The pick-th (0-based) background topic. Every GAP_EVERY-th pick is a gap topic when the library lacks a country or industry. */
async function nextTopic(db: Db, pick: number): Promise<MissionInput> {
  if ((pick + 1) % GAP_EVERY === 0) {
    const cov = await libraryCoverage(db);
    const haveIndustries = cov.industries.map((x) => x.toLowerCase());
    const country = GAP_COUNTRIES.find((c) => !cov.countries.includes(c));
    const industry = GAP_INDUSTRIES.find((i) => !haveIndustries.includes(i));
    const first = Math.floor(pick / GAP_EVERY) % 2 === 0 ? 'country' : 'industry';
    const options = first === 'country' ? [country && countryGap(country), industry && industryGap(industry)] : [industry && industryGap(industry), country && countryGap(country)];
    const gap = options.find(Boolean);
    if (gap) return gap;
  }
  const t = BACKGROUND_TOPICS[pick % BACKGROUND_TOPICS.length]!;
  return { topic: t.topic, audience: t.audience, countries: t.countries, kinds: ['problem', 'pricing', 'startup'], budgetUsd: BACKGROUND_BUDGET_USD };
}

/**
 * Queues one background mission when background research is on, the Toronto-day cap is not reached and no background
 * mission is queued or running. Serialised under the mission lock, so restarting workers never double-queue.
 */
export async function maybeQueueBackgroundMission(db: Db, now: Date): Promise<'queued' | 'off' | 'cap_reached' | 'busy'> {
  return db.transaction(async (t) => {
    const tx = t as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(${MISSION_LOCK_KEY})`);
    const s = await getResearchSettings(tx);
    if (!s.background) return 'off';
    if ((await backgroundSpendToday(tx, now)) >= s.dailyCapUsd) return 'cap_reached';
    const [live] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(researchMissions)
      .where(and(eq(researchMissions.origin, 'background'), inArray(researchMissions.status, ['queued', 'running'])));
    if ((live?.n ?? 0) > 0) return 'busy';
    const stored = await getSetting(tx, TOPIC_INDEX_KEY);
    const pick = typeof stored === 'number' && Number.isInteger(stored) && stored >= 0 ? stored : 0;
    const result = await insertMission(tx, await nextTopic(tx, pick), 'background');
    if (!result.ok) return 'busy';
    await setSetting(tx, TOPIC_INDEX_KEY, pick + 1);
    return 'queued';
  });
}
