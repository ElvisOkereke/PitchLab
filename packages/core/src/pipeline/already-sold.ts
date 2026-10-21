import { and, asc, desc, eq, exists, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { cases, gateVerdicts, ideas } from '../db/schema';
import { capField } from '../llm/untrusted';

const failedGeneric = (ideaId: typeof ideas.id) =>
  and(eq(gateVerdicts.ideaId, ideaId), eq(gateVerdicts.check, 'generic'), eq(gateVerdicts.pass, false));

/**
 * What ideation should steer away from, newest first, each list capped at `limit`:
 * - `sold`: ideas the gate killed because competitors already sell them (`gated_out` with a failed `generic` verdict),
 *   as "<title> — <reasoning excerpt>" (each part capped at 200 chars, one entry per idea);
 * - `covered`: titles (capped at 200) of ideas that already have a case, owner ideas included.
 * The text is untrusted; callers wrap it with wrapUntrusted.
 */
export async function loadAlreadySold(db: Db, limit = 15): Promise<{ sold: string[]; covered: string[] }> {
  const killed = await db
    .select({ id: ideas.id, title: ideas.title })
    .from(ideas)
    .where(and(eq(ideas.status, 'gated_out'), exists(db.select().from(gateVerdicts).where(failedGeneric(ideas.id)))))
    .orderBy(desc(ideas.createdAt), asc(ideas.id))
    .limit(limit);

  const reasons = new Map<string, string>();
  if (killed.length) {
    const rows = await db
      .select({ ideaId: gateVerdicts.ideaId, reasoning: gateVerdicts.reasoning })
      .from(gateVerdicts)
      .where(and(inArray(gateVerdicts.ideaId, killed.map((k) => k.id)), eq(gateVerdicts.check, 'generic'), eq(gateVerdicts.pass, false)))
      .orderBy(asc(gateVerdicts.createdAt), asc(gateVerdicts.id));
    for (const r of rows) if (!reasons.has(r.ideaId)) reasons.set(r.ideaId, r.reasoning);
  }
  const sold = killed.map((k) => `${capField(k.title, 200)} — ${capField(reasons.get(k.id), 200)}`);

  const written = await db
    .select({ title: ideas.title })
    .from(ideas)
    .innerJoin(cases, eq(cases.ideaId, ideas.id))
    .where(eq(cases.isExample, false))
    .orderBy(desc(cases.createdAt), asc(ideas.id))
    .limit(limit);
  const covered = written.map((w) => capField(w.title, 200));

  return { sold, covered };
}
