import { z } from 'zod';
import type { Db } from '../db/client';
import { getSetting } from '../validation/settings';

/** Web-safe (zod and settings only): what the last dossier run did, for Settings → Connections. */
export const DOSSIERS_STATS_KEY = 'dossiers.lastStats';

const Stats = z.object({
  at: z.iso.datetime({ offset: true }),
  done: z.number().int().min(0).catch(0),
  unmatched: z.number().int().min(0).catch(0),
  failed: z.number().int().min(0).catch(0),
  spentUsd: z.number().min(0).catch(0),
  warnings: z.array(z.string().max(300)).max(10).catch([]),
});
export type DossiersStatus = z.infer<typeof Stats>;

/** The last dossier run's counts, or null when none ran yet (or the setting is malformed). */
export async function readDossiersStatus(db: Db): Promise<DossiersStatus | null> {
  const parsed = Stats.safeParse(await getSetting(db, DOSSIERS_STATS_KEY));
  return parsed.success ? parsed.data : null;
}
