// Pass audit: where a benchmark pass's evidence, ideas and gate kills came from, with plain-language flags for lopsided
// results. Web-safe (drizzle, db/schema and bench constants only). Read-only; no model calls.
import { and, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { benchmarkPasses, cases, gateVerdicts, ideaReviews, ideas, knowledgeItems, runStages, runs, signals } from '../db/schema';
import { IDEA_REVIEW_VERSION } from '../bench/definitions';
import { ADVISORY_GATE_CHECKS } from '../pipeline/gate-checks';

/** A flag is raised when a share (in percent) is strictly above its limit. */
export const FLAG_LIMITS = { topDomain: 15, vendorVoice: 40, lens: 35, gateCheck: 50, niche: 30 } as const;
/** A flag is skipped when its sample is below this size: a share of a handful of items says little. */
export const FLAG_MIN_SAMPLE = { signals: 10, ideas: 5, kills: 5, reviews: 5 } as const;
/** Most signals read for one pass (a benchmark pass collects a few hundred). */
export const AUDIT_SIGNALS_MAX = 50_000;
const TOP_DOMAINS = 5;
const NICHE_MIN = 4;
const SMALL_SCALE_MAX = 2;

/** Gate checks whose kills are intended filtering, not a lopsided gate (see the scorecard's wasted entrants). */
const INTENDED_KILL_CHECKS = new Set(['scale']);
const GATE_CHECK_LABELS: Record<string, string> = { scale: 'revenue ceiling' };
/** A gate check's name as the owner reads it ("revenue ceiling" for scale; the others read as they are). */
export const gateCheckLabel = (check: string) => GATE_CHECK_LABELS[check] ?? check;

export type PassAudit = {
  signals: { total: number; byVoice: Record<string, number>; bySource: Record<string, number>; topDomains: { domain: string; share: number }[] };
  lenses: { lensId: string; ideas: number; screenedIn: number; advanced: number; cases: number }[];
  gateKills: Record<string, number>;
  dropReasons: Record<string, number>;
  demandShare: number | null;
  /** Share of reviewed ideas (current reviewer prompt) that read as niche or small; null with no reviews. */
  nicheShare: number | null;
  flags: string[];
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A page's site: hostname without "www.", keeping three labels for two-part public suffixes such as co.uk. */
export function domainOf(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
  if (!host) return 'unknown';
  const parts = host.split('.');
  if (parts.length <= 2 || /^\d+(\.\d+){3}$/.test(host)) return host;
  const sld = parts.at(-2)!;
  const tld = parts.at(-1)!;
  return tld.length === 2 && sld.length <= 3 ? parts.slice(-3).join('.') : parts.slice(-2).join('.');
}

const pctText = (k: number, n: number) => {
  const p = (k * 100) / n;
  return `${Number.isInteger(p) ? p : p.toFixed(1)}%`;
};
const over = (k: number, n: number, limit: number) => n > 0 && k * 100 > limit * n;
const bump = (m: Record<string, number>, key: string, by = 1) => {
  m[key] = (m[key] ?? 0) + by;
};

/**
 * The audit of one benchmark pass. A pass with nothing to measure returns zero counts, null shares and no flags. A flag
 * whose sample is tiny (FLAG_MIN_SAMPLE) is skipped; the counts and shares are still reported.
 */
export async function computePassAudit(db: Db, passId: string): Promise<PassAudit> {
  const empty = (): PassAudit => ({
    signals: { total: 0, byVoice: {}, bySource: {}, topDomains: [] }, lenses: [], gateKills: {}, dropReasons: {}, demandShare: null, nicheShare: null, flags: [],
  });
  if (!UUID_RE.test(passId)) return empty();
  const [pass] = await db.select({ runIds: benchmarkPasses.runIds }).from(benchmarkPasses).where(eq(benchmarkPasses.id, passId));
  if (!pass || pass.runIds.length === 0) return empty();
  const runIds = pass.runIds;
  const generated = and(inArray(ideas.runId, runIds), eq(ideas.origin, 'generated'), eq(runs.isExample, false));

  const [sigRows, lensRows, killRows, [killedRow], stageRows, [demandRow], [reviewRow]] = await Promise.all([
    db.select({ source: signals.source, url: signals.url, voice: signals.voice }).from(signals)
      .where(inArray(signals.runId, runIds)).limit(AUDIT_SIGNALS_MAX),
    db.select({
      lensId: ideas.lensId,
      n: sql<number>`count(distinct ${ideas.id})::int`,
      screenedIn: sql<number>`(count(distinct ${ideas.id}) filter (where ${inArray(ideas.status, ['gated_out', 'advanced'])}))::int`,
      advanced: sql<number>`(count(distinct ${ideas.id}) filter (where ${eq(ideas.status, 'advanced')}))::int`,
      cases: sql<number>`count(distinct ${cases.id})::int`,
    }).from(ideas).innerJoin(runs, eq(runs.id, ideas.runId))
      .leftJoin(cases, and(eq(cases.ideaId, ideas.id), eq(cases.isExample, false)))
      .where(and(generated, isNotNull(ideas.lensId))).groupBy(ideas.lensId).orderBy(ideas.lensId),
    db.select({ check: gateVerdicts.check, killed: sql<number>`count(distinct ${ideas.id})::int` })
      .from(gateVerdicts).innerJoin(ideas, eq(ideas.id, gateVerdicts.ideaId)).innerJoin(runs, eq(runs.id, ideas.runId))
      // Advisory verdicts (ADVISORY_GATE_CHECKS, gate.v7 comps) never kill, so they are not kill reasons.
      .where(and(generated, eq(ideas.status, 'gated_out'), eq(gateVerdicts.pass, false), notInArray(gateVerdicts.check, [...ADVISORY_GATE_CHECKS]))).groupBy(gateVerdicts.check),
    db.select({ n: sql<number>`count(distinct ${ideas.id})::int` }).from(ideas)
      .innerJoin(runs, eq(runs.id, ideas.runId)).where(and(generated, eq(ideas.status, 'gated_out'))),
    db.select({ output: runStages.output }).from(runStages).where(and(inArray(runStages.runId, runIds), eq(runStages.stage, 'ideate'))),
    // Same rule as scorecard metric 7: an idea counts when a library entry it used is a trend, rule change or market.
    db.select({
      total: sql<number>`count(*)::int`,
      yes: sql<number>`(count(*) filter (where exists (select 1 from ${knowledgeItems} where ${knowledgeItems.id} = any(${ideas.libraryItemIds}) and ${inArray(knowledgeItems.kind, ['trend', 'rule_change', 'market'])})))::int`,
    }).from(ideas).innerJoin(runs, eq(runs.id, ideas.runId)).where(and(generated, isNotNull(ideas.libraryItemIds))),
    db.select({
      n: sql<number>`count(*)::int`,
      niche: sql<number>`(count(*) filter (where ${ideaReviews.niche} >= ${NICHE_MIN} or ${ideaReviews.scale} <= ${SMALL_SCALE_MAX}))::int`,
    }).from(ideaReviews).innerJoin(ideas, eq(ideas.id, ideaReviews.ideaId)).innerJoin(runs, eq(runs.id, ideas.runId))
      .where(and(generated, eq(ideaReviews.promptVersion, IDEA_REVIEW_VERSION))),
  ]);

  const flags: string[] = [];

  // Signals.
  const byVoice: Record<string, number> = {};
  const bySource: Record<string, number> = {};
  const byDomain = new Map<string, number>();
  for (const s of sigRows) {
    bump(byVoice, s.voice ?? 'untagged');
    bump(bySource, s.source);
    const d = domainOf(s.url);
    byDomain.set(d, (byDomain.get(d) ?? 0) + 1);
  }
  const total = sigRows.length;
  const domains = [...byDomain.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const topDomains = domains.slice(0, TOP_DOMAINS).map(([domain, k]) => ({ domain, share: k / total }));
  const enoughSignals = total >= FLAG_MIN_SAMPLE.signals;
  // An `unknown` domain is many unparseable urls, not one site, so it never raises the top-domain flag.
  const topKnown = domains.find(([d]) => d !== 'unknown');
  if (enoughSignals && topKnown && over(topKnown[1], total, FLAG_LIMITS.topDomain)) {
    flags.push(`${topKnown[0]} supplied ${pctText(topKnown[1], total)} of the evidence (limit ${FLAG_LIMITS.topDomain}%)`);
  }
  const vendor = byVoice.vendor ?? 0;
  if (enoughSignals && over(vendor, total, FLAG_LIMITS.vendorVoice)) {
    flags.push(`Sellers wrote ${pctText(vendor, total)} of the evidence (limit ${FLAG_LIMITS.vendorVoice}%)`);
  }

  // Lenses.
  const lenses = lensRows.map((r) => ({ lensId: r.lensId!, ideas: Number(r.n), screenedIn: Number(r.screenedIn), advanced: Number(r.advanced), cases: Number(r.cases) }));
  const ideaTotal = lenses.reduce((t, l) => t + l.ideas, 0);
  const topLens = [...lenses].sort((a, b) => b.ideas - a.ideas || a.lensId.localeCompare(b.lensId))[0];
  if (topLens && ideaTotal >= FLAG_MIN_SAMPLE.ideas && over(topLens.ideas, ideaTotal, FLAG_LIMITS.lens)) {
    flags.push(`The ${topLens.lensId} lens produced ${pctText(topLens.ideas, ideaTotal)} of the ideas (limit ${FLAG_LIMITS.lens}%)`);
  }

  // Gate kills: ideas the gate rejected, counted by each check they failed (one idea can fail several checks).
  const gateKills: Record<string, number> = {};
  for (const r of killRows) gateKills[r.check] = Number(r.killed);
  const killed = Number(killedRow?.n ?? 0);
  // A scale kill (revenue ceiling under the line) is intended filtering, as in the scorecard's wasted-entrants rule, so
  // it never raises the one-check flag; it still counts in gateKills and in the denominator.
  const topCheck = Object.entries(gateKills).filter(([check]) => !INTENDED_KILL_CHECKS.has(check))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (topCheck && killed >= FLAG_MIN_SAMPLE.kills && over(topCheck[1], killed, FLAG_LIMITS.gateCheck)) {
    flags.push(`The ${gateCheckLabel(topCheck[0])} check failed ${pctText(topCheck[1], killed)} of the ideas the gate rejected (limit ${FLAG_LIMITS.gateCheck}%)`);
  }

  // Ideate drop reasons, summed over the pass's runs.
  const dropReasons: Record<string, number> = {};
  for (const { output } of stageRows) {
    const d = (output as { dropReasons?: unknown } | null)?.dropReasons;
    if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
    for (const [k, v] of Object.entries(d)) if (typeof v === 'number' && Number.isFinite(v) && v > 0) bump(dropReasons, k, v);
  }

  const demandTotal = Number(demandRow?.total ?? 0);
  const demandShare = demandTotal === 0 ? null : Number(demandRow?.yes ?? 0) / demandTotal;

  const reviewed = Number(reviewRow?.n ?? 0);
  const niche = Number(reviewRow?.niche ?? 0);
  const nicheShare = reviewed === 0 ? null : niche / reviewed;
  if (reviewed >= FLAG_MIN_SAMPLE.reviews && over(niche, reviewed, FLAG_LIMITS.niche)) {
    flags.push(`The idea reviewer called ${pctText(niche, reviewed)} of the ideas niche or small (limit ${FLAG_LIMITS.niche}%)`);
  }

  return { signals: { total, byVoice, bySource, topDomains }, lenses, gateKills, dropReasons, demandShare, nicheShare, flags };
}
