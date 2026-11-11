import { and, asc, cosineDistance, desc, eq, inArray, isNotNull, like, or, sql, sum } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client';
import { knowledgeItems, lenses, llmCalls, signals, sketches, tournamentMatches } from '../../db/schema';
import { DOSSIERS_PRIORITY_KEY } from '../../library/dossier-job';
import { loadPrompt } from '../../llm/prompts';
import type { CallCtx } from '../../llm/types';
import { capField, wrapUntrusted } from '../../llm/untrusted';
import { errorMessage } from '../../tools/scrub';
import { getSetting, setSetting } from '../../validation/settings';
import { enumValue } from '../normalize';
import type { RunConfig, StageDeps } from '../types';
import { buyerKind, cellOf } from './archive';
import { topByElo } from './elo';
import {
  COMPS_PER_SKETCH, ELO_START, ENGINE_USD_MAX, EVOLVE_TOP, FINAL_CALLS_MAX, FINAL_ROUNDS, SKETCH_OPERATORS, SKETCH_TEXT_MAX,
  TOP_SKETCHES,
} from './kinds';
import { SketchSchema } from './schema';
import { normalizeSketch } from './sketch';
import { runTournament } from './tournament';

/** Pricing entries shown per comp, and fetched per call. */
const PRICING_PER_COMP = 3;
const PRICING_ROWS_MAX = 50;
/** `dossiers.priority` keeps at most this many startup ids (the newest). */
export const DOSSIER_PRIORITY_MAX = 50;
const EVOLVE_MAX_TOKENS = 4000;
/** Further harvest signals (not cited by the parent) shown per call, which a variant may add (Ruling R9). */
const MORE_SIGNALS_MAX = 10;
/** The run-scoped setting listing the parents whose evolve call was made (answered, failed or discarded): never asked again. */
export const evolveAttemptedKey = (runId: string) => `evolve.attempted.${runId}`;
const FIELD_MAX = 240;
const QUOTE_MAX = 300;
const EMBED_VERSION = 'embed';

type Facts = Record<string, unknown>;
export type Comp = {
  id: string;
  name: string;
  facts: Facts;
  /** The startup has a finished dossier (facts.dossierStatus 'done'). */
  dossier: boolean;
  /** Pricing entries whose product is this company's (same name, or the name followed by a plan name). */
  pricing: { id: string; title: string; facts: Facts }[];
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const factsOf = (v: unknown): Facts => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Facts) : {});
const lowerName = (s: string) => s.trim().toLowerCase();

/**
 * The `n` comps nearest to `vec` (spec §6, Ruling R8): the nearest active startup entries with a finished dossier
 * (facts.dossierStatus 'done') first, then the nearest other active startups to fill up to `n`, each in cosine order.
 * Each comp gets the pricing entries of its products (matched by product name, case-insensitive: the name itself or
 * the name and a plan name), newest first. Three bounded queries.
 */
export async function nearestComps(db: Db, vec: number[], n = COMPS_PER_SKETCH): Promise<Comp[]> {
  if (n <= 0) return [];
  const d = cosineDistance(knowledgeItems.embedding, vec);
  const nearest = (dossierOnly: boolean) => db.select({ id: knowledgeItems.id, title: knowledgeItems.title, facts: knowledgeItems.facts }).from(knowledgeItems)
    .where(and(
      eq(knowledgeItems.kind, 'startup'), eq(knowledgeItems.status, 'active'), isNotNull(knowledgeItems.embedding),
      sql`${d} <> 'NaN'::float8`,
      dossierOnly ? sql`${knowledgeItems.facts}->>'dossierStatus' = 'done'` : undefined,
    ))
    .orderBy(asc(d), asc(knowledgeItems.id)).limit(n);
  const [withDossier, any] = [await nearest(true), await nearest(false)];
  const seen = new Set<string>();
  const comps: Comp[] = [];
  for (const r of [...withDossier, ...any]) {
    if (comps.length >= n || seen.has(r.id)) continue;
    seen.add(r.id);
    const facts = factsOf(r.facts);
    comps.push({ id: r.id, name: str(facts.name).trim() || r.title, facts, dossier: facts.dossierStatus === 'done', pricing: [] });
  }

  const names = [...new Set(comps.map((c) => lowerName(c.name)).filter(Boolean))];
  if (names.length === 0) return comps;
  const product = sql`lower(trim(${knowledgeItems.facts}->>'product'))`;
  const rows = await db.select({ id: knowledgeItems.id, title: knowledgeItems.title, facts: knowledgeItems.facts }).from(knowledgeItems)
    .where(and(
      eq(knowledgeItems.kind, 'pricing'), eq(knowledgeItems.status, 'active'),
      or(...names.map((name) => sql`(${product} = ${name} or starts_with(${product}, ${`${name} `}))`)),
    ))
    // Newest first (Ruling R10): current prices.
    .orderBy(desc(knowledgeItems.createdAt), asc(knowledgeItems.id)).limit(PRICING_ROWS_MAX);
  // The longest matching name wins ("Rent Pro" pricing goes to "Rent Pro", not "Rent").
  const byLength = [...comps].sort((a, b) => lowerName(b.name).length - lowerName(a.name).length);
  for (const r of rows) {
    const facts = factsOf(r.facts);
    const p = lowerName(str(facts.product));
    const owner = byLength.find((c) => p === lowerName(c.name) || p.startsWith(`${lowerName(c.name)} `));
    if (owner && owner.pricing.length < PRICING_PER_COMP) owner.pricing.push({ id: r.id, title: r.title, facts });
  }
  return comps;
}

function renderComps(comps: Comp[]): string {
  if (comps.length === 0) return '(none found)';
  const line = (label: string, v: unknown) => (str(v).trim() ? ` ${label}: ${capField(str(v), FIELD_MAX)}.` : '');
  return comps.map((c) => {
    const f = c.facts;
    const head = `- [${c.id}] ${capField(c.name, 120)} (${str(f.outcome) || 'unknown'}${c.dossier ? ', dossier' : ''}):`
      + `${line('What it does', f.whatItDoes)}${line('Business model', f.businessModel)}${line('Who pays', f.whoPays)}`
      + `${line('Price', [str(f.priceRange), str(f.pricingUnit)].filter(Boolean).join(' '))}${line('Moat', f.moat)}`
      + `${line('Why it worked', f.whyItWorked)}${line('Why it died', f.whyItDied)}${line('Why', f.why)}`;
    const pricing = c.pricing.map((p) => {
      const points = Array.isArray(p.facts.pricePoints)
        ? (p.facts.pricePoints as { amount?: unknown; currency?: unknown; unit?: unknown }[]).slice(0, 5)
          .map((x) => `${String(x.amount ?? '')} ${str(x.currency)}/${str(x.unit)}`).join(', ')
        : '';
      const complaints = Array.isArray(p.facts.complaints) ? (p.facts.complaints as unknown[]).map(str).filter(Boolean).slice(0, 3).join('; ') : '';
      return `  - pricing [${p.id}] ${capField(str(p.facts.product) || p.title, 120)}: ${capField(points, FIELD_MAX)}${complaints ? `; complaints: ${capField(complaints, FIELD_MAX)}` : ''}`;
    });
    return [head, ...pricing].join('\n');
  }).join('\n');
}

type ParentRow = typeof sketches.$inferSelect;

function renderSketch(s: ParentRow): string {
  return [
    `Title: ${capField(s.title, FIELD_MAX)}`,
    `Buyer: ${capField(s.buyer, FIELD_MAX)}`,
    `Problem: ${capField(s.problem, FIELD_MAX)}`,
    `How it earns: ${capField(s.howItEarns, FIELD_MAX)}`,
    `Business model: ${s.businessModel}`,
    `Edge: ${capField(s.edge, FIELD_MAX)}`,
    `Edge kind: ${s.edgeKind}`,
    `Why not trivial: ${capField(s.whyNotTrivial, FIELD_MAX)}`,
    `Earn or save: ${s.earnOrSave}`,
    `Signal ids: ${s.signalIds.join(', ')}`,
    `Library ids: ${s.libraryItemIds.length ? s.libraryItemIds.join(', ') : '(none)'}`,
  ].join('\n');
}

/** The model's answer: one variant and the operator that made it. Enum spellings and cited ids are repaired as for sketches. */
export const EvolveSchema = z.object({
  operator: z.preprocess((v) => enumValue(v, SKETCH_OPERATORS), z.enum(SKETCH_OPERATORS)),
  sketch: z.preprocess(normalizeSketch, SketchSchema),
});

/** Model spend of the run's engine stages so far (llm_calls with a sketch.*, judge.* or evolve.* prompt version). */
export async function engineSpend(db: Db, runId: string): Promise<number> {
  const [r] = await db.select({ total: sum(llmCalls.costUsd) }).from(llmCalls).where(and(
    eq(llmCalls.runId, runId),
    or(like(llmCalls.promptVersion, 'sketch.%'), like(llmCalls.promptVersion, 'judge.%'), like(llmCalls.promptVersion, 'evolve.%')),
  ));
  return Number(r?.total ?? 0);
}

/** Appends startup ids to `dossiers.priority`: each listed once, at its newest place, keeping the newest DOSSIER_PRIORITY_MAX. */
async function queueDossiers(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const current = await getSetting(db, DOSSIERS_PRIORITY_KEY);
  const fresh = new Set(ids);
  const kept = Array.isArray(current) ? current.filter((x): x is string => typeof x === 'string' && !fresh.has(x)) : [];
  const merged = [...new Set([...kept, ...ids])];
  await setSetting(db, DOSSIERS_PRIORITY_KEY, merged.slice(-DOSSIER_PRIORITY_MAX));
}

export type EvolveOutput = {
  /** The final top TOP_SKETCHES by Elo (parents and variants) under the cell and business model caps. */
  sketchIds: string[];
  signalIds: string[];
  /** Variants that played the final tournament. */
  variants: number;
};

/**
 * The evolve stage (engine v2, spec §6). For each of the top EVOLVE_TOP sketches (all of them when fewer), one call
 * (stage `ideate`, evolve.v1) writes one variant against its nearest comps (sharpen, combine with another top sketch,
 * or simplify). A variant must keep every parent signal and cite only harvest signals, else it is discarded; a failed
 * call keeps the parent alone. Variants are stored `kept` with `parentSketchId` and `operator` (Ruling R6), embedded and
 * filed under their cell. The comps' startup ids are queued for dossiers. Then the parents and variants play a `final`
 * phase (FINAL_ROUNDS, FINAL_CALLS_MAX) and the top by Elo go on.
 *
 * Idempotent (Ruling R7): the final phase starts from the main tournament's ratings in the input (variants at their
 * parent's), never from stored elo, so a re-run replays the stored final matches to the same ratings without paying
 * again. Each parent is asked at most once per run (setting `evolve.attempted.<runId>`): a stored variant is reused,
 * a failed or discarded one is not asked again, and once a final match exists no call is made. Over the engine budget
 * (ENGINE_USD_MAX) on its first attempt, the stage passes the main top on unchanged. The input is passed on (R1).
 */
export async function evolve(
  { db, router, log }: StageDeps,
  run: { id: string; config: RunConfig },
  input: { sketchIds: string[] } & Record<string, unknown>,
): Promise<Record<string, unknown> & EvolveOutput> {
  const signalIds = Array.isArray(input.signalIds) ? (input.signalIds as string[]) : [];
  const ids = Array.isArray(input.sketchIds) ? [...new Set(input.sketchIds)] : [];
  if (ids.length === 0) return { ...input, sketchIds: [], signalIds, variants: 0 };

  const rows = await db.select().from(sketches).where(inArray(sketches.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const parents = ids.map((id) => {
    const r = byId.get(id);
    if (!r) throw new Error(`evolve: unknown sketch ${id}`);
    return r;
  });
  const top = parents.slice(0, EVOLVE_TOP);
  const topIds = top.map((p) => p.id);

  const stored = await db.select().from(sketches)
    .where(and(eq(sketches.runId, run.id), isNotNull(sketches.parentSketchId)))
    .orderBy(asc(sketches.createdAt), asc(sketches.id));
  const variantOf = new Map<string, ParentRow>();
  for (const v of stored) if (topIds.includes(v.parentSketchId!) && !variantOf.has(v.parentSketchId!)) variantOf.set(v.parentSketchId!, v);
  const stale = stored.filter((v) => variantOf.get(v.parentSketchId!)?.id !== v.id).map((v) => v.id);

  const attemptedRaw = await getSetting(db, evolveAttemptedKey(run.id));
  const attempted = new Set(Array.isArray(attemptedRaw) ? attemptedRaw.filter((x): x is string => typeof x === 'string') : []);
  const markAttempted = async (id: string) => {
    attempted.add(id);
    await setSetting(db, evolveAttemptedKey(run.id), [...attempted]);
  };

  // The budget is decided on the first attempt: once a call, a variant or a final match exists, a re-run finishes the stage.
  const [finalMatch] = await db.select({ id: tournamentMatches.id }).from(tournamentMatches)
    .where(and(eq(tournamentMatches.runId, run.id), eq(tournamentMatches.phase, 'final'))).limit(1);
  const spentBefore = await engineSpend(db, run.id);
  if (stored.length === 0 && attempted.size === 0 && !finalMatch && spentBefore >= ENGINE_USD_MAX) {
    log(`evolve: engine budget reached ($${spentBefore.toFixed(2)} of $${ENGINE_USD_MAX}); no variants, the main top ${ids.length} go on`);
    return { ...input, sketchIds: ids, signalIds, variants: 0 };
  }

  const comps = new Map<string, Comp[]>();
  for (const p of top) {
    if (!Array.isArray(p.embedding) || p.embedding.length === 0) {
      log(`evolve: sketch ${p.id} has no embedding; no comps`);
      comps.set(p.id, []);
      continue;
    }
    comps.set(p.id, await nearestComps(db, p.embedding));
  }
  await queueDossiers(db, [...new Set(top.flatMap((p) => comps.get(p.id)!.map((c) => c.id)))]);

  const harvest = new Map([...signalIds, ...parents.flatMap((p) => p.signalIds)].map((id) => [id.toLowerCase(), id]));
  // Ruling R7: a parent is asked once per run. Once the final has started its set is fixed: only stored variants play.
  const missing = finalMatch ? [] : top.filter((p) => !variantOf.has(p.id) && !attempted.has(p.id));
  if (missing.length) {
    const moreFor = new Map(missing.map((p) => [p.id, signalIds.filter((id) => !p.signalIds.includes(id)).slice(0, MORE_SIGNALS_MAX)]));
    const sigIds = [...new Set(missing.flatMap((p) => [...p.signalIds, ...moreFor.get(p.id)!]))];
    const sigRows = sigIds.length
      ? await db.select({ id: signals.id, voice: signals.voice, kind: signals.kind, quote: signals.quote }).from(signals).where(inArray(signals.id, sigIds))
      : [];
    const sigById = new Map(sigRows.map((s) => [s.id, s]));
    const lensIds = [...new Set(missing.map((p) => p.lensId).filter((x): x is string => !!x))];
    const audience = new Map(lensIds.length
      ? (await db.select({ id: lenses.id, audience: lenses.audience }).from(lenses).where(inArray(lenses.id, lensIds))).map((l) => [l.id, l.audience] as const)
      : []);
    const prompt = loadPrompt('evolve');
    const ctx: CallCtx = { runId: run.id, promptVersion: prompt.version };

    const renderSignal = (id: string) => {
      const s = sigById.get(id);
      return s ? [`- id: ${s.id}\n  voice: ${s.voice ?? 'untagged'}\n  kind: ${s.kind === 'opportunity' ? 'opportunity' : 'pain'}\n  quote: ${capField(s.quote, QUOTE_MAX)}`] : [];
    };

    /** One parent's call; returns normally when the call was answered (variant stored or discarded) or failed. */
    const attempt = async (p: ParentRow): Promise<void> => {
      const cs = comps.get(p.id)!;
      const others = parents.filter((o) => o.id !== p.id);
      const shownSignals = p.signalIds.flatMap(renderSignal);
      const moreSignals = moreFor.get(p.id)!.flatMap(renderSignal);
      let answer: z.infer<typeof EvolveSchema>;
      try {
        answer = await router.structured('ideate', {
          prompt: prompt.render({
            sketch: wrapUntrusted('sketch', renderSketch(p)),
            signals: wrapUntrusted('signals', shownSignals.length ? shownSignals.join('\n') : '(none)'),
            moreSignals: wrapUntrusted('harvest-signals', moreSignals.length ? moreSignals.join('\n') : '(none)'),
            comps: wrapUntrusted('comps', renderComps(cs)),
            otherSketches: wrapUntrusted('other-sketches', others.length
              ? others.map((o) => `- ${capField(o.title, FIELD_MAX)} (buyer: ${capField(o.buyer, 120)}; signal ids: ${o.signalIds.join(', ')})`).join('\n')
              : '(none)'),
            textMax: String(SKETCH_TEXT_MAX),
          }),
          schema: EvolveSchema,
          schemaName: 'evolve_variant',
          maxTokens: EVOLVE_MAX_TOKENS,
        }, ctx);
      } catch (err) {
        // The message only; a validation error's issues can quote the model's answer.
        log(`evolve: call for sketch ${p.id} failed (${errorMessage(err)}); the parent plays alone`);
        return;
      }

      const v = answer.sketch;
      const cited = v.signalIds.map((id) => harvest.get(id.toLowerCase()));
      const citedSet = new Set(cited);
      if (cited.some((id) => id === undefined)) {
        log(`evolve: variant of sketch ${p.id} discarded (cites a signal outside the harvest)`);
        return;
      }
      if (!p.signalIds.every((id) => citedSet.has(id))) {
        log(`evolve: variant of sketch ${p.id} discarded (drops a parent signal)`);
        return;
      }
      const allowedLibrary = new Set([
        ...parents.flatMap((o) => o.libraryItemIds),
        ...cs.flatMap((c) => [c.id, ...c.pricing.map((x) => x.id)]),
      ]);
      const [inserted] = await db.insert(sketches).values({
        runId: run.id,
        lensId: p.lensId,
        title: v.title,
        buyer: v.buyer,
        problem: v.problem,
        howItEarns: v.howItEarns,
        businessModel: v.businessModel,
        edge: v.edge,
        edgeKind: v.edgeKind,
        whyNotTrivial: v.whyNotTrivial,
        earnOrSave: v.earnOrSave,
        signalIds: [...new Set(cited as string[])],
        libraryItemIds: [...new Set(v.libraryItemIds.filter((id) => allowedLibrary.has(id)))],
        status: 'kept',
        cell: cellOf({ buyerKind: buyerKind(v.buyer, (p.lensId && audience.get(p.lensId)) || 'business'), edgeKind: v.edgeKind, businessModel: v.businessModel }),
        parentSketchId: p.id,
        operator: answer.operator,
      }).returning();
      variantOf.set(p.id, inserted!);
    };

    for (const p of missing) {
      await attempt(p);
      // After the variant is stored: a crash in between leaves a stored variant, which a re-run reuses.
      await markAttempted(p.id);
    }
  }

  // Embedded after storing, so a failed embed call never re-pays the evolve calls on a re-run.
  const unembedded = top.flatMap((p) => {
    const v = variantOf.get(p.id);
    return v && !(Array.isArray(v.embedding) && v.embedding.length > 0) ? [v] : [];
  });
  if (unembedded.length) {
    const vectors = await router.embed(unembedded.map((v) => `${v.title}\n${v.buyer}\n${v.problem}\n${v.howItEarns}`), { runId: run.id, promptVersion: EMBED_VERSION });
    if (vectors.length !== unembedded.length) throw new Error('evolve: embedding count mismatch');
    for (let i = 0; i < unembedded.length; i++) await db.update(sketches).set({ embedding: vectors[i]! }).where(eq(sketches.id, unembedded[i]!.id));
  }

  // Ruling R7: parents start from the main tournament's ratings (input), variants from their parent's; never stored elo.
  const ratings = input.ratings && typeof input.ratings === 'object' ? (input.ratings as Record<string, unknown>) : {};
  const startOf = (id: string) => (typeof ratings[id] === 'number' && Number.isFinite(ratings[id]) ? (ratings[id] as number) : ELO_START);
  if (ids.some((id) => typeof ratings[id] !== 'number')) log('evolve: some sketches have no main tournament rating; they start at the default');
  const variants = top.flatMap((p) => (variantOf.has(p.id) ? [variantOf.get(p.id)!] : []));
  const start = new Map<string, number>([
    ...ids.map((id) => [id, startOf(id)] as const),
    ...variants.map((v) => [v.id, startOf(v.parentSketchId!)] as const),
  ]);
  const finalIds = [...ids, ...variants.map((v) => v.id)];
  const final = await runTournament({ db, router, log }, run, { phase: 'final', sketchIds: finalIds, rounds: FINAL_ROUNDS, maxCalls: FINAL_CALLS_MAX, start });

  // Variants of parents no longer in the top (a changed upstream re-run): their final matches were just dropped.
  if (stale.length) {
    await db.transaction(async (tx) => {
      await tx.delete(tournamentMatches).where(and(eq(tournamentMatches.runId, run.id), or(inArray(tournamentMatches.aId, stale), inArray(tournamentMatches.bId, stale))));
      await tx.delete(sketches).where(inArray(sketches.id, stale));
    });
    log(`evolve: removed ${stale.length} variants of sketches no longer in the top ${EVOLVE_TOP}`);
  }

  const all = [...parents, ...variants];
  const ranked = topByElo(all.map((r) => ({ id: r.id, elo: final.get(r.id) ?? start.get(r.id)!, cell: r.cell, businessModel: r.businessModel, createdAt: r.createdAt })), TOP_SKETCHES);
  const spent = await engineSpend(db, run.id);
  log(`evolve: ${variants.length} variants of ${top.length} top sketches; final ${ranked.length} go on; engine spend $${spent.toFixed(2)} of $${ENGINE_USD_MAX}`);
  if (spent > ENGINE_USD_MAX) log(`evolve: warning: engine spend $${spent.toFixed(2)} is over the $${ENGINE_USD_MAX} run budget`);
  return { ...input, sketchIds: ranked, signalIds, variants: variants.length };
}
