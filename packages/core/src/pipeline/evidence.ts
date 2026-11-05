import { parse } from 'tldts';
import type { SignalVoice } from '../db/schema';
import type { KnowledgeKind } from '../library/kinds';
import { isBannedSource } from '../tools/banned-sources';

/**
 * The evidence rule, shared by ideate (storage) and the gate (code rule). Moved from gate.ts unchanged; ideate.v12 adds
 * the demand route (hasDemandEvidence).
 */

/** Community platforms: several distinct threads on one of these count as separate evidence, up to the cap. */
export const COMMUNITY_PLATFORMS = ['ycombinator.com', 'stackexchange.com', 'stackoverflow.com', 'github.com', 'wordpress.org'] as const;
const COMMUNITY = new Set<string>(COMMUNITY_PLATFORMS);
const THREADS_PER_PLATFORM = 2;

/** Registrable domain and thread key (URL without fragment) of an http(s) URL, or null (fail closed). */
function parseSource(url: string): { domain: string; thread: string } | null {
  try {
    if (isBannedSource(url)) return null;
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const r = parse(u.hostname.toLowerCase());
    if (r.isIp || !r.domain) return null;
    u.hash = '';
    u.protocol = 'https:';
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
    return { domain: r.domain.toLowerCase(), thread: u.href };
  } catch {
    return null;
  }
}

/**
 * Hybrid evidence units: community platforms count distinct threads (max 2 each), every other domain once.
 * `countedUrls` (input order) are the urls behind those units: unparseable, banned, IP and dotless urls are dropped, and
 * on a community platform only urls of its first 2 distinct threads are kept; every url of another counted domain is kept.
 */
export function countEvidence(urls: string[]): { units: number; breakdown: string; countedUrls: string[] } {
  const byDomain = new Map<string, Set<string>>();
  const parsed: { url: string; domain: string; thread: string }[] = [];
  for (const url of urls) {
    const s = parseSource(url);
    if (!s) continue;
    parsed.push({ url, ...s });
    const set = byDomain.get(s.domain) ?? new Set<string>();
    // A capped platform keeps only its first THREADS_PER_PLATFORM threads, so countedUrls matches the units.
    if (!COMMUNITY.has(s.domain) || set.size < THREADS_PER_PLATFORM || set.has(s.thread)) set.add(s.thread);
    byDomain.set(s.domain, set);
  }
  let units = 0;
  const parts: string[] = [];
  for (const [domain, threads] of byDomain) {
    const n = COMMUNITY.has(domain) ? threads.size : 1;
    units += n;
    parts.push(n > 1 ? `${domain} ×${n} threads` : domain);
  }
  const countedUrls = parsed.filter((p) => byDomain.get(p.domain)!.has(p.thread)).map((p) => p.url);
  return { units, breakdown: parts.join(', '), countedUrls };
}

/**
 * countEvidence over signal rows, counting only independent voices: `operator` and `neutral`. Fails closed: `vendor`
 * signals (written by companies already selling a fix) and untagged ones (NULL voice, extracted before tuning-4 and not
 * re-harvested since) are excluded and counted in `excludedVendor` / `excludedUntagged`. `counted` lists the urls that
 * were passed to countEvidence (voice-eligible); `countedUrls` those that earned a unit.
 */
export function countEvidenceForSignals(rows: { url: string; voice: SignalVoice | null }[]): {
  units: number; breakdown: string; countedUrls: string[]; counted: string[]; excludedVendor: number; excludedUntagged: number;
} {
  const counted = rows.filter((r) => r.voice === 'operator' || r.voice === 'neutral').map((r) => r.url);
  return {
    ...countEvidence(counted),
    counted,
    excludedVendor: rows.filter((r) => r.voice === 'vendor').length,
    excludedUntagged: rows.filter((r) => r.voice == null).length,
  };
}

/** Library kinds that show demand (ideate.v12): a cited trend, market, rule change or pricing entry. */
export const DEMAND_LIBRARY_KINDS: readonly KnowledgeKind[] = ['trend', 'market', 'rule_change', 'pricing'];

export type EvidenceSignal = { url: string; voice: SignalVoice | null; kind: string };

/**
 * The demand route of the evidence rule (ideate.v12, spec B3, controller ruling on owner decision 3: one complaint
 * plus one demand source): at least 1 operator or neutral `pain` signal plus at least 1 demand source. A demand source is
 * - a cited library entry that was shown to the call that wrote the idea (`shownLibraryKinds`, id to kind) and whose
 *   kind is trend, market, rule_change or pricing (an id that was not shown never counts), or
 * - an operator or neutral `opportunity` signal from a different registrable domain than such a complaint (the same
 *   site twice is one source, not two; two opportunity signals with no complaint never qualify).
 * Fails closed like countEvidenceForSignals: vendor and untagged signals, and urls that do not parse (or are banned),
 * never count on either side. `signals` are the idea's cited signal rows.
 */
export function hasDemandEvidence(
  idea: { libraryItemIds: readonly string[] | null },
  shownLibraryKinds: ReadonlyMap<string, string>,
  signals: readonly EvidenceSignal[],
): boolean {
  return demandSources(idea, shownLibraryKinds, signals) !== null;
}

/**
 * The demand sources behind the demand route, or null when it is not met: the cited demand library entries (id and
 * kind, in citation order) and the opportunity signals from another domain than a complaint (url and domain);
 * `signalUrls` are the urls of the complaints and of those opportunity signals, in input order.
 */
export type DemandSources = { library: { id: string; kind: string }[]; opportunities: { url: string; domain: string }[]; signalUrls: string[] };

/**
 * The demand route's parts. `complaints` are the operator or neutral `pain` signals that parse; `library` the cited
 * demand entries; `opportunities` the operator or neutral opportunity signals on another registrable domain than at
 * least one of those complaints; `candidates` says whether the idea offered any demand source at all (a demand entry
 * or an eligible opportunity signal), so a failure can be told apart: no complaint, or no demand source.
 */
function demandParts(
  idea: { libraryItemIds: readonly string[] | null },
  shownLibraryKinds: ReadonlyMap<string, string>,
  signals: readonly EvidenceSignal[],
) {
  const eligible = signals.flatMap((s) => {
    if (s.voice !== 'operator' && s.voice !== 'neutral') return [];
    const src = parseSource(s.url);
    return src ? [{ url: s.url, domain: src.domain, opportunity: s.kind === 'opportunity', pain: s.kind === 'pain' }] : [];
  });
  const complaints = eligible.filter((e) => e.pain);
  const demandKinds = new Set<string>(DEMAND_LIBRARY_KINDS);
  const library = [...new Set(idea.libraryItemIds ?? [])].flatMap((id) => {
    const kind = shownLibraryKinds.get(id);
    return kind && demandKinds.has(kind) ? [{ id, kind }] : [];
  });
  const offered = eligible.filter((e) => e.opportunity);
  const opportunities = offered
    .filter((o) => complaints.some((c) => c.domain !== o.domain))
    .map(({ url, domain }) => ({ url, domain }));
  return { eligible, complaints, library, opportunities, candidates: library.length > 0 || offered.length > 0 };
}

function demandSources(
  idea: { libraryItemIds: readonly string[] | null },
  shownLibraryKinds: ReadonlyMap<string, string>,
  signals: readonly EvidenceSignal[],
): DemandSources | null {
  const { eligible, complaints, library, opportunities } = demandParts(idea, shownLibraryKinds, signals);
  if (complaints.length === 0) return null;
  if (library.length === 0 && opportunities.length === 0) return null;
  const used = new Set(opportunities.map((o) => o.url));
  return { library, opportunities, signalUrls: eligible.filter((e) => e.pain || used.has(e.url)).map((e) => e.url) };
}

/**
 * The evidence rule in full, with the detail the gate's verdict shows:
 * - the complaint route: at least `minSignals` independent operator or neutral units, counted over `pain` signals only
 *   (spec B3: complaint signals; an opportunity signal is never a complaint), see countEvidenceForSignals;
 * - otherwise the demand route (hasDemandEvidence), whose `demand` lists the sources.
 * `complaints` is always the complaint count; `route` is the route that passed, or null; `failure` says why it failed.
 */
export function evaluateEvidence(
  idea: { libraryItemIds: readonly string[] | null },
  shownLibraryKinds: ReadonlyMap<string, string>,
  signals: readonly EvidenceSignal[],
  minSignals: number,
): {
  pass: boolean; route: 'signals' | 'demand' | null; complaints: ReturnType<typeof countEvidenceForSignals>; demand: DemandSources | null;
  failure: EvidenceFailure | null;
} {
  const complaints = countEvidenceForSignals(signals.filter((s) => s.kind === 'pain'));
  if (complaints.units >= minSignals) return { pass: true, route: 'signals', complaints, demand: null, failure: null };
  const demand = demandSources(idea, shownLibraryKinds, signals);
  if (demand) return { pass: true, route: 'demand', complaints, demand, failure: null };
  const parts = demandParts(idea, shownLibraryKinds, signals);
  const failure: EvidenceFailure = parts.candidates && parts.complaints.length === 0 ? 'no_complaint' : 'no_demand_source';
  return { pass: false, route: null, complaints, demand: null, failure };
}

/**
 * Why the evidence rule failed: `no_complaint` when the idea offers a demand source (a demand entry or an operator or
 * neutral opportunity signal) but no operator or neutral complaint to pair it with, so no route is valid; otherwise
 * `no_demand_source` (too few complaint units and nothing to complete the demand route).
 */
export type EvidenceFailure = 'no_complaint' | 'no_demand_source';

/** The evidence rule as a yes or no (evaluateEvidence): shared by ideate's storage, screen's pre-check and the gate. */
export function meetsEvidenceRule(
  idea: { libraryItemIds: readonly string[] | null },
  shownLibraryKinds: ReadonlyMap<string, string>,
  signals: readonly EvidenceSignal[],
  minSignals: number,
): boolean {
  return evaluateEvidence(idea, shownLibraryKinds, signals, minSignals).pass;
}
