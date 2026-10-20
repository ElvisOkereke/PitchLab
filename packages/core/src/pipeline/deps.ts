import { eq } from 'drizzle-orm';
import type { Env } from '../config/env';
import type { Db } from '../db/client';
import { markets } from '../db/schema';
import { buildRouter } from '../llm/router';
import { fetchPage } from '../tools/fetch-page';
import { buildSources } from '../tools/sources';
import type { RunConfig, StageDeps } from './types';

/** The real stage dependencies for a run: model router, signal sources for the run's market, page fetcher. */
export async function buildStageDeps(env: Env, db: Db, config: RunConfig, log: (m: string) => void): Promise<StageDeps> {
  const [market] = await db.select().from(markets).where(eq(markets.id, config.marketId));
  return {
    db,
    router: buildRouter(env, db),
    sources: buildSources(env, market ? { countries: market.countries } : undefined),
    fetchPage,
    log,
  };
}
