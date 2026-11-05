// Holdout examples: up to 10 owner-written ideas of the kind they want, kept in the `audit.holdout` setting and compared
// with a pass's generated ideas by cosine similarity (the router's `embed` model, which is the library's model).
// They are for the owner only: no pipeline or prompt code may read them (a guard test enforces it).
// Web-safe: `holdoutCompare` only takes a router as an argument (type import).
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { benchmarkPasses, ideas, runs } from '../db/schema';
import type { ModelRouter } from '../llm/types';
import { getSetting, setSetting } from '../validation/settings';

export const HOLDOUT_KEY = 'audit.holdout';
export const HOLDOUT_MAX_ITEMS = 10;
export const HOLDOUT_MAX_CHARS = 1000;
const COMPARE_IDEAS_MAX = 1000;
const resultsKey = (passId: string) => `audit.holdoutResults.${passId}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type HoldoutResult = { items: { text: string; bestIdeaTitle: string; similarity: number }[]; median: number | null };
export type StoredHoldoutResult = HoldoutResult & { computedAt: string };
export type HoldoutRefusal = 'empty' | 'too_long' | 'full';
export const HOLDOUT_REFUSAL: Record<HoldoutRefusal, string> = {
  empty: 'Write an example first.',
  too_long: `Each example can be at most ${HOLDOUT_MAX_CHARS} characters.`,
  full: `You can keep at most ${HOLDOUT_MAX_ITEMS} examples. Remove one first.`,
};

/** Trimmed, non-empty, de-duplicated (ignoring case) items; refused when one is too long or there are too many. */
export function normaliseHoldout(texts: string[]): { ok: true; items: string[] } | { ok: false; reason: HoldoutRefusal } {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const t of texts) {
    const text = t.trim();
    if (text === '') continue;
    if (text.length > HOLDOUT_MAX_CHARS) return { ok: false, reason: 'too_long' };
    const k = text.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    items.push(text);
  }
  if (items.length > HOLDOUT_MAX_ITEMS) return { ok: false, reason: 'full' };
  return { ok: true, items };
}

/** The saved examples (a malformed stored value reads as none; extra or long items are cut to the caps). */
export async function holdoutList(db: Db): Promise<string[]> {
  const v = await getSetting(db, HOLDOUT_KEY);
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const items: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const t = x.trim().slice(0, HOLDOUT_MAX_CHARS);
    if (t === '' || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    items.push(t);
    if (items.length === HOLDOUT_MAX_ITEMS) break;
  }
  return items;
}

/** Replaces the whole list (the Settings editor). */
export async function holdoutSet(db: Db, texts: string[]): Promise<{ ok: true; items: string[] } | { ok: false; reason: HoldoutRefusal }> {
  const n = normaliseHoldout(texts);
  if (n.ok) await setSetting(db, HOLDOUT_KEY, n.items);
  return n;
}

/** Adds one example; one already saved (ignoring case) is kept once, not added again. */
export async function holdoutAdd(db: Db, text: string): Promise<{ ok: true; items: string[]; added: boolean } | { ok: false; reason: HoldoutRefusal }> {
  if (text.trim() === '') return { ok: false, reason: 'empty' };
  const current = await holdoutList(db);
  const r = await holdoutSet(db, [...current, text]);
  if (!r.ok) return r;
  return { ok: true, items: r.items, added: r.items.length > current.length };
}

export async function holdoutClear(db: Db): Promise<void> {
  await setSetting(db, HOLDOUT_KEY, []);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * For each holdout example, the pass's generated idea most like it and the cosine similarity. One embed call covers the
 * examples plus any idea with no stored embedding. Returns no items (and makes no call) with no examples or no ideas.
 */
export async function holdoutCompare(deps: { db: Db; router: ModelRouter }, passId: string): Promise<HoldoutResult> {
  const { db, router } = deps;
  const none: HoldoutResult = { items: [], median: null };
  if (!UUID_RE.test(passId)) return none;
  const texts = await holdoutList(db);
  if (texts.length === 0) return none;
  const [pass] = await db.select({ runIds: benchmarkPasses.runIds }).from(benchmarkPasses).where(eq(benchmarkPasses.id, passId));
  if (!pass || pass.runIds.length === 0) return none;
  const rows = await db.select({
    title: ideas.title, oneLiner: ideas.oneLiner, problem: ideas.problem, embedding: ideas.embedding,
  }).from(ideas).innerJoin(runs, eq(runs.id, ideas.runId))
    .where(and(inArray(ideas.runId, pass.runIds), eq(ideas.origin, 'generated'), eq(runs.isExample, false)))
    .orderBy(desc(ideas.createdAt), desc(ideas.id)).limit(COMPARE_IDEAS_MAX);
  if (rows.length === 0) return none;

  const missing = rows.filter((r) => !r.embedding || r.embedding.length === 0);
  const vectors = await router.embed(
    [...texts, ...missing.map((r) => `${r.title}\n${r.oneLiner}\n${r.problem}`)],
    { runId: null, promptVersion: 'holdout-embed.v1' },
  );
  if (vectors.length !== texts.length + missing.length) throw new Error('holdout: embedding count mismatch');
  let k = texts.length;
  const ideaVecs = rows.map((r) => (r.embedding && r.embedding.length > 0 ? r.embedding : vectors[k++]!));

  const items = texts.map((text, i) => {
    let bestTitle = '';
    let bestSim = -Infinity;
    rows.forEach((r, j) => {
      const sim = cosine(vectors[i]!, ideaVecs[j]!);
      if (Number.isFinite(sim) && sim > bestSim) {
        bestSim = sim;
        bestTitle = r.title;
      }
    });
    return { text, bestIdeaTitle: bestTitle, similarity: Number.isFinite(bestSim) ? bestSim : 0 };
  });
  return { items, median: median(items.map((i) => i.similarity)) };
}

const StoredSchema = z.object({
  items: z.array(z.object({ text: z.string(), bestIdeaTitle: z.string(), similarity: z.number() })),
  median: z.number().nullable(),
  computedAt: z.string(),
});

/** Saves the last comparison for a pass so the Progress page can show it without calling a model. */
export async function holdoutStoreResult(db: Db, passId: string, result: HoldoutResult): Promise<void> {
  await setSetting(db, resultsKey(passId), { ...result, computedAt: new Date().toISOString() } satisfies StoredHoldoutResult);
}

/** The last stored comparison for a pass, or null. */
export async function holdoutStoredResult(db: Db, passId: string): Promise<StoredHoldoutResult | null> {
  if (!UUID_RE.test(passId)) return null;
  const parsed = StoredSchema.safeParse(await getSetting(db, resultsKey(passId)));
  return parsed.success ? parsed.data : null;
}
