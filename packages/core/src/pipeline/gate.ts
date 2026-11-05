import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { ideationContext, renderIdeationContext } from '../library/context';
import { gateVerdicts, ideas, markets, signals } from '../db/schema';
import { loadPrompt } from '../llm/prompts';
import { capField, wrapUntrusted } from '../llm/untrusted';
import { BANNED_DOMAINS } from '../tools/banned-sources';
import { countEvidenceForSignals } from './evidence';
import { ideaBlock } from './idea-text';
import type { RunConfig, StageDeps } from './types';

// The evidence helpers moved to ./evidence (shared with ideate); re-exported so existing imports keep working.
export { COMMUNITY_PLATFORMS, countEvidence, countEvidenceForSignals } from './evidence';

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
