import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { markets } from '../db/schema';

export type MarketSummary = { id: string; name: string; sectors: string[] };

/** A market's name and sectors (the run queue's sector seeds, Settings), or null when unknown. */
export async function getMarket(db: Db, id: string): Promise<MarketSummary | null> {
  const [row] = await db.select({ id: markets.id, name: markets.name, sectors: markets.sectors }).from(markets).where(eq(markets.id, id));
  return row ?? null;
}
