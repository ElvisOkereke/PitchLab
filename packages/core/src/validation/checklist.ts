import { and, count, countDistinct, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { landingEvents, landingPages, outreachEvents, prospects, validationPacks, type OutreachEventType } from '../db/schema';
import { PackSectionsSchema, type ChecklistMetricKey } from './schema';

export type GateStatus = {
  id: string;
  description: string;
  metricKey: ChecklistMetricKey;
  /** Current value from tracked data; null when it cannot be computed yet (no landing visits). */
  value: number | null;
  threshold: number;
  state: 'pass' | 'pending';
};

/** Distinct prospects of the case with at least one event of `type`. */
async function prospectsWith(db: Db, caseId: string, type: OutreachEventType): Promise<number> {
  const [row] = await db.select({ n: countDistinct(outreachEvents.prospectId) })
    .from(outreachEvents)
    .innerJoin(prospects, eq(prospects.id, outreachEvents.prospectId))
    .where(and(eq(prospects.caseId, caseId), eq(outreachEvents.type, type)));
  return row?.n ?? 0;
}

/** Note events of the case whose note starts with "interview:" (case-insensitive, leading spaces ignored). */
async function interviews(db: Db, caseId: string): Promise<number> {
  const [row] = await db.select({ n: count() })
    .from(outreachEvents)
    .innerJoin(prospects, eq(prospects.id, outreachEvents.prospectId))
    .where(and(
      eq(prospects.caseId, caseId),
      eq(outreachEvents.type, 'note'),
      sql`lower(ltrim(${outreachEvents.note})) like 'interview:%'`,
    ));
  return row?.n ?? 0;
}

/** Landing submits ÷ visits as a percentage (one decimal); null when the page has no visits. */
async function landingConversion(db: Db, caseId: string): Promise<number | null> {
  const pages = await db.select({ id: landingPages.id }).from(landingPages).where(eq(landingPages.caseId, caseId));
  if (pages.length === 0) return null;
  const rows = await db.select({ type: landingEvents.type, n: count() })
    .from(landingEvents)
    .where(inArray(landingEvents.landingPageId, pages.map((p) => p.id)))
    .groupBy(landingEvents.type);
  const visits = rows.find((r) => r.type === 'visit')?.n ?? 0;
  const submits = rows.find((r) => r.type === 'submit')?.n ?? 0;
  if (visits === 0) return null;
  return Math.round((submits / visits) * 1000) / 10;
}

/**
 * The stored checklist gates of a case with each metric's current value from tracked data: emails_sent, positive_replies
 * and meetings count distinct prospects with a `sent` / `positive` / `meeting` event; interviews_done counts `note`
 * events starting "interview:"; landing_conversion_pct is submits ÷ visits. A gate passes when value ≥ threshold and the
 * threshold is positive. Empty when the case has no (readable) pack.
 */
export async function computeChecklistStatus(db: Db, caseId: string): Promise<GateStatus[]> {
  const [row] = await db.select({ sections: validationPacks.sections }).from(validationPacks).where(eq(validationPacks.caseId, caseId));
  const parsed = row ? PackSectionsSchema.safeParse(row.sections) : null;
  if (!parsed?.success) return [];

  const cache = new Map<ChecklistMetricKey, Promise<number | null>>();
  const metric = (key: ChecklistMetricKey): Promise<number | null> => {
    if (!cache.has(key)) {
      cache.set(key, {
        emails_sent: () => prospectsWith(db, caseId, 'sent'),
        positive_replies: () => prospectsWith(db, caseId, 'positive'),
        meetings: () => prospectsWith(db, caseId, 'meeting'),
        interviews_done: () => interviews(db, caseId),
        landing_conversion_pct: () => landingConversion(db, caseId),
      }[key]());
    }
    return cache.get(key)!;
  };

  const out: GateStatus[] = [];
  for (const g of parsed.data.checklist.gates) {
    const value = await metric(g.metricKey);
    out.push({
      id: g.id,
      description: g.description,
      metricKey: g.metricKey,
      value,
      threshold: g.threshold,
      // P3-R16: a non-positive or non-finite threshold (legacy packs) never passes.
      state: value !== null && Number.isFinite(g.threshold) && g.threshold > 0 && value >= g.threshold ? 'pass' : 'pending',
    });
  }
  return out;
}
