import { and, eq } from 'drizzle-orm';
import { AiScoresSchema, CRITERIA } from '../case/schema';
import { cases, claims, scores } from '../db/schema';
import { loadPrompt } from '../llm/prompts';
import { wrapUntrusted } from '../llm/untrusted';
import type { RunConfig, StageDeps } from './types';

const SECTIONS_MAX = 30000;

type ClaimStatus = (typeof claims.$inferSelect)['verified'];

/** The evidence cap counts the case's own claims; signal and competitor (product/pricing) checks are reported but don't move it. */
const CAP_SECTIONS = ['evidence', 'numbers'];

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
    const count = (section: string[], status?: ClaimStatus) =>
      sourced.filter((c) => section.includes(c.section) && (!status || c.verified === status)).length;
    const total = count(CAP_SECTIONS);
    const verified = count(CAP_SECTIONS, 'verified');
    const unreachable = count(CAP_SECTIONS, 'unreachable');
    const unsupported = count(CAP_SECTIONS, 'unsupported');
    // needs_review earns no credit (like unreachable): only verified claims count toward the ratio.
    const needsReview = count(CAP_SECTIONS, 'needs_review');
    const ratio = total === 0 ? 0 : verified / total;
    const linkStat = (section: string, label: string) => {
      const owner = count([section], 'unreachable') + count([section], 'needs_review');
      return `${count([section], 'verified')}/${count([section])} ${label} verified${owner ? ` (${owner} left for the owner to check)` : ''}`;
    };
    const linkStats =
      `${linkStat('signal', 'harvested signal links')}; ${linkStat('competitor', 'competitor links')}; ` +
      `${linkStat('competitor-pricing', 'quoted competitor prices')}.`;

    const json = JSON.stringify(kase.sections, null, 1);
    const result = await router.structured(
      'score',
      {
        prompt: prompt.render({
          sections: wrapUntrusted('case', json.slice(0, SECTIONS_MAX)),
          stats:
            `${verified}/${total} cited claims verified against their source pages; ${unreachable} unreachable; ` +
            `${needsReview} left for the owner to check (checker unsure); ${unsupported} not supported by the page. ${linkStats}`,
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

