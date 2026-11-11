import { and, asc, cosineDistance, eq, isNotNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client';
import { ideas, sketches, tournamentMatches } from '../../db/schema';
import { loadPrompt } from '../../llm/prompts';
import type { CallCtx } from '../../llm/types';
import { capField, wrapUntrusted } from '../../llm/untrusted';
import { errorMessage } from '../../tools/scrub';
import { loadAlreadySold } from '../already-sold';
import { BUSINESS_MODELS } from '../business-models';
import { buildSeedContext, renderSignals } from '../seed-context';
import type { RunConfig, StageDeps } from '../types';
import { AVOID_TITLES_MAX, EARN_OR_SAVE, EDGE_KINDS, SKETCH_TEXT_MAX, SKETCHES_PER_LENS } from './kinds';
import { SketchSchema, type Sketch } from './schema';

/** Output limit for one sketch call (a cap, not a cost): a long list of titles plus up to 15 short sketches. */
const SKETCH_MAX_TOKENS = 16000;
/** This run's own titles in the avoid list: bounded, well above the sketches a run makes. */
const OWN_TITLES_MAX = 500;
const TITLE_MAX = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A cited id as written: trimmed, surrounding square brackets removed, lower case. */
const bareId = (s: string) => s.trim().replace(/^\[\s*(.*?)\s*\]$/, '$1').toLowerCase();
const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : null;
/** An enum value trimmed and lower-cased, with spaces and hyphens read as underscores; unknown values unchanged (still fail). */
function enumValue(v: unknown, allowed: readonly string[]): unknown {
  if (typeof v !== 'string') return v;
  const s = v.trim().toLowerCase();
  return [s, s.replace(/[\s-]+/g, '_')].find((c) => allowed.includes(c)) ?? v;
}

/**
 * Before validation, conservative repairs: enum spellings (`"One-off"`, `"AI capability"`, `"Both"`), cited ids
 * unwrapped and lower-cased, malformed library ids dropped on their own and capped at 10. Text is never cut: a
 * sketch over SKETCH_TEXT_MAX drops with a reason.
 */
export function normalizeSketch(raw: unknown): unknown {
  const s = asRecord(raw);
  if (!s) return raw;
  s.businessModel = enumValue(s.businessModel, BUSINESS_MODELS);
  s.edgeKind = enumValue(s.edgeKind, EDGE_KINDS);
  s.earnOrSave = enumValue(s.earnOrSave, EARN_OR_SAVE);
  if (Array.isArray(s.signalIds)) s.signalIds = s.signalIds.map((id) => (typeof id === 'string' ? bareId(id) : id));
  if (Array.isArray(s.libraryItemIds)) {
    s.libraryItemIds = s.libraryItemIds
      .flatMap((id) => (typeof id === 'string' ? [bareId(id)] : []))
      .filter((id) => UUID.test(id))
      .slice(0, 10);
  }
  return s;
}

/** A sketch that failed validation, with why (`path:code`, never content). */
class DroppedSketch {
  constructor(readonly reasons: string[]) {}
}
const reasonKey = (issue: { path: PropertyKey[]; code: string; message: string }) =>
  `${issue.path.map((p) => (typeof p === 'number' ? '*' : String(p))).join('.') || '(sketch)'}:${issue.code === 'custom' ? issue.message : issue.code}`;

/**
 * One sketch call's answer (spec §2, Meincke pattern): the long list of titles, the titles marked as near-duplicates
 * or timid, then the final sketches. One invalid sketch parses to a DroppedSketch (dropped and counted) instead of
 * failing the call; the JSON schema the model sees is the strict sketch schema (the catch is called with no context
 * while that schema is built).
 */
export const SketchListSchema = z.object({
  longList: z.array(z.string()),
  weak: z.array(z.object({ title: z.string(), why: z.string() })),
  sketches: z.array(z.preprocess(normalizeSketch, SketchSchema).catch((ctx) =>
    (ctx ? new DroppedSketch([...new Set(ctx.error.issues.map(reasonKey))]) : undefined) as unknown as Sketch)),
});

/**
 * The avoid list for one sketch call: up to AVOID_TITLES_MAX titles of the nearest earlier ideas and sketches from
 * other runs (by cosine to `queryVector`; none without one), then every title already sketched in this run. Each title
 * is capped and listed once (case and spacing ignored). Bounded queries only.
 */
export async function avoidTitles(db: Db, runId: string, queryVector: number[] | null): Promise<string[]> {
  const near: { title: string; d: number }[] = [];
  if (queryVector) {
    const ideaD = cosineDistance(ideas.embedding, queryVector);
    const ideaRows = await db.select({ title: ideas.title, d: ideaD }).from(ideas)
      .where(and(ne(ideas.runId, runId), isNotNull(ideas.embedding)))
      .orderBy(asc(ideaD), asc(ideas.id)).limit(AVOID_TITLES_MAX);
    const sketchD = cosineDistance(sketches.embedding, queryVector);
    const sketchRows = await db.select({ title: sketches.title, d: sketchD }).from(sketches)
      .where(and(ne(sketches.runId, runId), isNotNull(sketches.embedding)))
      .orderBy(asc(sketchD), asc(sketches.id)).limit(AVOID_TITLES_MAX);
    near.push(...[...ideaRows, ...sketchRows].map((r) => ({ title: r.title, d: Number(r.d) })));
    near.sort((a, b) => a.d - b.d);
  }
  const own = await db.select({ title: sketches.title }).from(sketches).where(eq(sketches.runId, runId))
    .orderBy(asc(sketches.createdAt), asc(sketches.id)).limit(OWN_TITLES_MAX);
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string) => {
    const title = capField(raw, TITLE_MAX);
    const key = title.toLowerCase();
    if (!title || seen.has(key)) return false;
    seen.add(key);
    out.push(title);
    return true;
  };
  let nearCount = 0;
  for (const r of near) {
    if (nearCount >= AVOID_TITLES_MAX) break;
    if (add(r.title)) nearCount++;
  }
  for (const r of own) add(r.title);
  return out;
}

export type SketchOutput = {
  sketchIds: string[];
  signalIds: string[];
  /** Sketches that failed the schema or cited a signal the call was not shown; not stored. */
  dropped: number;
  /** Why sketches were dropped (`path:code`, for example `text:too_long`) to the count. Never content. */
  dropReasons: Record<string, number>;
  /** Sketches the model gave back, before validation and before extras past SKETCHES_PER_LENS.max were cut. */
  returned: number;
  /** Lens calls that failed and were skipped. */
  failedLenses: number;
  /** Model responses cut off at the output limit (the router's re-asks included). */
  truncatedCalls: number;
};

/** `a ×2, b ×1`: the most frequent drop reasons first (ties by name), at most `max`. */
function topReasons(reasons: Record<string, number>, max = 3): string {
  return Object.entries(reasons)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, max)
    .map(([k, n]) => `${k} ×${n}`)
    .join(', ');
}

/**
 * The sketch stage (engine v2, spec §2): per lens, one call that writes a long list of titles, marks the near-duplicate
 * and timid ones and returns SKETCHES_PER_LENS.min to .max bolder sketches. Each lens call sees the run's seed context
 * (as ideate does) plus an avoid list (nearest earlier titles from other runs and every title sketched so far in this
 * run). Sketches are stored per lens as `kept` with no cell (the archive fills it).
 *
 * Idempotent per run (R20): an earlier attempt's sketches (and any matches on them) are removed first. A lens call that
 * fails is skipped with a warning; if every lens call fails, the stage fails (so the run can be resumed) instead of
 * ending as an empty run. The harvest output is passed on (Ruling R1).
 */
export async function sketch(
  { db, router, log }: StageDeps,
  run: { id: string; config: RunConfig },
  input: { signalIds: string[] } & Record<string, unknown>,
): Promise<Record<string, unknown> & SketchOutput> {
  const cfg = run.config;
  let truncatedCalls = 0;
  const ctx = await buildSeedContext({ db, router, log }, run, input.signalIds, 'sketch');
  const signalsText = renderSignals(ctx.passed, { ids: true });
  const shownSignals = new Map(ctx.passed.map((s) => [s.id.toLowerCase(), s.id]));

  const { sold, covered } = await loadAlreadySold(db);
  const asList = (items: string[]) => (items.length ? items.map((s) => `- ${s}`).join('\n') : '(none yet)');
  const gateKilled = wrapUntrusted('gate-killed', asList(sold));
  const alreadyCovered = wrapUntrusted('already-covered', asList(covered));
  const prompt = loadPrompt('sketch');
  const callCtx: CallCtx = { runId: run.id, promptVersion: prompt.version, onTruncated: () => { truncatedCalls++; } };

  await db.transaction(async (tx) => {
    await tx.delete(tournamentMatches).where(eq(tournamentMatches.runId, run.id));
    await tx.delete(sketches).where(eq(sketches.runId, run.id));
  });

  const sketchIds: string[] = [];
  const dropReasons: Record<string, number> = {};
  let dropped = 0;
  let returned = 0;
  let failedLenses = 0;
  let lastError = '';
  const drop = (reasons: string[]) => {
    dropped++;
    for (const r of reasons) dropReasons[r] = (dropReasons[r] ?? 0) + 1;
  };

  for (const lens of ctx.chosen) {
    const library = await ctx.libraryFor(lens);
    let out: z.infer<typeof SketchListSchema>;
    try {
      const avoid = await avoidTitles(db, run.id, library.vector);
      out = await router.structured(
        'sketch',
        {
          prompt: prompt.render({
            market: `${ctx.market.name} (${ctx.market.countries.join(', ')})`,
            lensName: lens.name,
            lensPattern: lens.pattern,
            lensHint: lens.promptHint,
            focus: wrapUntrusted('focus', ctx.focusFor(ctx.withSegmentsSeed)),
            signals: wrapUntrusted('signals', signalsText),
            alreadySold: wrapUntrusted('already-sold', library.alreadySold),
            lessons: wrapUntrusted('lessons', library.lessons),
            pricing: wrapUntrusted('pricing', library.pricing),
            changing: wrapUntrusted('changing', library.changing),
            markets: wrapUntrusted('markets', library.markets),
            seenInTheWild: wrapUntrusted('seen-in-the-wild', library.seenInTheWild),
            gateKilled,
            alreadyCovered,
            avoid: wrapUntrusted('avoid', avoid.length ? avoid.map((t) => `- ${t}`).join('\n') : '(none yet)'),
            longList: String(SKETCHES_PER_LENS.longList),
            minSketches: String(SKETCHES_PER_LENS.min),
            maxSketches: String(SKETCHES_PER_LENS.max),
            textMax: String(SKETCH_TEXT_MAX),
            minSignals: String(cfg.minSignals),
          }),
          schema: SketchListSchema,
          schemaName: 'sketch_list',
          maxTokens: SKETCH_MAX_TOKENS,
        },
        callCtx,
      );
    } catch (err) {
      failedLenses++;
      lastError = errorMessage(err);
      // The message only; a validation error's issues can quote the model's answer.
      log(`sketch: lens ${lens.id} failed (${lastError}), skipped`);
      continue;
    }

    const items = out.sketches as unknown[];
    returned += items.length;
    const rows: (typeof sketches.$inferInsert)[] = [];
    for (const item of items.slice(0, SKETCHES_PER_LENS.max)) {
      if (item instanceof DroppedSketch) { drop(item.reasons); continue; }
      if (!item) continue;
      const s = item as Sketch;
      // Every cited signal must be one this call was shown (the harvest's): an invented id is fabricated evidence.
      const cited = s.signalIds.map((id) => shownSignals.get(id));
      if (cited.some((id) => id === undefined)) { drop(['signalIds:unknown']); continue; }
      rows.push({
        runId: run.id,
        lensId: lens.id,
        title: s.title,
        buyer: s.buyer,
        problem: s.problem,
        howItEarns: s.howItEarns,
        businessModel: s.businessModel,
        edge: s.edge,
        edgeKind: s.edgeKind,
        whyNotTrivial: s.whyNotTrivial,
        earnOrSave: s.earnOrSave,
        signalIds: [...new Set(cited as string[])],
        // Only library entries this lens was shown; invented ids are not stored.
        libraryItemIds: [...new Set(s.libraryItemIds.filter((id) => library.ids.has(id)))],
        status: 'kept',
        cell: null,
      });
    }
    // Stored per lens, so the next lens's avoid list sees this lens's titles.
    if (rows.length) {
      const inserted = await db.insert(sketches).values(rows).returning({ id: sketches.id });
      sketchIds.push(...inserted.map((r) => r.id));
    }
  }

  if (failedLenses === ctx.chosen.length) {
    throw new Error(`sketch: every lens call failed (${failedLenses} of ${ctx.chosen.length}; last: ${lastError})`);
  }
  if (dropped > 0) log(`sketch: dropped ${dropped} invalid (top reasons: ${topReasons(dropReasons)})`);
  log(`sketch: ${sketchIds.length} sketches from ${ctx.chosen.length - failedLenses} of ${ctx.chosen.length} lenses (got ${returned} back, cut off: ${truncatedCalls})`);
  return { ...input, sketchIds, signalIds: input.signalIds, dropped, dropReasons, returned, failedLenses, truncatedCalls };
}
