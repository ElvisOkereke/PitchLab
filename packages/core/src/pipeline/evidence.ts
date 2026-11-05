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
 * The demand route of the evidence rule (ideate.v12, spec B3): at least 1 operator or neutral signal (pain or
 * opportunity) plus at least 1 demand source. A demand source is
 * - a cited library entry that was shown to the call that wrote the idea (`shownLibraryKinds`, id to kind) and whose
 *   kind is trend, market, rule_change or pricing (an id that was not shown never counts), or
 * - an operator or neutral `opportunity` signal from a different registrable domain than another operator or neutral
 *   signal the idea cites (the same site twice is one source, not two).
 * Fails closed like countEvidenceForSignals: vendor and untagged signals, and urls that do not parse (or are banned),
 * never count on either side. `signals` are the idea's cited signal rows.
 */
export function hasDemandEvidence(
  idea: { libraryItemIds: readonly string[] },
  shownLibraryKinds: ReadonlyMap<string, string>,
  signals: readonly EvidenceSignal[],
): boolean {
  const eligible = signals.flatMap((s) => {
    if (s.voice !== 'operator' && s.voice !== 'neutral') return [];
    const src = parseSource(s.url);
    return src ? [{ domain: src.domain, opportunity: s.kind === 'opportunity' }] : [];
  });
  if (eligible.length === 0) return false;
  const demandKinds = new Set<string>(DEMAND_LIBRARY_KINDS);
  if (idea.libraryItemIds.some((id) => demandKinds.has(shownLibraryKinds.get(id) ?? ''))) return true;
  return eligible.some((o) => o.opportunity && eligible.some((a) => a.domain !== o.domain));
}

/**
 * The full evidence rule: at least `minSignals` independent operator or neutral units (countEvidenceForSignals), or the
 * demand route (hasDemandEvidence).
 */
export function meetsEvidenceRule(
  idea: { libraryItemIds: readonly string[] },
  shownLibraryKinds: ReadonlyMap<string, string>,
  signals: readonly EvidenceSignal[],
  minSignals: number,
): boolean {
  return countEvidenceForSignals([...signals]).units >= minSignals || hasDemandEvidence(idea, shownLibraryKinds, signals);
}
