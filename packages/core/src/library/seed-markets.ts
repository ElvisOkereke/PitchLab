import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { markets, researchMissions } from '../db/schema';
import { queueMission } from '../dashboard/missions';
import { MissingMarketError } from '../dashboard/runs';
import { MARKET_TIERS } from '../pipeline/market-tiers';

/**
 * `gen library seed-markets`: research missions that add sourced `market` entries with buyer counts, so ideas can cite
 * a shown <markets> entry as their population source and clear the gate's buyer floor ("sourced, not assumed").
 */

/** The default budget of each seed mission (the mission minimum). */
export const SEED_MARKETS_DEFAULT_USD = 0.5;
const KINDS = ['market'] as const;
const COUNTRIES = ['CA', 'US'];

/** The topic of one sector's business-count mission (at most 200 characters for every broad sector). */
export function sectorPopulationTopic(sector: string): string {
  return `number of ${sector} businesses/establishments in the United States and Canada (official statistics: census, statistical agencies, industry registers)`;
}

/** The individual buyer pools (consumer ideas need at least 1,000,000 individuals with a source). */
export const INDIVIDUAL_POPULATION_TOPICS: readonly { topic: string; audience: 'consumer' }[] = [
  { topic: 'number of households in the United States and Canada (official statistics: census, statistical agencies)', audience: 'consumer' },
  { topic: 'number of adults aged 18 and over in the United States and Canada (official statistics: census, statistical agencies)', audience: 'consumer' },
  { topic: 'number of employed workers in the United States and Canada (official statistics: labour force surveys, statistical agencies)', audience: 'consumer' },
];

export type SeedMarketsResult = {
  /** Missions queued (or, on a dry run, that would be queued; `id` is then null). */
  queued: { topic: string; id: string | null }[];
  /** Topics skipped because a mission with the same topic is queued, running or succeeded. */
  skipped: string[];
  /** The total budget of the queued missions. */
  totalUsd: number;
};

/**
 * Queues one `market` research mission (CA and US) per sector of the market (MARKET_TIERS keys when the market has
 * tiers, else its stored sectors), plus the individual-population missions. Idempotent: a topic that already has a
 * queued, running or succeeded mission is skipped (a failed one is queued again). Owner missions, past the queue cap:
 * this is a deliberate batch whose total budget the CLI prints. Throws when the market is missing (migration not run).
 */
export async function seedMarketMissions(
  db: Db, opts: { marketId: string; budgetUsd?: number; dryRun?: boolean },
): Promise<SeedMarketsResult> {
  const budgetUsd = opts.budgetUsd ?? SEED_MARKETS_DEFAULT_USD;
  const [market] = await db.select({ sectors: markets.sectors }).from(markets).where(eq(markets.id, opts.marketId));
  if (!market) throw new MissingMarketError(`Market "${opts.marketId}" is missing. Run the database migrations (migration 0018 adds "broad"), then try again.`);
  const tiers = MARKET_TIERS[opts.marketId];
  const sectors = tiers ? Object.keys(tiers) : market.sectors;
  const wanted: { topic: string; audience: 'business' | 'consumer' }[] = [
    ...sectors.map((s) => ({ topic: sectorPopulationTopic(s), audience: 'business' as const })),
    ...INDIVIDUAL_POPULATION_TOPICS,
  ];
  const existing = new Set((await db.select({ topic: researchMissions.topic }).from(researchMissions).where(and(
    inArray(researchMissions.topic, wanted.map((w) => w.topic)),
    inArray(researchMissions.status, ['queued', 'running', 'succeeded']),
  ))).map((r) => r.topic));

  const queued: SeedMarketsResult['queued'] = [];
  const skipped: string[] = [];
  for (const w of wanted) {
    if (existing.has(w.topic)) {
      skipped.push(w.topic);
      continue;
    }
    existing.add(w.topic);
    if (opts.dryRun) {
      queued.push({ topic: w.topic, id: null });
      continue;
    }
    const r = await queueMission(db, { topic: w.topic, kinds: [...KINDS], countries: COUNTRIES, audience: w.audience, budgetUsd }, 'owner', { cap: false });
    if (!r.ok) throw new Error(`could not queue "${w.topic}": ${r.reason}`);
    queued.push({ topic: w.topic, id: r.id });
  }
  return { queued, skipped, totalUsd: queued.length * budgetUsd };
}
