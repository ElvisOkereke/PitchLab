import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BACKGROUND_BUDGET_USD, MAX_QUEUED_MISSIONS, MissionInputSchema, RESEARCH_KEYS, backgroundSpendToday, getResearchSettings, listMissions,
  maybeQueueBackgroundMission, queueMission, saveResearchSettings, typicalMissionCost,
} from '../../src/dashboard/missions';
import type { Db } from '../../src/db/client';
import { dataCalls, llmCalls, researchMissions } from '../../src/db/schema';
import { BACKGROUND_TOPICS } from '../../src/research/topics';
import { setSetting } from '../../src/validation/settings';
import { claimNextMission } from '../../src/worker';
import { testDb } from '../helpers/db';

let db: Db;
beforeEach(async () => {
  db = await testDb();
});

const topics = () => BACKGROUND_TOPICS.map((t) => t.topic);

async function spend(missionId: string, usd: number): Promise<void> {
  await db.insert(dataCalls).values({ missionId, provider: 'x', endpoint: 'y', costUsd: String(usd), ok: true });
}
async function finishAll(): Promise<void> {
  await db.update(researchMissions).set({ status: 'succeeded' });
}

describe('MissionInputSchema', () => {
  it('defaults and bounds', () => {
    expect(MissionInputSchema.parse({ topic: 'freight brokers' })).toEqual({
      topic: 'freight brokers', kinds: ['problem', 'pricing', 'startup'], countries: [], budgetUsd: 2,
    });
    expect(MissionInputSchema.safeParse({ topic: 'freight', budgetUsd: 0.4 }).success).toBe(false);
    expect(MissionInputSchema.safeParse({ topic: 'freight', budgetUsd: 25.01 }).success).toBe(false);
    // The ceiling rose from 10 to 25 so a bigger budget can buy more queries (maxQueriesFor).
    expect(MissionInputSchema.safeParse({ topic: 'freight', budgetUsd: 25 }).success).toBe(true);
    expect(MissionInputSchema.safeParse({ topic: 'ab' }).success).toBe(false);
    expect(MissionInputSchema.safeParse({ topic: 'x'.repeat(201) }).success).toBe(false);
    expect(MissionInputSchema.safeParse({ topic: 'freight', kinds: ['trend'] }).success).toBe(false);
    expect(MissionInputSchema.safeParse({ topic: 'freight', kinds: [] }).success).toBe(false);
    expect(MissionInputSchema.safeParse({ topic: 'freight', countries: ['ca'] }).success).toBe(false);
    expect(MissionInputSchema.safeParse({ topic: 'freight', countries: ['CA', 'global'] }).success).toBe(true);
  });
});

describe('queueMission and claimNextMission', () => {
  it('queues, then only one of two racing claims wins', async () => {
    const r = await queueMission(db, { topic: 'freight brokers' });
    expect(r.ok).toBe(true);
    const [a, b] = await Promise.all([claimNextMission(db), claimNextMission(db)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    const [row] = await db.select().from(researchMissions);
    expect(row).toMatchObject({ status: 'running', origin: 'owner', topic: 'freight brokers', budgetUsd: '2' });
    expect(row!.startedAt).toBeInstanceOf(Date);
    expect(await claimNextMission(db)).toBeNull();
  });

  // PGlite serialises transactions, so the advisory lock itself is exercised only on real Postgres.
  it('refuses a queue deeper than the cap, even when requests race', async () => {
    const rs = await Promise.all(Array.from({ length: MAX_QUEUED_MISSIONS + 2 }, (_, i) => queueMission(db, { topic: `topic ${i}` })));
    expect(rs.filter((r) => r.ok)).toHaveLength(MAX_QUEUED_MISSIONS);
    expect(rs.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'too_many_queued' }, { ok: false, reason: 'too_many_queued' }]);
  });
});

describe('owner-only counts', () => {
  it('queued background missions do not use the owner queue cap, and typical cost ignores them', async () => {
    for (let i = 0; i < MAX_QUEUED_MISSIONS; i++) {
      await db.insert(researchMissions).values({ topic: `bg ${i}`, kinds: ['problem'], countries: [], budgetUsd: '1', origin: 'background', status: 'queued' });
    }
    expect((await queueMission(db, { topic: 'owner topic' })).ok).toBe(true);
    await db.insert(researchMissions).values({ topic: 'bg done', kinds: ['problem'], countries: [], budgetUsd: '1', origin: 'background', status: 'succeeded', costUsd: '0.9', finishedAt: new Date() });
    expect(await typicalMissionCost(db)).toBeNull();
  });
});

describe('listMissions and typicalMissionCost', () => {
  it('lists newest first and averages the last succeeded costs', async () => {
    expect(await typicalMissionCost(db)).toBeNull();
    for (const c of ['1', '3']) {
      await db.insert(researchMissions).values({ topic: 't', kinds: ['problem'], countries: [], budgetUsd: '2', origin: 'owner', status: 'succeeded', costUsd: c, finishedAt: new Date() });
    }
    await db.insert(researchMissions).values({ topic: 'f', kinds: ['problem'], countries: [], budgetUsd: '2', origin: 'owner', status: 'failed', costUsd: '9' });
    expect(await typicalMissionCost(db)).toBe(2);
    expect(await listMissions(db, 2)).toHaveLength(2);
  });
});

describe('listMissions stalled flag', () => {
  it('flags a mission running for over 2 hours', async () => {
    await db.insert(researchMissions).values({ topic: 'a', kinds: ['problem'], countries: [], budgetUsd: '1', origin: 'owner', status: 'running', startedAt: new Date(Date.now() - 3 * 3600 * 1000) });
    await db.insert(researchMissions).values({ topic: 'b', kinds: ['problem'], countries: [], budgetUsd: '1', origin: 'owner', status: 'running', startedAt: new Date() });
    const byTopic = Object.fromEntries((await listMissions(db)).map((m) => [m.topic, m.stalled]));
    expect(byTopic).toEqual({ a: true, b: false });
  });
});

describe('research settings', () => {
  it('defaults, saves, and validates the cap', async () => {
    expect(await getResearchSettings(db)).toEqual({ background: false, dailyCapUsd: 5 });
    await saveResearchSettings(db, { background: true, dailyCapUsd: 12 });
    expect(await getResearchSettings(db)).toEqual({ background: true, dailyCapUsd: 12 });
    await expect(saveResearchSettings(db, { background: true, dailyCapUsd: 51 })).rejects.toThrow();
    await expect(saveResearchSettings(db, { background: true, dailyCapUsd: -1 })).rejects.toThrow();
  });
});

describe('maybeQueueBackgroundMission', () => {
  const now = new Date('2026-10-26T15:00:00Z');

  it('off by default', async () => {
    expect(await maybeQueueBackgroundMission(db, now)).toBe('off');
    expect(await db.select().from(researchMissions)).toHaveLength(0);
  });

  it('queues a $1 background mission, advances the topic, and is then busy', async () => {
    await saveResearchSettings(db, { background: true, dailyCapUsd: 5 });
    expect(await maybeQueueBackgroundMission(db, now)).toBe('queued');
    const [m] = await db.select().from(researchMissions);
    expect(m).toMatchObject({ origin: 'background', status: 'queued', topic: BACKGROUND_TOPICS[0]!.topic, budgetUsd: String(BACKGROUND_BUDGET_USD) });
    expect(await maybeQueueBackgroundMission(db, now)).toBe('busy');
    await db.update(researchMissions).set({ status: 'running', startedAt: now });
    expect(await maybeQueueBackgroundMission(db, now)).toBe('busy');
    await finishAll();
    expect(await maybeQueueBackgroundMission(db, now)).toBe('queued');
    expect(await getTopics()).toContain(BACKGROUND_TOPICS[1]!.topic);
  });

  async function getTopics(): Promise<string[]> {
    return (await db.select().from(researchMissions)).map((r) => r.topic);
  }

  // PGlite serialises transactions, so this exercises the logic; the advisory lock itself only matters on real Postgres.
  it('concurrent calls queue only one', async () => {
    await saveResearchSettings(db, { background: true, dailyCapUsd: 5 });
    const rs = await Promise.all([maybeQueueBackgroundMission(db, now), maybeQueueBackgroundMission(db, now), maybeQueueBackgroundMission(db, now)]);
    expect(rs.filter((r) => r === 'queued')).toHaveLength(1);
    expect(await db.select().from(researchMissions)).toHaveLength(1);
  });

  async function pickN(n: number): Promise<string[]> {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      expect(await maybeQueueBackgroundMission(db, now)).toBe('queued');
      const [m] = await db.select().from(researchMissions).where(eq(researchMissions.status, 'queued'));
      out.push(m!.topic);
      await finishAll();
    }
    return out;
  }

  it('the gap is exactly the 4th pick, then every 4th', async () => {
    await saveResearchSettings(db, { background: true, dailyCapUsd: 50 });
    const picked = await pickN(8);
    picked.forEach((t, i) => expect(topics().includes(t)).toBe((i + 1) % 4 !== 0));
  });

  it('an unfilled gap is not repeated back to back', async () => {
    await saveResearchSettings(db, { background: true, dailyCapUsd: 50 });
    const picked = await pickN(12);
    const gaps = picked.filter((t) => !topics().includes(t));
    expect(gaps).toHaveLength(3);
    expect(new Set(gaps).size).toBe(3);
  });

  it('40 list picks visit all 40 topics', async () => {
    await saveResearchSettings(db, { background: true, dailyCapUsd: 50 });
    const picked = await pickN(Math.ceil(40 / 3 * 4));
    const listPicks = picked.filter((t) => topics().includes(t));
    expect(new Set(listPicks.slice(0, 40)).size).toBe(40);
  });

  it('cap_reached when one more $1 mission would pass the cap', async () => {
    await saveResearchSettings(db, { background: true, dailyCapUsd: 5 });
    const [m] = await db.insert(researchMissions).values({
      topic: 'old', kinds: ['problem'], countries: [], budgetUsd: '1', origin: 'background', status: 'succeeded',
    }).returning({ id: researchMissions.id });
    await spend(m!.id, 4.01);
    expect(await maybeQueueBackgroundMission(db, new Date())).toBe('cap_reached');
    await db.update(dataCalls).set({ costUsd: '3.99' });
    expect(await maybeQueueBackgroundMission(db, new Date())).toBe('queued');
  });

  it('a stale running background mission does not block; a fresh one does', async () => {
    await saveResearchSettings(db, { background: true, dailyCapUsd: 50 });
    const [m] = await db.insert(researchMissions).values({
      topic: 'stuck', kinds: ['problem'], countries: [], budgetUsd: '1', origin: 'background', status: 'running', startedAt: new Date(Date.now() - 3 * 3600 * 1000),
    }).returning({ id: researchMissions.id });
    expect(await maybeQueueBackgroundMission(db, new Date())).toBe('queued');
    await db.delete(researchMissions).where(eq(researchMissions.status, 'queued'));
    await db.update(researchMissions).set({ startedAt: new Date() }).where(eq(researchMissions.id, m!.id));
    expect(await maybeQueueBackgroundMission(db, new Date())).toBe('busy');
  });

  it('stops at the daily cap and the Toronto day boundary resets it', async () => {
    await saveResearchSettings(db, { background: true, dailyCapUsd: 5 });
    // 03:30Z on the 27th is 23:30 on the 26th in Toronto (EDT); 05:00Z on the 27th is 01:00 on the 27th.
    const evening = new Date('2026-10-27T03:30:00Z');
    const [m] = await db.insert(researchMissions).values({
      topic: 'old', kinds: ['problem'], countries: [], budgetUsd: '1', origin: 'background', status: 'succeeded', createdAt: new Date('2026-10-26T14:00:00Z'),
    }).returning({ id: researchMissions.id });
    await spend(m!.id, 3);
    await db.insert(llmCalls).values({
      missionId: m!.id, stage: 's', provider: 'p', model: 'm', inputTokens: 0, outputTokens: 0, searchRequests: 0, costUsd: '2.5', latencyMs: 1, promptVersion: 'v', ok: true,
    });
    expect(await backgroundSpendToday(db, evening)).toBeCloseTo(5.5);
    expect(await maybeQueueBackgroundMission(db, evening)).toBe('cap_reached');
    const nextDay = new Date('2026-10-27T05:00:00Z');
    expect(await backgroundSpendToday(db, nextDay)).toBe(0);
    expect(await maybeQueueBackgroundMission(db, nextDay)).toBe('queued');
  });

  it('owner missions do not count toward the background cap', async () => {
    await saveResearchSettings(db, { background: true, dailyCapUsd: 1 });
    const [m] = await db.insert(researchMissions).values({
      topic: 'mine', kinds: ['problem'], countries: [], budgetUsd: '1', origin: 'owner', status: 'succeeded',
    }).returning({ id: researchMissions.id });
    await spend(m!.id, 4);
    expect(await backgroundSpendToday(db, new Date())).toBe(0);
  });

  it('uses the stored keys', () => {
    expect(RESEARCH_KEYS).toEqual({ background: 'research.background', dailyCapUsd: 'research.dailyCapUsd' });
  });

  it('ignores a corrupted topic index', async () => {
    await saveResearchSettings(db, { background: true, dailyCapUsd: 5 });
    await setSetting(db, 'research.topicIndex', 'x');
    expect(await maybeQueueBackgroundMission(db, now)).toBe('queued');
    expect((await db.select().from(researchMissions).where(eq(researchMissions.origin, 'background')))[0]!.topic).toBe(BACKGROUND_TOPICS[0]!.topic);
  });
});

describe('BACKGROUND_TOPICS', () => {
  it('has 40 distinct entries with valid countries', () => {
    expect(BACKGROUND_TOPICS).toHaveLength(40);
    expect(new Set(topics()).size).toBe(40);
    for (const t of BACKGROUND_TOPICS) {
      expect(MissionInputSchema.safeParse({ topic: t.topic, countries: t.countries, audience: t.audience }).success).toBe(true);
    }
  });
});
