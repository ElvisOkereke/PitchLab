import { and, cosineDistance, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { AiScoresSchema, CRITERIA, type AiScores } from '../case/schema';
import type { Db } from '../db/client';
import { cases, ideas, signals } from '../db/schema';
import { loadPrompt } from '../llm/prompts';
import { capField, wrapUntrusted } from '../llm/untrusted';
import { valueMultiple, type Barriers } from './business-models';
import { cosine } from './dedupe';
import { evaluateEvidence } from './evidence';
import { demandLibraryEntries } from './gate';
import { hasEdgeLine, hasScaleLine, ideaBlock } from './idea-text';
import type { RunConfig, StageDeps } from './types';

const MAX_WINNER_SIMILARITY = 0.8;
/** At most this many generated ideas per business model reach the gate in one run (a null model is not capped). */
export const MAX_PER_BUSINESS_MODEL = 2;
/** A candidate this close to an idea that already has a case (any run) is a regenerated copy and is skipped. */
export const MAX_CASE_SIMILARITY = 0.82;
/** A candidate this close to an idea (any run) the gate already killed is skipped: it would die the same way. */
export const MAX_KILLED_SIMILARITY = 0.75;

/**
 * Money case band from the value multiple (value to the user per year over price per year): >=10 -> 5, >=5 -> 4,
 * >=3 -> 3, >=1.5 -> 2, else 1. A null multiple (cannot be worked out) is 2. Ads and affiliate ideas, where the user
 * pays nothing, have no multiple and get the neutral band USER_PAYS_NOTHING_BAND instead (see screen).
 */
export function moneyBand(multiple: number | null): number {
  if (multiple === null || !Number.isFinite(multiple)) return 2;
  return multiple >= 10 ? 5 : multiple >= 5 ? 4 : multiple >= 3 ? 3 : multiple >= 1.5 ? 2 : 1;
}

/** Business models where the user pays nothing: the idea's price hint is our revenue per user, not a price. */
const USER_PAYS_NOTHING = new Set(['ads', 'affiliate']);
/** The neutral money case band for those models: no multiple to reward or punish. */
export const USER_PAYS_NOTHING_BAND = 3;
const USER_PAYS_NOTHING_NOTE = 'user pays nothing (ad/affiliate funded)';

/** Barrier score: easy to start (low toStart) and hard to copy (high toCopy) score high. round(((6 - toStart) + toCopy) / 2), 1-5; null is 3. */
export function barrierScore(b: Pick<Barriers, 'toStart' | 'toCopy'> | null | undefined): number {
  if (!b) return 3;
  return Math.min(5, Math.max(1, Math.round((6 - b.toStart + b.toCopy) / 2)));
}

type Score = { value: number; note: string };
/** screen.v4 scores as stored: the model's seven criteria plus the two computed by code. */
export type ScreenScoresV4 = AiScores & { moneyCase: Score; barrier: Score };
/**
 * Screen scores as stored (screen.v5): the v4 scores plus `edge` and `scale`. Each is the model's score when the idea
 * states it (ideaBlock shows its line), else MISSING_EDGE_OR_SCALE, computed by code (the model is not asked).
 */
export type ScreenScores = ScreenScoresV4 & { edge: Score; scale: Score };

/** screen.v5 rank weights: every value weighs 1, except speed (0.5, spec B5) and novelty (2, kept from tuning-4). */
export const SCREEN_WEIGHTS = {
  pain: 1, roi: 1, evidence: 1, speed: 0.5, autonomy: 1, novelty: 2, reach: 1, moneyCase: 1, barrier: 1, edge: 1, scale: 1,
} as const;
/** The edge or scale score of an idea that does not state it (screen.v5, Review Focus 5). */
export const MISSING_EDGE_OR_SCALE = 2;

/**
 * The screen total, a weighted mean. screen.v5 scores (with edge and scale): the sum of SCREEN_WEIGHTS[k] * value over
 * the 11 values, over the sum of the weights (11.5). Older stored shapes keep their old form: screen.v4 (moneyCase and
 * barrier, no edge or scale) is (sum of the 7 + novelty + moneyCase + barrier) / 10, and screen.v3 and earlier is
 * (sum of the 7 + novelty) / 8.
 * (Tuning-4 removed the crowd penalty: it saturated on almost every idea. Old screenScores rows may still hold a
 * `knownCompetitors` list; it is ignored.)
 */
export function weightedScreenTotal(scores: AiScores | ScreenScoresV4 | ScreenScores): number {
  if ('edge' in scores && 'scale' in scores) {
    const keys = Object.keys(SCREEN_WEIGHTS) as (keyof typeof SCREEN_WEIGHTS)[];
    const sum = keys.reduce((s, k) => s + SCREEN_WEIGHTS[k] * scores[k].value, 0);
    return sum / keys.reduce((s, k) => s + SCREEN_WEIGHTS[k], 0);
  }
  const base = CRITERIA.reduce((s, c) => s + scores[c].value, 0) + scores.novelty.value;
  const extra = 'moneyCase' in scores && 'barrier' in scores ? [scores.moneyCase.value, scores.barrier.value] : [];
  return (base + extra.reduce((a, b) => a + b, 0)) / (CRITERIA.length + 1 + extra.length);
}

/**
 * The screen.v5 edge and scale criteria, added to the prompt only when the idea states them. The edge rubric follows
 * ideate.v12's edge rubric; the scale anchors are the idea reviewer's (idea-review.v1).
 */
export const SCREEN_EDGE_CRITERION =
  "- edge: the concrete advantage over today's option, judged from the idea's Edge line, which is its own unverified claim: check it against what you know of the market and the incumbents. " +
  '1: no edge, or the only edge is "uses AI", "better UX" or a vague claim with no named option. 3: a modest, credible improvement over a named option. ' +
  '5: a large advantage over a named option that a buyer could check (a number, or a capability that option lacks), for a reason that holds now, or a new capability. 2 and 4 sit between them.';
export const SCREEN_SCALE_CRITERION =
  "- scale: how many buyers there are and how much money moves, judged from the idea's Scale line and any market entry it cites, which are its own unverified claims (a basis that starts \"Assumption:\" has no source). " +
  '1: a few hundred buyers, or one niche. 3: tens of thousands of buyers, or a mid-size market. 5: millions of buyers, or a very large market. 2 and 4 sit between them.';
const criterionScore = AiScoresSchema.shape.pain;
const SCHEMAS = {
  none: AiScoresSchema,
  edge: AiScoresSchema.extend({ edge: criterionScore }),
  scale: AiScoresSchema.extend({ scale: criterionScore }),
  both: AiScoresSchema.extend({ edge: criterionScore, scale: criterionScore }),
};

type Scored = {
  id: string; title: string; total: number; index: number; embedding: number[] | null;
  businessModel: string | null; audience: string | null;
  /**
   * The gate's evidence rule on the idea's cited signals and stored library ids (evaluateEvidence): whether it passes,
   * and the independent complaint units, for the log.
   */
  evidence: { pass: boolean; units: number };
};
const isConsumer = (s: { audience: string | null }) => s.audience === 'consumer' || s.audience === 'both';

/** The most similar other idea (by embedding) matching `extra`, or null; NaN similarities are ignored. */
async function closest(db: Db, s: Scored & { embedding: number[] }, extra: 'has_case' | 'gated_out'): Promise<{ id: string; sim: number } | null> {
  const similarity = sql<number>`1 - (${cosineDistance(ideas.embedding, s.embedding)})`;
  const base = and(ne(ideas.id, s.id), isNotNull(ideas.embedding), sql`${similarity} <> 'NaN'::float8`);
  const query = db.select({ id: ideas.id, sim: similarity }).from(ideas);
  const [hit] = await (extra === 'has_case'
    ? query.innerJoin(cases, eq(cases.ideaId, ideas.id)).where(base)
    : query.where(and(base, eq(ideas.status, 'gated_out')))
  )
    .orderBy(desc(similarity))
    .limit(1);
  const sim = hit ? Number(hit.sim) : NaN;
  return Number.isFinite(sim) ? { id: hit!.id, sim } : null;
}

/** Why a ranked candidate must not advance, or null when it may. */
async function skipReason(
  db: Db, s: Scored, perModel: Map<string, number>, advancedVecs: number[][], minSignals: number,
): Promise<string | null> {
  // The gate would kill it on evidence alone, so it must not take an entrant slot.
  if (!s.evidence.pass) return `${s.evidence.units} independent sources and no demand source, the gate needs ${minSignals} (or 1 plus a demand source)`;
  if (s.businessModel && (perModel.get(s.businessModel) ?? 0) >= MAX_PER_BUSINESS_MODEL) {
    return `${MAX_PER_BUSINESS_MODEL} ideas with business model ${s.businessModel} already advanced`;
  }
  if (!s.embedding) return null;
  const withVec = { ...s, embedding: s.embedding };
  if (advancedVecs.some((v) => cosine(withVec.embedding, v) > MAX_WINNER_SIMILARITY)) return 'near-twin of an idea already advanced in this run';
  const caseHit = await closest(db, withVec, 'has_case');
  if (caseHit && caseHit.sim >= MAX_CASE_SIMILARITY) {
    return `similarity ${caseHit.sim.toFixed(3)} to idea ${caseHit.id}, which already has a case`;
  }
  const killHit = await closest(db, withVec, 'gated_out');
  if (killHit && killHit.sim >= MAX_KILLED_SIMILARITY) {
    return `similarity ${killHit.sim.toFixed(3)} to idea ${killHit.id}, which the gate already killed`;
  }
  return null;
}

/**
 * The idea block plus the market entries the idea cites (at most 3, title and summary capped) and the money and
 * barrier fields, each capped; lines for absent fields are left out.
 */
function screenIdeaText(idea: typeof ideas.$inferSelect, markets: readonly { title: string; summary: string }[]): string {
  const lines = [ideaBlock(idea)];
  for (const m of markets.slice(0, 3)) lines.push(`Cited market entry: ${capField(m.title, 200)}: ${capField(m.summary, 400)}`);
  if (idea.audience) lines.push(`Audience: ${idea.audience}`);
  if (idea.businessModel) lines.push(`Business model: ${idea.businessModel}`);
  if (idea.revenueMechanics) lines.push(`Revenue mechanics: ${capField(idea.revenueMechanics, 600)}`);
  if (idea.valueToUser) lines.push(`Value to the user: ${idea.valueToUser.amountPerYear} per year (${idea.valueToUser.kind}): ${capField(idea.valueToUser.basis, 400)}`);
  if (idea.priceHint) lines.push(`Price: ${idea.priceHint.amount} per ${capField(idea.priceHint.unit, 60)}: ${capField(idea.priceHint.basis, 300)}`);
  if (idea.barriers) lines.push(`Barrier to start (1 easy, 5 hard): ${idea.barriers.toStart}, ${capField(idea.barriers.toStartWhy, 300)}`, `Barrier to copy (1 easy, 5 hard): ${idea.barriers.toCopy}, ${capField(idea.barriers.toCopyWhy, 300)}`);
  return lines.join('\n');
}

export async function screen(
  { db, router, log }: StageDeps,
  run: { id: string; config: RunConfig },
  input: { ideaIds: string[] },
): Promise<{ ideaIds: string[] }> {
  if (input.ideaIds.length === 0) return { ideaIds: [] };

  const rows = await db.select().from(ideas).where(inArray(ideas.id, input.ideaIds));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = input.ideaIds.map((id) => {
    const r = byId.get(id);
    if (!r) throw new Error(`screen: unknown idea ${id}`);
    return r;
  });

  const owner = ordered.filter((i) => i.origin === 'owner');
  const generated = ordered.filter((i) => i.origin !== 'owner');

  for (const i of owner) await db.update(ideas).set({ status: 'advanced' }).where(eq(ideas.id, i.id));

  // The gate's evidence rule, applied before the gate: one bounded query for every cited signal of the generated ideas,
  // and one for their stored library ids that can be demand sources (the market entries also inform the scale score).
  const citedIds = [...new Set(generated.flatMap((i) => i.signalIds))];
  const sigRows = citedIds.length
    ? await db.select({ id: signals.id, url: signals.url, voice: signals.voice, kind: signals.kind }).from(signals).where(inArray(signals.id, citedIds))
    : [];
  const sigById = new Map(sigRows.map((r) => [r.id, r]));
  const library = await demandLibraryEntries(db, generated.flatMap((i) => i.libraryItemIds ?? []));
  const libraryKinds = new Map(library.map((e) => [e.id, e.kind]));
  const libraryById = new Map(library.map((e) => [e.id, e]));
  const evidenceOf = (idea: typeof ideas.$inferSelect) => {
    const e = evaluateEvidence(idea, libraryKinds, idea.signalIds.flatMap((id) => sigById.get(id) ?? []), run.config.minSignals);
    return { pass: e.pass, units: e.complaints.units };
  };
  const marketsOf = (idea: typeof ideas.$inferSelect) =>
    [...new Set(idea.libraryItemIds ?? [])].flatMap((id) => {
      const e = libraryById.get(id);
      return e?.kind === 'market' ? [e] : [];
    });

  const prompt = loadPrompt('screen');
  const scored: Scored[] = [];
  let noMultiple = 0;
  let paysNothing = 0;
  for (const [index, idea] of generated.entries()) {
    // Ads and affiliate: the user pays nothing, so there is no multiple (the price hint is our revenue per user).
    const free = !!idea.businessModel && USER_PAYS_NOTHING.has(idea.businessModel);
    const multiple = !free && idea.valueToUser && idea.priceHint ? valueMultiple(idea.valueToUser, idea.priceHint) : null;
    if (free) paysNothing++;
    else if (multiple === null) noMultiple++;
    const money = free ? USER_PAYS_NOTHING_BAND : moneyBand(multiple);
    const barrier = barrierScore(idea.barriers);
    const moneyNote = free ? `no value multiple: ${USER_PAYS_NOTHING_NOTE}`
      : multiple === null ? 'no value multiple (value or price missing or not annual)' : `value multiple ${multiple.toFixed(1)}x`;
    const barrierNote = idea.barriers ? `toStart ${idea.barriers.toStart}, toCopy ${idea.barriers.toCopy}` : 'no barrier ratings';
    const moneyFrom = free ? `no value multiple, because the ${USER_PAYS_NOTHING_NOTE}; neutral band`
      : multiple === null ? 'a value multiple that cannot be worked out' : `the value multiple ${multiple.toFixed(1)}x`;
    // Edge and scale: asked of the model only when the idea states them (ideaBlock shows the line), else computed.
    const askEdge = hasEdgeLine(idea.edge);
    const askScale = hasScaleLine(idea.scale);
    const computed = [
      `Money case (computed from ${moneyFrom}): ${money} of 5`,
      `Barrier (computed from ${barrierNote}; easy to start and hard to copy score high): ${barrier} of 5`,
      ...(askEdge ? [] : [`Edge (computed: the idea states no edge): ${MISSING_EDGE_OR_SCALE} of 5`]),
      ...(askScale ? [] : [`Scale (computed: the idea states no scale): ${MISSING_EDGE_OR_SCALE} of 5`]),
    ].join('\n');
    const edgeScale = [...(askEdge ? [SCREEN_EDGE_CRITERION] : []), ...(askScale ? [SCREEN_SCALE_CRITERION] : [])].join('\n');
    const criteriaList = [...CRITERIA, ...(askEdge ? ['edge'] : []), ...(askScale ? ['scale'] : [])].join(', ');
    const schema = askEdge && askScale ? SCHEMAS.both : askEdge ? SCHEMAS.edge : askScale ? SCHEMAS.scale : SCHEMAS.none;
    // The model scores the seven criteria, plus edge and scale when asked; the computed scores are added here and
    // cannot be overridden (an edge or scale the model was not asked for is stripped by the schema and replaced).
    const modelScores: AiScores & { edge?: Score; scale?: Score } = await router.structured(
      'screen',
      {
        prompt: prompt.render({ idea: wrapUntrusted('idea', screenIdeaText(idea, marketsOf(idea))), computed, edgeScale, criteriaList }),
        schema, schemaName: 'screen_scores',
      },
      { runId: run.id, promptVersion: prompt.version },
    );
    const missing = (what: string): Score => ({ value: MISSING_EDGE_OR_SCALE, note: `no ${what} stated (computed)` });
    const scores: ScreenScores = {
      ...modelScores,
      moneyCase: { value: money, note: moneyNote }, barrier: { value: barrier, note: barrierNote },
      edge: askEdge && modelScores.edge ? modelScores.edge : missing('edge'),
      scale: askScale && modelScores.scale ? modelScores.scale : missing('scale'),
    };
    const total = weightedScreenTotal(scores);
    log(`screen: "${capField(idea.title, 120)}" total ${total.toFixed(2)}`);
    await db.update(ideas).set({ screenScores: scores, screenTotal: total }).where(eq(ideas.id, idea.id));
    scored.push({
      id: idea.id, title: idea.title, total, index, embedding: idea.embedding, businessModel: idea.businessModel, audience: idea.audience,
      evidence: evidenceOf(idea),
    });
  }
  if (generated.length) {
    log(`screen: ${noMultiple} of ${generated.length} ideas had no value multiple (moneyCase set to 2)`);
    if (paysNothing) log(`screen: ${paysNothing} of ${generated.length} ideas are ads or affiliate, where the user pays nothing (moneyCase set to ${USER_PAYS_NOTHING_BAND})`);
    const thin = scored.filter((s) => !s.evidence.pass).length;
    log(`screen: ${thin} of ${generated.length} candidates have too little evidence for the gate (fewer than ${run.config.minSignals} independent sources and no demand source) and cannot advance`);
  }

  // Top advanceCount by score, in rank order, skipping (-> screened_out) a candidate when
  //   (0) it fails the gate's evidence rule (evaluateEvidence: fewer than minSignals operator/neutral complaint sources
  //       on distinct registrable domains, and no demand source alongside at least 1 such signal), or
  //   (a) MAX_PER_BUSINESS_MODEL generated ideas with its business model already advanced (a null model is never capped),
  //   (b) it is a near-twin (cosine > 0.8, embeddings from dedupe) of an idea already advanced in this run, or
  //   (c) it is close (cosine >= 0.82) to an idea from any run that already has a case (a regenerated copy), or
  //   (d) it is close (cosine >= 0.75) to an idea from any run (this one included) that the gate already killed.
  // An idea without an embedding is never skipped for similarity. Owner ideas are never skipped and use no slot.
  scored.sort((a, b) => b.total - a.total || a.index - b.index);
  const ownerVecs = owner.flatMap((i) => (i.embedding ? [i.embedding] : []));
  const tally = (list: Scored[]) => {
    const m = new Map<string, number>();
    for (const w of list) if (w.businessModel) m.set(w.businessModel, (m.get(w.businessModel) ?? 0) + 1);
    return m;
  };
  const vecsOf = (list: Scored[]) => [...ownerVecs, ...list.flatMap((w) => (w.embedding ? [w.embedding] : []))];
  let winners: typeof scored = [];
  const losers: typeof scored = [];
  for (const s of scored) {
    if (winners.length >= run.config.advanceCount) {
      losers.push(s);
      continue;
    }
    const skip = await skipReason(db, s, tally(winners), vecsOf(winners), run.config.minSignals);
    if (skip) {
      log(`screen: skipped "${capField(s.title, 120)}": ${skip}`);
      losers.push(s);
      continue;
    }
    winners.push(s);
  }

  // Keep at least one consumer or both entrant when any such candidate passes the checks above: the best one takes
  // the place of the lowest-ranked business entrant.
  if (winners.length && !winners.some(isConsumer)) {
    const victim = [...winners].reverse().find((w) => !isConsumer(w));
    if (victim) {
      const rest = winners.filter((w) => w !== victim);
      for (const c of losers.filter(isConsumer)) {
        if (await skipReason(db, c, tally(rest), vecsOf(rest), run.config.minSignals)) continue;
        log(`screen: "${capField(c.title, 120)}" replaces "${capField(victim.title, 120)}" to keep a consumer entrant`);
        winners = [...rest, c].sort((a, b) => b.total - a.total || a.index - b.index);
        losers.splice(losers.indexOf(c), 1, victim);
        break;
      }
    }
  }
  if (winners.length) await db.update(ideas).set({ status: 'advanced' }).where(inArray(ideas.id, winners.map((w) => w.id)));
  if (losers.length) await db.update(ideas).set({ status: 'screened_out' }).where(inArray(ideas.id, losers.map((w) => w.id)));

  const advanced = [...owner.map((i) => i.id), ...winners.map((w) => w.id)];
  log(`screen: ${advanced.length} advanced, ${losers.length} screened out`);
  return { ideaIds: advanced };
}
