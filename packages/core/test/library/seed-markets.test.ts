import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client';
import { markets, researchMissions } from '../../src/db/schema';
import { MAX_QUEUED_MISSIONS, queueMission } from '../../src/dashboard/missions';
import { MissingMarketError } from '../../src/dashboard/runs';
import { MARKET_TIERS } from '../../src/pipeline/market-tiers';
import {
  INDIVIDUAL_POPULATION_TOPICS, SEED_MARKETS_DEFAULT_USD, sectorPopulationTopic, seedMarketMissions,
} from '../../src/library/seed-markets';
import { testDb } from '../helpers/db';

let db: Db;
beforeEach(async () => {
  db = await testDb();
});

const broadSectors = Object.keys(MARKET_TIERS.broad!);

describe('gen library seed-markets: one market research mission per sector, plus individual populations', () => {
  it('queues one mission per broad sector and three individual-population missions, past the owner queue cap', async () => {
    const r = await seedMarketMissions(db, { marketId: 'broad' });
    const rows = await db.select().from(researchMissions);
    expect(rows).toHaveLength(broadSectors.length + 3);
    expect(rows.length).toBeGreaterThan(MAX_QUEUED_MISSIONS);
    expect(r.queued).toHaveLength(broadSectors.length + 3);
    expect(r.skipped).toEqual([]);
    expect(r.totalUsd).toBeCloseTo((broadSectors.length + 3) * SEED_MARKETS_DEFAULT_USD);
    for (const row of rows) {
      expect(row).toMatchObject({ kinds: ['market'], countries: ['CA', 'US'], origin: 'owner', status: 'queued' });
      expect(Number(row.budgetUsd)).toBe(0.5);
      expect(row.topic.length).toBeLessThanOrEqual(200);
    }
    const topics = rows.map((x) => x.topic);
    for (const s of broadSectors) expect(topics).toContain(sectorPopulationTopic(s));
    for (const t of INDIVIDUAL_POPULATION_TOPICS) expect(topics).toContain(t.topic);
    expect(sectorPopulationTopic('law firms')).toBe(
      'number of law firms businesses/establishments in the United States and Canada (official statistics: census, statistical agencies, industry registers)',
    );
    expect(INDIVIDUAL_POPULATION_TOPICS.map((t) => t.topic).join('\n')).toMatch(/households[\s\S]*adults aged 18[\s\S]*employed workers/);
  });

  it('is idempotent: a topic with a queued, running or succeeded mission is skipped; a failed one is queued again', async () => {
    await seedMarketMissions(db, { marketId: 'broad' });
    const [first, second, third] = broadSectors.map(sectorPopulationTopic);
    await db.update(researchMissions).set({ status: 'running' }).where(eq(researchMissions.topic, first!));
    await db.update(researchMissions).set({ status: 'succeeded' }).where(eq(researchMissions.topic, second!));
    await db.update(researchMissions).set({ status: 'failed' }).where(eq(researchMissions.topic, third!));
    const again = await seedMarketMissions(db, { marketId: 'broad' });
    expect(again.queued.map((q) => q.topic)).toEqual([third]);
    expect(again.skipped).toHaveLength(broadSectors.length + 3 - 1);
    expect(again.totalUsd).toBeCloseTo(SEED_MARKETS_DEFAULT_USD);
    expect(await db.select().from(researchMissions)).toHaveLength(broadSectors.length + 3 + 1);
  });

  it('a dry run queues nothing and reports what it would queue; --budget-usd sets each mission budget', async () => {
    const dry = await seedMarketMissions(db, { marketId: 'broad', budgetUsd: 2, dryRun: true });
    expect(await db.select().from(researchMissions)).toHaveLength(0);
    expect(dry.queued).toHaveLength(broadSectors.length + 3);
    expect(dry.queued.every((q) => q.id === null)).toBe(true);
    expect(dry.totalUsd).toBeCloseTo((broadSectors.length + 3) * 2);
    await seedMarketMissions(db, { marketId: 'broad', budgetUsd: 2 });
    expect((await db.select().from(researchMissions)).every((x) => Number(x.budgetUsd) === 2)).toBe(true);
  });

  it('a market with no tiers uses its stored sectors; a missing market fails with a clear error', async () => {
    const [caUs] = await db.select().from(markets).where(eq(markets.id, 'ca-us'));
    const r = await seedMarketMissions(db, { marketId: 'ca-us', dryRun: true });
    expect(r.queued.map((q) => q.topic)).toEqual([...caUs!.sectors.map(sectorPopulationTopic), ...INDIVIDUAL_POPULATION_TOPICS.map((t) => t.topic)]);
    await db.delete(markets).where(eq(markets.id, 'broad'));
    await expect(seedMarketMissions(db, { marketId: 'broad' })).rejects.toThrow(/Market "broad" is missing/);
    await expect(seedMarketMissions(db, { marketId: 'broad' })).rejects.toBeInstanceOf(MissingMarketError);
  });

  it('an existing owner mission with the same topic counts, whoever queued it', async () => {
    await queueMission(db, { topic: sectorPopulationTopic(broadSectors[0]!), kinds: ['market'], countries: ['CA', 'US'] });
    const r = await seedMarketMissions(db, { marketId: 'broad', dryRun: true });
    expect(r.skipped).toEqual([sectorPopulationTopic(broadSectors[0]!)]);
  });
});
