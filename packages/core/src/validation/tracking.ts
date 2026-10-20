import { count, countDistinct, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  OUTREACH_EVENT_TYPES, PROSPECT_STATUSES, outreachEvents, prospects, suppressions,
  type OutreachEventType, type ProspectStatus,
} from '../db/schema';
import { capField } from '../llm/untrusted';

// Outreach tracking (the owner records what he sent himself; nothing here sends email). Kept apart from the drafting
// code in outreach.ts so the dashboard can import it without pulling in the model router.

const PROGRESS: Partial<Record<ProspectStatus, number>> = { new: 0, drafted: 1, sent: 2, replied: 3, positive: 4, meeting: 5 };

/**
 * The status after an event. Forward only along new → drafted → sent → replied → positive → meeting; `not_interested`
 * and `unsubscribe` are the only moves that may go back. `unsubscribed` is final; `not_interested` changes only to
 * `unsubscribed`. A `note` never changes the status.
 */
export function nextStatus(current: ProspectStatus, type: OutreachEventType): ProspectStatus {
  if (current === 'unsubscribed') return current;
  if (type === 'unsubscribe') return 'unsubscribed';
  if (type === 'not_interested') return 'not_interested';
  if (type === 'note' || current === 'not_interested') return current;
  return (PROGRESS[type] ?? 0) > (PROGRESS[current] ?? 0) ? type : current;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_MAX = 2000;

export type MarkResult = { prospects: { id: string; status: ProspectStatus }[]; suppressed: string | null };

/**
 * Record an outreach event for a prospect, given by id or by email (case-insensitive), and move its status forward
 * (see nextStatus). `unsubscribe` also adds the lowercased address to `suppressions` (even when no prospect has it) and
 * applies to every prospect with that address; other events need exactly one matching prospect.
 */
export async function markOutreach(db: Db, prospectRef: string, type: OutreachEventType, note?: string): Promise<MarkResult> {
  const ref = prospectRef.trim();
  const byId = UUID.test(ref);
  if (!byId && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ref)) throw new Error(`Not a prospect id or email address: ${capField(ref, 200)}`);
  const matches = byId
    ? await db.select().from(prospects).where(eq(prospects.id, ref))
    : await db.select().from(prospects).where(eq(sql`lower(${prospects.email})`, ref.toLowerCase()));
  if (type !== 'unsubscribe') {
    if (matches.length === 0) throw new Error(`No prospect matches ${capField(ref, 200)}`);
    if (matches.length > 1) {
      throw new Error(`${matches.length} prospects have the address ${capField(ref, 200)}; use the prospect id: ${matches.map((m) => m.id).join(', ')}`);
    }
  }
  const email = byId ? matches[0]?.email ?? null : ref;
  if (byId && matches.length === 0) throw new Error(`No prospect matches ${ref}`);
  const suppressed = type === 'unsubscribe' && email ? email.toLowerCase() : null;
  const cleanNote = note === undefined ? null : capField(note, NOTE_MAX) || null;

  return db.transaction(async (tx) => {
    const out: MarkResult['prospects'] = [];
    for (const p of matches) {
      const status = nextStatus(p.status, type);
      await tx.insert(outreachEvents).values({ prospectId: p.id, type, note: cleanNote });
      if (status !== p.status) await tx.update(prospects).set({ status }).where(eq(prospects.id, p.id));
      out.push({ id: p.id, status });
    }
    if (suppressed) await tx.insert(suppressions).values({ email: suppressed, reason: 'unsubscribe' }).onConflictDoNothing();
    return { prospects: out, suppressed };
  });
}

export type OutreachCounts = {
  prospects: number;
  withEmail: number;
  byStatus: Record<ProspectStatus, number>;
  /** Per event type: number of events and number of distinct prospects with that event. */
  events: Record<OutreachEventType, { events: number; prospects: number }>;
};

/** All-zero counts (a case with no prospects). */
export function emptyOutreachCounts(): OutreachCounts {
  return {
    prospects: 0,
    withEmail: 0,
    byStatus: Object.fromEntries(PROSPECT_STATUSES.map((s) => [s, 0])) as Record<ProspectStatus, number>,
    events: Object.fromEntries(OUTREACH_EVENT_TYPES.map((t) => [t, { events: 0, prospects: 0 }])) as OutreachCounts['events'],
  };
}

/** Outreach totals for a case: prospects (all, with email, by status) and events by type with distinct prospects. */
export async function outreachCounts(db: Db, caseId: string): Promise<OutreachCounts> {
  const statusRows = await db.select({ status: prospects.status, n: count(), withEmail: count(prospects.email) })
    .from(prospects).where(eq(prospects.caseId, caseId)).groupBy(prospects.status);
  const eventRows = await db
    .select({ type: outreachEvents.type, events: count(), prospects: countDistinct(outreachEvents.prospectId) })
    .from(outreachEvents)
    .innerJoin(prospects, eq(prospects.id, outreachEvents.prospectId))
    .where(eq(prospects.caseId, caseId))
    .groupBy(outreachEvents.type);
  const { byStatus, events } = emptyOutreachCounts();
  let total = 0;
  let withEmail = 0;
  for (const r of statusRows) {
    byStatus[r.status] = r.n;
    total += r.n;
    withEmail += r.withEmail;
  }
  for (const r of eventRows) events[r.type] = { events: r.events, prospects: r.prospects };
  return { prospects: total, withEmail, byStatus, events };
}
