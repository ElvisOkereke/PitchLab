import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  cases, claims, gateVerdicts, ideas, landingEvents, landingPages, outreachDrafts, outreachEvents, prospects, runs, scores,
  settings, stageEvents, suppressions, validationJobs, validationPacks,
} from '../db/schema';
import { EXAMPLE_SLUG, exampleFixture } from './fixture';

export { EXAMPLE_SLUG };
export const EXAMPLE_HIDDEN_KEY = 'example.hidden';
export const EXAMPLE_REFUSAL = 'This is the built-in example case; its validation pack is already there.';

/** True for an address on a reserved example domain (example.com / .org / .net, their subdomains, or *.example). */
export function isReservedExampleEmail(email: string): boolean {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const d = email.slice(at + 1).trim().toLowerCase();
  return ['example.com', 'example.org', 'example.net'].some((r) => d === r || d.endsWith(`.${r}`)) || d.endsWith('.example') || d === 'example';
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Exec = Db | Tx;

async function isHidden(db: Exec): Promise<boolean> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, EXAMPLE_HIDDEN_KEY));
  return row?.value === true;
}

async function setHidden(db: Exec, hidden: boolean): Promise<void> {
  await db.insert(settings).values({ key: EXAMPLE_HIDDEN_KEY, value: hidden })
    .onConflictDoUpdate({ target: settings.key, set: { value: hidden } });
}

async function exampleSlug(db: Exec): Promise<string | null> {
  const [row] = await db.select({ slug: cases.slug }).from(cases).where(eq(cases.isExample, true));
  return row?.slug ?? null;
}

/** Deletes every example row, children first (FK-safe). The caller supplies the transaction. */
async function deleteExample(tx: Tx): Promise<void> {
  const caseRows = await tx.select({ id: cases.id, ideaId: cases.ideaId }).from(cases).where(eq(cases.isExample, true));
  const runIds = (await tx.select({ id: runs.id }).from(runs).where(eq(runs.isExample, true))).map((r) => r.id);
  const caseIds = caseRows.map((c) => c.id);
  const runIdeaIds = runIds.length ? (await tx.select({ id: ideas.id }).from(ideas).where(inArray(ideas.runId, runIds))).map((i) => i.id) : [];
  const ideaIds = [...new Set([...caseRows.map((c) => c.ideaId), ...runIdeaIds])];

  if (caseIds.length) {
    const prospectRows = await tx.select({ id: prospects.id, email: prospects.email }).from(prospects).where(inArray(prospects.caseId, caseIds));
    const prospectIds = prospectRows.map((p) => p.id);
    // Only reserved example addresses: a real unsubscribe must never be deleted with the example (CASL).
    const emails = prospectRows.flatMap((p) => (p.email && isReservedExampleEmail(p.email) ? [p.email.toLowerCase()] : []));
    if (prospectIds.length) {
      await tx.delete(outreachEvents).where(inArray(outreachEvents.prospectId, prospectIds));
      await tx.delete(outreachDrafts).where(inArray(outreachDrafts.prospectId, prospectIds));
    }
    if (emails.length) await tx.delete(suppressions).where(inArray(suppressions.email, emails));
    await tx.delete(prospects).where(inArray(prospects.caseId, caseIds));
    const pageIds = (await tx.select({ id: landingPages.id }).from(landingPages).where(inArray(landingPages.caseId, caseIds))).map((p) => p.id);
    if (pageIds.length) await tx.delete(landingEvents).where(inArray(landingEvents.landingPageId, pageIds));
    await tx.delete(landingPages).where(inArray(landingPages.caseId, caseIds));
    await tx.delete(validationPacks).where(inArray(validationPacks.caseId, caseIds));
    await tx.delete(validationJobs).where(inArray(validationJobs.caseId, caseIds));
    await tx.delete(stageEvents).where(inArray(stageEvents.caseId, caseIds));
    await tx.delete(scores).where(inArray(scores.caseId, caseIds));
    await tx.delete(claims).where(inArray(claims.caseId, caseIds));
    await tx.delete(cases).where(inArray(cases.id, caseIds));
  }
  if (ideaIds.length) {
    await tx.delete(gateVerdicts).where(inArray(gateVerdicts.ideaId, ideaIds));
    await tx.delete(ideas).where(inArray(ideas.id, ideaIds));
  }
  if (runIds.length) await tx.delete(runs).where(inArray(runs.id, runIds));
}

async function insertExample(tx: Tx): Promise<boolean> {
  const f = exampleFixture();
  const [run] = await tx.insert(runs).values(f.run).returning({ id: runs.id });
  const [idea] = await tx.insert(ideas).values({ ...f.idea, runId: run!.id }).returning({ id: ideas.id });
  const [c] = await tx.insert(cases).values({ ...f.case, ideaId: idea!.id }).onConflictDoNothing({ target: cases.slug }).returning({ id: cases.id });
  if (!c) return false; // another process inserted the example first
  const caseId = c.id;
  await tx.insert(claims).values(f.claims.map((x) => ({ ...x, caseId })));
  await tx.insert(scores).values(f.scores.map((x) => ({ ...x, caseId })));
  await tx.insert(validationPacks).values({ ...f.pack, caseId });
  await tx.insert(landingPages).values({ ...f.landing, caseId });
  const now = new Date();
  const inserted = await tx.insert(prospects)
    .values(f.prospects.map((p) => ({ ...p, caseId, emailCapturedAt: p.email && p.emailSourceUrl ? now : null })))
    .returning({ id: prospects.id, domain: prospects.domain });
  const byDomain = new Map(inserted.map((p) => [p.domain, p.id]));
  await tx.insert(outreachDrafts).values(f.drafts.map(({ domain, ...d }) => ({
    ...d, prospectId: byDomain.get(domain)!, model: f.draftModel, promptVersion: 'example',
  })));
  return true;
}

class ExampleRaced extends Error {}

/** Inserts the example once, unless the owner hid it. Never called from seedDefaults (test DBs stay empty). */
export async function ensureExample(db: Db): Promise<'inserted' | 'present' | 'hidden'> {
  return db.transaction(async (tx) => {
    if (await isHidden(tx)) return 'hidden';
    if (await exampleSlug(tx)) return 'present';
    if (!(await insertExample(tx))) throw new ExampleRaced();
    return 'inserted';
  }).catch((err) => {
    if (err instanceof ExampleRaced) return 'present' as const; // rolled back the run and idea inserted before the conflict
    throw err;
  });
}

/** ensureExample for CLI start-up: never blocks a command; a failure becomes a one-line warning (no connection details). */
export async function ensureExampleQuietly(db: Db, warn: (line: string) => void): Promise<void> {
  try {
    await ensureExample(db);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? ` (${String((err as { code: unknown }).code).slice(0, 20)})` : '';
    warn(`warning: could not add the built-in example case${code}; continuing without it.`);
  }
}

/** Newest runs first, without the built-in example. */
export async function listRealRuns(db: Db, limit: number) {
  return db.select().from(runs).where(eq(runs.isExample, false)).orderBy(desc(runs.createdAt)).limit(limit);
}

/** Slugs of the owner's own cases, oldest first (the example is excluded). */
export async function realCaseSlugs(db: Db): Promise<string[]> {
  return (await db.select({ slug: cases.slug }).from(cases).where(and(eq(cases.isExample, false))).orderBy(cases.createdAt)).map((c) => c.slug);
}

/** Marks the example hidden and removes every example row. */
export async function hideExample(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await setHidden(tx, true);
    await deleteExample(tx);
  });
}

/** Replaces the example with a fresh copy (and un-hides it). */
export async function resetExample(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await deleteExample(tx);
    await setHidden(tx, false);
    await insertExample(tx);
  });
}

export async function exampleState(db: Db): Promise<{ hidden: boolean; slug: string | null }> {
  return { hidden: await isHidden(db), slug: await exampleSlug(db) };
}
