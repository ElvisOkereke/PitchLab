import { eq, inArray } from 'drizzle-orm';
import { parse } from 'tldts';
import { z } from 'zod';
import { gateVerdicts, ideas, signals } from '../db/schema';
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

/** Hybrid evidence units: community platforms count distinct threads (max 2 each), every other domain once. */
export function countEvidence(urls: string[]): { units: number; breakdown: string } {
  const byDomain = new Map<string, Set<string>>();
  for (const url of urls) {
    const s = parseSource(url);
    if (!s) continue;
    const set = byDomain.get(s.domain) ?? new Set<string>();
    set.add(s.thread);
    byDomain.set(s.domain, set);
  }
  let units = 0;
  const parts: string[] = [];
  for (const [domain, threads] of byDomain) {
    const n = COMMUNITY.has(domain) ? Math.min(threads.size, THREADS_PER_PLATFORM) : 1;
    units += n;
    parts.push(n > 1 ? `${domain} ×${n} threads` : domain);
  }
  return { units, breakdown: parts.join(', ') };
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
    const urls = sigRows.map((s) => s.url);
    const evidence = countEvidence(urls);
    const evidencePass = evidence.units >= run.config.minSignals;

    const sourceUrls = research.sources.map((s) => s.url);
    const judged = await router.structured(
      'gate',
      {
        prompt: gatePrompt.render({
          idea: wrappedIdea,
          signals: wrapUntrusted('signals', sigRows.map((s) => `- url: ${capField(s.url, 2000)}\n  quote: ${capField(s.quote, 1000)}`).join('\n')),
          competitors: wrapUntrusted('competitors', research.text),
          competitorUrls: wrapUntrusted('competitor-urls', sourceUrls.join('\n')),
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
      reasoning: `${evidence.units} independent sources: ${evidence.breakdown}`,
      sources: urls, model: 'rule', promptVersion: 'evidence-rule.v1',
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
