import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { gateVerdicts, ideas, signals } from '../db/schema';
import { loadPrompt } from '../llm/prompts';
import { wrapUntrusted } from '../llm/untrusted';
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

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return url.toLowerCase();
  }
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
    const ideaText = `Title: ${idea.title}\nOne-liner: ${idea.oneLiner}\nBuyer: ${idea.buyer}\nProblem: ${idea.problem}\nSolution: ${idea.solution}`;
    const wrappedIdea = wrapUntrusted('idea', ideaText);

    const research = await router.research(
      'competitors',
      {
        prompt: competitorsPrompt.render({ idea: wrappedIdea }),
        maxSearches: run.config.maxSearchesPerCall,
      },
      { runId: run.id, promptVersion: competitorsPrompt.version },
    );

    const sigRows = idea.signalIds.length
      ? await db.select().from(signals).where(inArray(signals.id, idea.signalIds))
      : [];
    const urls = sigRows.map((s) => s.url);
    const hosts = [...new Set(urls.map(hostOf))];
    const evidencePass = hosts.length >= run.config.minSignals;

    const sourceUrls = research.sources.map((s) => s.url);
    const judged = await router.structured(
      'gate',
      {
        prompt: gatePrompt.render({
          idea: wrappedIdea,
          signals: wrapUntrusted('signals', sigRows.map((s) => `- url: ${s.url}\n  quote: ${oneLine(s.quote)}`).join('\n')),
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
      reasoning: `${hosts.length} independent sources: ${hosts.join(', ')}`,
      sources: urls, model: 'rule', promptVersion: 'evidence-rule.v1',
    });
    await db.insert(gateVerdicts).values(values);

    const failed = ORDER.filter((c) => !results.get(c));
    if (failed.length === 0) {
      passed.push(idea.id);
    } else if (idea.origin === 'owner') {
      passed.push(idea.id);
      advisory.push({ ideaId: idea.id, failedChecks: [...failed] });
    } else {
      killed++;
      await db.update(ideas).set({ status: 'gated_out' }).where(eq(ideas.id, idea.id));
    }
  }

  log(`gate: ${passed.length} passed (${advisory.length} advisory), ${killed} killed`);
  return { passed, advisory };
}
