import { eq, inArray } from 'drizzle-orm';
import { parse } from 'tldts';
import { z } from 'zod';
import { ideationContext, renderIdeationContext } from '../library/context';
import { gateVerdicts, ideas, markets, signals, type SignalVoice } from '../db/schema';
import { loadPrompt } from '../llm/prompts';
import { capField, wrapUntrusted } from '../llm/untrusted';
import { BANNED_DOMAINS, isBannedSource } from '../tools/banned-sources';
import { ideaBlock } from './idea-text';
import type { RunConfig, StageDeps } from './types';

const CHECKS = ['generic', 'regulation', 'control', 'autonomy', 'reachability'] as const;
const ORDER = [...CHECKS, 'evidence'] as const;

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

/** "N independent sources: <breakdown>[; excluded K vendor, M untagged]" (zero counts left out) for the evidence verdict. */
function evidenceReasoning(e: ReturnType<typeof countEvidenceForSignals>): string {
  const excluded = [
    ...(e.excludedVendor ? [`${e.excludedVendor} vendor`] : []),
    ...(e.excludedUntagged ? [`${e.excludedUntagged} untagged`] : []),
  ];
  return `${e.units} independent sources${e.breakdown ? `: ${e.breakdown}` : ''}${excluded.length ? `; excluded ${excluded.join(', ')}` : ''}`;
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
    // Only operator- and neutral-voiced signals count toward the evidence rule; vendor and untagged ones never do (tuning-4).
    const evidence = countEvidenceForSignals(sigRows);
    const evidencePass = evidence.units >= run.config.minSignals;

    const sourceUrls = research.sources.map((s) => s.url);
    // Library startups already sold near this idea (needs the idea's embedding): extra evidence for the generic check.
    // Only that section is used, so every other section is 0 (no query).
    const alreadySold = idea.embedding
      ? renderIdeationContext(await ideationContext(db, idea.embedding, { countries, alreadySoldMax: 15, lessonsMax: 0, pricingMax: 0, changingMax: 0, marketsMax: 0 })).alreadySold
      : 'none found';
    const judged = await router.structured(
      'gate',
      {
        prompt: gatePrompt.render({
          idea: wrappedIdea,
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
      sources: evidence.countedUrls, model: 'rule', promptVersion: 'evidence-rule.v2',
    });
    const failed = ORDER.filter((c) => !results.get(c));
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
