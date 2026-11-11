import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { ideationContext, renderIdeationContext } from '../library/context';
import type { Db } from '../db/client';
import { gateVerdicts, ideas, knowledgeItems, markets, signals, sketches } from '../db/schema';
import { loadPrompt } from '../llm/prompts';
import { capField, wrapUntrusted } from '../llm/untrusted';
import { BANNED_DOMAINS } from '../tools/banned-sources';
import { getMinRevenueCeiling } from '../validation/settings';
import {
  ScaleEstimateSchema, UNSOURCED_MAX_BAND, currentScale, scaleShares, userPaysNothing, type PriceHint, type ScaleFields,
} from './business-models';
import { DEMAND_LIBRARY_KINDS, evaluateEvidence } from './evidence';
import { nearestComps, type Comp } from './engine/evolve';
import { COMPS_PER_SKETCH } from './engine/kinds';
import { ideaBlock } from './idea-text';
import type { RunConfig, StageDeps } from './types';

// The evidence helpers moved to ./evidence (shared with ideate); re-exported so existing imports keep working.
export { COMMUNITY_PLATFORMS, countEvidence, countEvidenceForSignals } from './evidence';

/** The model's checks (gate.v7 adds `trivial`); the code verdicts follow in ORDER. */
const CHECKS = ['generic', 'regulation', 'control', 'autonomy', 'reachability', 'trivial'] as const;
const ORDER = [...CHECKS, 'evidence', 'scale', 'comps'] as const;
/** Verdicts that are only shown, never a failed check: they never kill and are never an owner idea's flag. */
const NEVER_KILLS: ReadonlySet<string> = new Set(['comps']);

const judgeSchema = z
  .object({
    verdicts: z.array(
      z.object({
        check: z.enum(CHECKS),
        pass: z.boolean(),
        reasoning: z.string(),
        sourceUrls: z.array(z.string()),
      }),
    ),
  })
  .refine((v) => CHECKS.every((c) => v.verdicts.filter((x) => x.check === c).length === 1), {
    message: `verdicts must contain each of ${CHECKS.join(', ')} exactly once`,
  });

/** The evidence code rule's version, stored on the evidence verdict (v3: complaint route counts pain signals only; demand route). */
export const EVIDENCE_RULE_VERSION = 'evidence-rule.v3';

/**
 * "N independent sources: <breakdown>[; excluded K vendor, M untagged]" (zero counts left out) over the complaint
 * (pain) signals, plus "; demand route: library <kind> <id>, opportunity signal on <domain>" when the idea passes on
 * the demand route.
 */
function evidenceReasoning(e: ReturnType<typeof evaluateEvidence>): string {
  const c = e.complaints;
  const excluded = [
    ...(c.excludedVendor ? [`${c.excludedVendor} vendor`] : []),
    ...(c.excludedUntagged ? [`${c.excludedUntagged} untagged`] : []),
  ];
  const base = `${c.units} independent sources${c.breakdown ? `: ${c.breakdown}` : ''}${excluded.length ? `; excluded ${excluded.join(', ')}` : ''}`;
  if (e.route !== 'demand' || !e.demand) return base;
  const sources = [
    ...e.demand.library.map((l) => `library ${l.kind} ${l.id}`),
    ...[...new Set(e.demand.opportunities.map((o) => o.domain))].map((d) => `opportunity signal on ${d}`),
  ];
  return `${base}; demand route: ${sources.join(', ')}`;
}

/** The scale code rule's version, stored on the scale verdict. */
export const SCALE_RULE_VERSION = 'scale-rule.v1';

const SHARE_WORDS = { shareWithProblem: 'with the problem', shareWillingToPay: 'willing to pay', shareReachable: 'reachable' } as const;
const num = (n: number) => Math.round(n).toLocaleString('en-US');
const usd = (n: number) => `$${num(n)}`;
/** A share in percent: two decimals, or two significant digits for a share under 0.01% (0.004%, never 0%). */
const pct = (n: number) => `${n > 0 && n < 0.01 ? Number(n.toPrecision(2)) : Number(n.toFixed(2))}%`;

/**
 * The gate's scale check (no model): a generated idea fails when its revenue ceiling (paying buyers times the yearly
 * price, from currentScale, the same result the screen scores) is under `line`. It passes, with a note, when the idea
 * has no estimate (older idea) or the price is unknown (a unit like "per claim", a price of 0, or no price): an unknown
 * price never kills. The reasoning shows the arithmetic, the capped shares, whether every step is an assumption, and
 * when the band was limited to 3. For ads and affiliate (the user pays nothing), step 3 reads "become regular users"
 * and the price is our revenue per user. Owner ideas are advisory (the caller never kills them).
 */
export function scaleVerdict(
  idea: ScaleFields & { priceHint: PriceHint | null }, line: number,
): { pass: boolean; reasoning: string } {
  const result = currentScale(idea);
  if (!result) return { pass: true, reasoning: 'no estimate (older idea)' };
  const free = userPaysNothing(idea.businessModel);
  const est = ScaleEstimateSchema.safeParse(idea.scaleEstimate);
  const notes: string[] = [];
  let buyers: string;
  if (est.success) {
    // currentScale recomputed from this estimate, so these are the shares it multiplied.
    const e = est.data;
    const shares = scaleShares(e, idea.businessModel);
    const words: Record<string, string> = { ...SHARE_WORDS, ...(free ? { shareWillingToPay: 'become regular users' } : {}) };
    const steps = (['shareWithProblem', 'shareWillingToPay', 'shareReachable'] as const)
      .map((k) => `${pct(shares[k])} ${words[k]}${shares.capped.includes(k) ? ' (capped)' : ''}`);
    buyers = `${num(e.population.count)} ${e.buyerUnit} × ${steps.join(' × ')} = ${num(result.payingBuyers)} ${free ? 'regular users' : 'paying buyers'}`;
    if (shares.capped.length) notes.push(`Capped because no source was given: ${shares.capped.map((k) => words[k] ?? k).join(', ')}.`);
    if (result.allAssumed) notes.push('Every step is an assumption (no source).');
  } else {
    // A stored result without a readable estimate: judge on its ceiling, without the per-step arithmetic.
    buyers = `${num(result.payingBuyers)} paying buyers`;
  }
  if (result.bandCapped) notes.push(`Scale band limited to ${UNSOURCED_MAX_BAND}: the population has no source.`);
  const tail = notes.length ? ` ${notes.join(' ')}` : '';
  // A price of 0 is unknown (a free product earns another way); an old stored result may still carry 0 with a $0 ceiling.
  if (result.revenueCeiling === null || !result.annualPrice) {
    const p = idea.priceHint;
    const why = !est.success ? 'price unknown'
      : !p ? 'price unknown: no price is given'
      : p.amount === 0 ? 'the price is 0 (a free product earns another way)'
      : `price unknown: the price (${p.amount} ${capField(p.unit, 60)}) cannot be turned into a yearly price`;
    return { pass: true, reasoning: `${buyers}; ${why}, so there is no revenue ceiling (an unknown price never kills).${tail}` };
  }
  const sum = `${buyers}; × ${usd(result.annualPrice)} a year${free ? ' of revenue per user' : ''} = ${usd(result.revenueCeiling)} revenue ceiling`;
  const pass = result.revenueCeiling >= line;
  return { pass, reasoning: `${pass ? `${sum}, at least the ${usd(line)} line.` : `Too small: ${sum}, under the ${usd(line)} line.`}${tail}` };
}

/** The comps code rule's version, stored on the comps verdict. */
export const COMPS_RULE_VERSION = 'comps-rule.v1';
const COMP_NAME_MAX = 120;
const WHY_NOT_TRIVIAL_MAX = 600;
const COMP_PAYS_MAX = 200;

/**
 * The gate's comps verdict (no model, engine v2 spec §9): the idea's nearest library startups (nearestComps: dossier
 * entries first, then by cosine), up to COMPS_PER_SKETCH, each with its outcome and who pays. Advisory: it never kills.
 * It fails (a flag shown on the case and the Board) with "no comps found" when there are none (or the idea has no
 * embedding), and "only dead comps" when every comp is dead.
 */
export function compsVerdict(comps: readonly Comp[]): { pass: boolean; reasoning: string } {
  if (comps.length === 0) return { pass: false, reasoning: 'no comps found: no library startup is near this idea' };
  const lines = comps.slice(0, COMPS_PER_SKETCH).map((c) => {
    const outcome = typeof c.facts.outcome === 'string' && c.facts.outcome.trim() ? capField(c.facts.outcome, 20) : 'unknown';
    const pays = typeof c.facts.whoPays === 'string' && c.facts.whoPays.trim() ? capField(c.facts.whoPays, COMP_PAYS_MAX) : 'unknown';
    return `- ${capField(c.name, COMP_NAME_MAX)} (${outcome}${c.dossier ? ', dossier' : ''}): who pays: ${pays}`;
  });
  const n = lines.length;
  const allDead = comps.slice(0, n).every((c) => c.facts.outcome === 'dead');
  const head = allDead
    ? `only dead comps: all ${n} nearest library startups died`
    : `${n} comp${n === 1 ? '' : 's'} (nearest library startups, dossier entries first):`;
  return { pass: !allDead, reasoning: [head, ...lines].join('\n') };
}

/**
 * The given library entries that can be demand sources (trend, market, rule_change, pricing): one bounded query by id.
 * Ideas store only the library ids their ideate call was shown (ideate drops the rest), so a stored id stands for a
 * shown entry; an id with no entry, or of another kind, is simply absent.
 */
export async function demandLibraryEntries(db: Db, ids: readonly string[]): Promise<{ id: string; kind: string; title: string; summary: string }[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  return db.select({ id: knowledgeItems.id, kind: knowledgeItems.kind, title: knowledgeItems.title, summary: knowledgeItems.summary })
    .from(knowledgeItems)
    .where(and(inArray(knowledgeItems.id, unique), inArray(knowledgeItems.kind, [...DEMAND_LIBRARY_KINDS])));
}

/** demandLibraryEntries as id to kind, for evaluateEvidence. */
export async function demandLibraryKinds(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  return new Map((await demandLibraryEntries(db, ids)).map((r) => [r.id, r.kind]));
}

export async function gate(
  { db, router, log }: StageDeps,
  run: { id: string; config: RunConfig },
  input: { ideaIds: string[] },
): Promise<{ passed: string[]; advisory: { ideaId: string; failedChecks: string[] }[] }> {
  if (input.ideaIds.length === 0) return { passed: [], advisory: [] };

  const rows = await db.select().from(ideas).where(inArray(ideas.id, input.ideaIds));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = input.ideaIds.map((id) => {
    const r = byId.get(id);
    if (!r) throw new Error(`gate: unknown idea ${id}`);
    return r;
  });

  // The run's market countries scope the library startups shown to the generic check (as ideate does).
  const [market] = await db.select().from(markets).where(eq(markets.id, run.config.marketId));
  const countries = market?.countries;
  const competitorsPrompt = loadPrompt('competitors');
  const gatePrompt = loadPrompt('gate');
  const gateModel = router.modelFor('gate');
  const minRevenueCeiling = await getMinRevenueCeiling(db);
  // Engine v2 ideas: the sketch's whyNotTrivial, shown to the judge as the idea's own claim for the trivial check.
  const sketchIdList = [...new Set(ordered.flatMap((i) => (i.sketchId ? [i.sketchId] : [])))];
  const whyNotTrivial = new Map(sketchIdList.length
    ? (await db.select({ id: sketches.id, why: sketches.whyNotTrivial }).from(sketches).where(inArray(sketches.id, sketchIdList))).map((r) => [r.id, r.why] as const)
    : []);

  const passed: string[] = [];
  const advisory: { ideaId: string; failedChecks: string[] }[] = [];
  let killed = 0;

  for (const idea of ordered) {
    const wrappedIdea = wrapUntrusted('idea', ideaBlock(idea));

    const research = await router.research(
      'competitors',
      {
        prompt: competitorsPrompt.render({ idea: wrappedIdea, bannedDomains: BANNED_DOMAINS.join(', ') }),
        maxSearches: run.config.maxSearchesPerCall,
      },
      { runId: run.id, promptVersion: competitorsPrompt.version },
    );

    const sigRows = idea.signalIds.length
      ? await db.select().from(signals).where(inArray(signals.id, idea.signalIds))
      : [];
    // The evidence rule shared with ideate and screen: minSignals operator or neutral complaint (pain) units, or 1 such
    // signal plus a demand source (a stored trend, market, rule_change or pricing entry, or an opportunity signal from
    // another domain). Vendor and untagged signals never count (tuning-4).
    const evidence = evaluateEvidence(idea, await demandLibraryKinds(db, idea.libraryItemIds ?? []), sigRows, run.config.minSignals);
    const evidencePass = evidence.pass;
    const evidenceSources = evidence.route === 'demand' && evidence.demand
      ? [...new Set([...evidence.complaints.countedUrls, ...evidence.demand.signalUrls])]
      : evidence.complaints.countedUrls;

    const sourceUrls = research.sources.map((s) => s.url);
    // Library startups already sold near this idea (needs the idea's embedding): extra evidence for the generic check.
    // Only that section is used, so every other section is 0 (no query).
    const alreadySold = idea.embedding
      ? renderIdeationContext(await ideationContext(db, idea.embedding, { countries, alreadySoldMax: 15, lessonsMax: 0, pricingMax: 0, changingMax: 0, marketsMax: 0 })).alreadySold
      : 'none found';
    const why = idea.sketchId ? whyNotTrivial.get(idea.sketchId) : undefined;
    const judgedIdea = why?.trim()
      ? wrapUntrusted('idea', `${ideaBlock(idea)}
Why not trivial (the idea's own unverified claim): ${capField(why, WHY_NOT_TRIVIAL_MAX)}`)
      : wrappedIdea;
    const judged = await router.structured(
      'gate',
      {
        prompt: gatePrompt.render({
          idea: judgedIdea,
          signals: wrapUntrusted('signals', sigRows.map((s) => `- url: ${capField(s.url, 2000)}\n  quote: ${capField(s.quote, 1000)}`).join('\n')),
          competitors: wrapUntrusted('competitors', research.text),
          competitorUrls: wrapUntrusted('competitor-urls', sourceUrls.join('\n')),
          alreadySold: wrapUntrusted('already-sold', alreadySold),
        }),
        schema: judgeSchema,
        schemaName: 'gate_verdicts',
      },
      { runId: run.id, promptVersion: gatePrompt.version },
    );

    const results = new Map<string, boolean>();
    const values: (typeof gateVerdicts.$inferInsert)[] = judged.verdicts.map((v) => {
      results.set(v.check, v.pass);
      return {
        ideaId: idea.id, check: v.check, pass: v.pass, reasoning: v.reasoning,
        sources: v.sourceUrls, model: gateModel, promptVersion: gatePrompt.version,
      };
    });
    results.set('evidence', evidencePass);
    values.push({
      ideaId: idea.id, check: 'evidence', pass: evidencePass,
      reasoning: evidenceReasoning(evidence),
      sources: evidenceSources, model: 'rule', promptVersion: EVIDENCE_RULE_VERSION,
    });
    // The scale code rule (no model): the revenue ceiling against the line; an unknown price or no estimate passes.
    const scale = scaleVerdict(idea, minRevenueCeiling);
    results.set('scale', scale.pass);
    values.push({
      ideaId: idea.id, check: 'scale', pass: scale.pass, reasoning: scale.reasoning,
      sources: [], model: 'rule', promptVersion: SCALE_RULE_VERSION,
    });
    // The comps code rule (no model, advisory): the nearest library startups, dossier entries first; never kills.
    const comps = compsVerdict(idea.embedding ? await nearestComps(db, idea.embedding, COMPS_PER_SKETCH) : []);
    results.set('comps', comps.pass);
    values.push({
      ideaId: idea.id, check: 'comps', pass: comps.pass, reasoning: comps.reasoning,
      sources: [], model: 'rule', promptVersion: COMPS_RULE_VERSION,
    });
    // A failed check kills a generated idea; owner ideas are advisory for every check (scale and trivial included).
    const failed = ORDER.filter((c) => !NEVER_KILLS.has(c) && !results.get(c));
    const kill = failed.length > 0 && idea.origin !== 'owner';
    // One transaction per idea: replace verdicts and set status together (idempotent on re-run, R20).
    await db.transaction(async (tx) => {
      await tx.delete(gateVerdicts).where(eq(gateVerdicts.ideaId, idea.id));
      await tx.insert(gateVerdicts).values(values);
      await tx.update(ideas).set({ status: kill ? 'gated_out' : 'advanced' }).where(eq(ideas.id, idea.id));
    });
    if (failed.length === 0) {
      passed.push(idea.id);
    } else if (!kill) {
      passed.push(idea.id);
      advisory.push({ ideaId: idea.id, failedChecks: [...failed] });
    } else {
      killed++;
    }
  }

  log(`gate: ${passed.length} passed (${advisory.length} advisory), ${killed} killed`);
  return { passed, advisory };
}
