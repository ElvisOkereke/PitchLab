import { and, eq } from 'drizzle-orm';
import { AiScoresSchema, CRITERIA } from '../case/schema';
import { cases, claims, scores } from '../db/schema';
import { loadPrompt } from '../llm/prompts';
import { wrapUntrusted } from '../llm/untrusted';
import type { RunConfig, StageDeps } from './types';

const SECTIONS_MAX = 30000;

/** Evidence cap by verified ratio: < 0.5 → at most 2, < 0.8 → at most 3. */
function evidenceCap(ratio: number): number {
  return ratio < 0.5 ? 2 : ratio < 0.8 ? 3 : 5;
}

export async function score(
  { db, router, log }: StageDeps,
  run: { id: string; config: RunConfig },
  input: { caseIds: string[] },
): Promise<{ caseIds: string[] }> {
  if (input.caseIds.length === 0) return { caseIds: input.caseIds };

  const prompt = loadPrompt('score');
  const model = router.modelFor('score');

  for (const caseId of input.caseIds) {
    const [kase] = await db.select().from(cases).where(eq(cases.id, caseId));
    if (!kase) throw new Error(`score: unknown case ${caseId}`);

    const sourced = (await db.select().from(claims).where(eq(claims.caseId, caseId))).filter((c) => c.sourceUrl?.trim());
    const total = sourced.length;
    const verified = sourced.filter((c) => c.verified === 'verified').length;
    const unreachable = sourced.filter((c) => c.verified === 'unreachable').length;
    const unsupported = sourced.filter((c) => c.verified === 'unsupported').length;
    const ratio = total === 0 ? 0 : verified / total;

    const json = JSON.stringify(kase.sections, null, 1);
    const result = await router.structured(
      'score',
      {
        prompt: prompt.render({
          sections: wrapUntrusted('case', json.slice(0, SECTIONS_MAX)),
          stats: `${verified}/${total} cited claims verified against their source pages; ${unreachable} unreachable; ${unsupported} not supported by the page.`,
        }),
        schema: AiScoresSchema,
        schemaName: 'case_scores',
      },
      { runId: run.id, promptVersion: prompt.version },
    );

    const capped = Math.min(result.evidence.value, evidenceCap(ratio));
    const final = { ...result, evidence: { ...result.evidence } };
    if (capped < result.evidence.value) {
      final.evidence = { value: capped, note: `${result.evidence.note} (capped: ${verified}/${total} claims verified)` };
    }

    await db.transaction(async (tx) => {
      await tx.delete(scores).where(and(eq(scores.caseId, caseId), eq(scores.by, 'ai')));
      await tx.insert(scores).values(
        CRITERIA.map((criterion) => ({
          caseId, criterion, value: final[criterion].value, note: final[criterion].note, by: 'ai' as const, model, promptVersion: prompt.version,
        })),
      );
    });
  }

  log(`score: ${input.caseIds.length} case(s) scored`);
  return { caseIds: input.caseIds };
}

