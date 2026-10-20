import { count, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { landingPages, outreachDrafts, outreachEvents, prospects, validationPacks } from '../db/schema';
import { computeChecklistStatus, type GateStatus } from '../validation/checklist';
import { emptyOutreachCounts, outreachCounts, type OutreachCounts } from '../validation/tracking';
import { clampPage } from './runs';

export type ValidationPackRow = typeof validationPacks.$inferSelect;
export type ProspectRow = typeof prospects.$inferSelect;
export type OutreachDraftRow = typeof outreachDrafts.$inferSelect;
export type OutreachEventRow = typeof outreachEvents.$inferSelect;

/** Most prospects per page of the Validate tab. */
export const PROSPECTS_PAGE_MAX = 100;
export const VALIDATE_EVENTS_MAX = 50;

export type ValidateView = {
  pack: ValidationPackRow | null;
  prospects: { rows: ProspectRow[]; total: number };
  /** Drafts of the prospects on this page, by prospect id, in kind order. */
  drafts: Map<string, OutreachDraftRow[]>;
  /** The latest outreach events of the case, newest first. */
  events: OutreachEventRow[];
  /** The landing page summary. Its HTML is never returned (only its size). */
  landing: { copy: unknown; publishedUrl: string | null; updatedAt: Date; htmlBytes: number } | null;
  /** Checklist gates with current values; null when there is no pack. */
  checklist: GateStatus[] | null;
  counts: OutreachCounts;
};

const KIND_ORDER = new Map(['cold', 'followup1', 'followup2'].map((k, i) => [k, i]));

/** Everything the Validate tab shows for one case (read-only; tracking writes go through markOutreach). */
export async function getValidateView(db: Db, caseId: string, o: { page?: number }): Promise<ValidateView> {
  // D2-R3: a malformed id gets the empty view, never a database error.
  if (!z.uuid().safeParse(caseId).success) {
    return {
      pack: null, prospects: { rows: [], total: 0 }, drafts: new Map(), events: [], landing: null, checklist: null,
      counts: emptyOutreachCounts(),
    };
  }
  const page = clampPage(o.page);
  const [[pack], prospectRows, [totalRow], events, [landing], counts] = await Promise.all([
    db.select().from(validationPacks).where(eq(validationPacks.caseId, caseId)),
    db.select().from(prospects).where(eq(prospects.caseId, caseId))
      .orderBy(prospects.createdAt, prospects.name, prospects.id)
      .limit(PROSPECTS_PAGE_MAX).offset((page - 1) * PROSPECTS_PAGE_MAX),
    db.select({ n: count() }).from(prospects).where(eq(prospects.caseId, caseId)),
    db.select({ event: outreachEvents }).from(outreachEvents)
      .innerJoin(prospects, eq(prospects.id, outreachEvents.prospectId))
      .where(eq(prospects.caseId, caseId))
      .orderBy(desc(outreachEvents.at), desc(outreachEvents.id))
      .limit(VALIDATE_EVENTS_MAX),
    db.select({
      copy: landingPages.copy, publishedUrl: landingPages.publishedUrl, updatedAt: landingPages.updatedAt,
      htmlBytes: sql<number>`octet_length(${landingPages.html})::int`,
    }).from(landingPages).where(eq(landingPages.caseId, caseId)),
    outreachCounts(db, caseId),
  ]);

  const drafts = new Map<string, OutreachDraftRow[]>();
  if (prospectRows.length) {
    const rows = await db.select().from(outreachDrafts).where(inArray(outreachDrafts.prospectId, prospectRows.map((p) => p.id)));
    rows.sort((a, b) => KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)!);
    for (const d of rows) drafts.set(d.prospectId, [...(drafts.get(d.prospectId) ?? []), d]);
  }

  return {
    pack: pack ?? null,
    prospects: { rows: prospectRows, total: totalRow?.n ?? 0 },
    drafts,
    events: events.map((e) => e.event),
    landing: landing ? { ...landing, htmlBytes: Number(landing.htmlBytes) } : null,
    checklist: pack ? await computeChecklistStatus(db, caseId) : null,
    counts,
  };
}
