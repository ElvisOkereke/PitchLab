import { eq } from 'drizzle-orm';
import type { Db } from '../../src/db/client';
import type { CaseSections } from '../../src/case/schema';
import { cases, ideas, runs } from '../../src/db/schema';
import type { RunConfig } from '../../src/pipeline/types';

/** Fresh in-memory PGlite database, migrated and seeded. */
export { createTestDb as testDb } from '../../src/db/test-db';

/** Inserts a queued run row and returns its id + config. */
export async function insertRun(db: Db, config: RunConfig): Promise<{ id: string; config: RunConfig }> {
  const [row] = await db.insert(runs).values({ config, status: 'queued' }).returning({ id: runs.id });
  return { id: row!.id, config };
}

/** 1536-d one-hot vector with a 1 at index i. */
export function unit(i: number): number[] {
  const v = Array<number>(1536).fill(0);
  v[i] = 1;
  return v;
}

type IdeaRow = typeof ideas.$inferSelect;

/** Inserts an idea with sensible defaults; `overrides` win. */
export async function insertIdea(db: Db, runId: string, overrides: Partial<typeof ideas.$inferInsert> = {}): Promise<IdeaRow> {
  const [row] = await db.insert(ideas).values({
    runId, origin: 'generated', title: 't', oneLiner: 'o', buyer: 'b', problem: 'p', solution: 's',
    signalIds: [], status: 'candidate', ...overrides,
  }).returning();
  return row!;
}

export async function getIdea(db: Db, id: string): Promise<IdeaRow> {
  const [row] = await db.select().from(ideas).where(eq(ideas.id, id));
  if (!row) throw new Error(`idea not found: ${id}`);
  return row;
}

type CaseRow = typeof cases.$inferSelect;

/** Inserts a case (minimal sections unless overridden) for an idea. */
export async function insertCase(db: Db, ideaId: string, overrides: Partial<typeof cases.$inferInsert> = {}): Promise<CaseRow> {
  const [row] = await db.insert(cases).values({
    ideaId, slug: `case-${ideaId}`, title: 'Case', stage: 'new',
    sections: { summary: { oneLiner: 'o' } } as unknown as CaseSections,
    gateAdvisory: false, model: 'm', promptVersion: 'p', ...overrides,
  }).returning();
  return row!;
}
