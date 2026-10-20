import type { Db } from '@bcg/core/db/client';
import * as schema from '@bcg/core/db/schema';
import { cases, gateVerdicts, ideas, prospects, runs, stageEvents } from '@bcg/core/db/schema';
import { defaultRunConfig } from '@bcg/core/pipeline/types';
import { createTestDb } from '@bcg/core/db/test-db';
import { eq, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';

export { createTestDb };

type CaseInsert = typeof cases.$inferInsert;

let n = 0;

/** A succeeded run + idea + case. Returns the case row. */
export async function seedCase(db: Db, o: Partial<CaseInsert> & { lensId?: string } = {}) {
  n += 1;
  const { lensId, ...caseFields } = o;
  const [run] = await db.insert(runs).values({ config: defaultRunConfig({ seedType: 'open', marketId: 'ca-us' }), status: 'succeeded' }).returning();
  const [idea] = await db.insert(ideas).values({
    runId: run!.id, lensId: lensId ?? null, origin: 'generated', title: `Idea ${n}`, oneLiner: 'o', buyer: 'b', problem: 'p', solution: 's',
    signalIds: [], status: 'advanced',
  }).returning();
  const [row] = await db.insert(cases).values({
    ideaId: idea!.id, slug: `case-${n}`, title: `Case ${n}`, stage: 'new',
    sections: { summary: { oneLiner: 'o' } } as unknown as CaseInsert['sections'],
    gateAdvisory: false, model: 'm', promptVersion: 'p', ...caseFields,
  }).returning();
  return row!;
}

/** An idea the gate killed, with one failed and one passed verdict. */
export async function seedGatedOutIdea(db: Db, title = 'Killed idea') {
  const [run] = await db.insert(runs).values({ config: defaultRunConfig({ seedType: 'open', marketId: 'ca-us' }), status: 'succeeded' }).returning();
  const [idea] = await db.insert(ideas).values({
    runId: run!.id, origin: 'generated', title, oneLiner: 'one liner', buyer: 'b', problem: 'p', solution: 's', signalIds: [], status: 'gated_out',
  }).returning();
  await db.insert(gateVerdicts).values([
    { ideaId: idea!.id, check: 'reachability', pass: false, reasoning: 'no reachable buyer', model: 'm', promptVersion: 'p' },
    { ideaId: idea!.id, check: 'evidence', pass: true, reasoning: 'fine', model: 'm', promptVersion: 'p' },
  ]);
  return idea!;
}

/** A case with one prospect (email set). Returns both. */
export async function seedProspect(db: Db, o: Partial<typeof prospects.$inferInsert> = {}) {
  const kase = await seedCase(db);
  const [p] = await db.insert(prospects).values({
    caseId: kase.id, name: 'Agency', website: 'https://agency.example', domain: `agency-${kase.slug}.example`, location: 'Toronto',
    fitReason: 'fit', source: 'manual', email: `hello@${kase.slug}.example`, status: 'drafted', ...o,
  }).returning();
  return { kase, prospect: p! };
}

/** A run in `failed` status. */
export async function seedFailedRun(db: Db, error = 'boom') {
  const [run] = await db.insert(runs).values({
    config: defaultRunConfig({ seedType: 'open', marketId: 'ca-us' }), status: 'failed', error, currentStage: 'ideate',
  }).returning();
  return run!;
}

export async function getCase(db: Db, id: string) {
  const [row] = await db.select().from(cases).where(eq(cases.id, id));
  return row!;
}

export async function eventsOf(db: Db, caseId: string) {
  return db.select().from(stageEvents).where(eq(stageEvents.caseId, caseId));
}

/** Every row of every table in core's schema (sorted), so a test can assert that nothing at all changed. */
export async function snapshotDb(db: Db): Promise<Record<string, string[]>> {
  const tables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable));
  const out: Record<string, string[]> = {};
  for (const t of tables) {
    const rows = await db.select().from(t);
    out[getTableName(t)] = rows.map((r) => JSON.stringify(r)).sort();
  }
  return out;
}
