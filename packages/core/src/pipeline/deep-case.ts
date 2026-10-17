import { asc, eq, inArray } from 'drizzle-orm';
import { listInputs } from '../calc/inputs';
import { computeNumbers } from '../calc/numbers';
import { NumberInputsSchema } from '../calc/schema';
import { CaseDraftSchema, type CaseSections } from '../case/schema';
import type { Db } from '../db/client';
import { cases, claims, gateVerdicts, ideas, markets, signals } from '../db/schema';
import { loadPrompt } from '../llm/prompts';
import { wrapUntrusted } from '../llm/untrusted';
import type { RunConfig, StageDeps } from './types';

const SLUG_MAX = 60;
const WRITE_MAX_TOKENS = 16000;

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const cut = (s: string, n: number) => s.slice(0, n).replace(/-+$/, '');

/** Lowercase kebab-case of a title, at most 60 chars, never ending in '-'. */
export function slugify(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return cut(s, SLUG_MAX) || 'case';
}

/** `base`, or `base-2`, `base-3` … (still within 60 chars) — the first not already used by a case. */
async function uniqueSlug(db: Db, base: string): Promise<string> {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : `-${n}`;
    const candidate = cut(base, SLUG_MAX - suffix.length) + suffix;
    const [hit] = await db.select({ id: cases.id }).from(cases).where(eq(cases.slug, candidate)).limit(1);
    if (!hit) return candidate;
  }
}

const urlList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((u): u is string => typeof u === 'string') : []);

export async function deepCase(
  { db, router, log }: StageDeps,
  run: { id: string; config: RunConfig },
  input: { passed: string[]; advisory: { ideaId: string; failedChecks: string[] }[] },
): Promise<{ caseIds: string[] }> {
  if (input.passed.length === 0) return { caseIds: [] };

  // Idempotent per idea (R20): an idea that already has a case is not researched or written again.
  const existing = await db.select({ id: cases.id, ideaId: cases.ideaId }).from(cases).where(inArray(cases.ideaId, input.passed));
  const caseByIdea = new Map(existing.map((c) => [c.ideaId, c.id]));
  for (const [ideaId, caseId] of caseByIdea) log(`deep-case: idea ${ideaId} already has case ${caseId}, skipping`);

  const todo = input.passed.filter((id) => !caseByIdea.has(id));
  if (todo.length > 0) {
    const rows = await db.select().from(ideas).where(inArray(ideas.id, todo));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = todo.map((id) => {
      const r = byId.get(id);
      if (!r) throw new Error(`deep-case: unknown idea ${id}`);
      return r;
    });

    const [market] = await db.select().from(markets).where(eq(markets.id, run.config.marketId));
    if (!market) throw new Error(`Unknown market: ${run.config.marketId}`);
    const marketText = `${market.name} (${market.countries.join(', ')}), language ${market.language}`;

    const flagsById = new Map(input.advisory.map((a) => [a.ideaId, a.failedChecks]));
    const researchPrompt = loadPrompt('case-research');
    const writePrompt = loadPrompt('case-write');
    const model = router.modelFor('case');

    for (const idea of ordered) {
      const wrappedIdea = wrapUntrusted(
        'idea',
        `Title: ${idea.title}\nOne-liner: ${idea.oneLiner}\nBuyer: ${idea.buyer}\nProblem: ${idea.problem}\nSolution: ${idea.solution}`,
      );

      const sigRows = idea.signalIds.length
        ? await db.select().from(signals).where(inArray(signals.id, idea.signalIds))
        : [];
      const wrappedSignals = wrapUntrusted(
        'signals',
        sigRows.map((s) => `- source: ${s.source}\n  url: ${s.url}\n  quote: ${oneLine(s.quote)}`).join('\n') || '(none)',
      );

      // Latest verdict per check (a resumed gate may have written more than one).
      const verdicts = await db.select().from(gateVerdicts).where(eq(gateVerdicts.ideaId, idea.id)).orderBy(asc(gateVerdicts.createdAt));
      const latest = new Map(verdicts.map((v) => [v.check, v]));
      const wrappedGate = wrapUntrusted(
        'gate-findings',
        [...latest.values()]
          .map((v) => `- ${v.check} (${v.pass ? 'pass' : 'fail'}): ${oneLine(v.reasoning)}\n  urls: ${urlList(v.sources).join(' ') || '(none)'}`)
          .join('\n') || '(no gate findings recorded)',
      );

      const research = await router.research(
        'case',
        {
          prompt: researchPrompt.render({
            idea: wrappedIdea, market: marketText, currency: market.currency, signals: wrappedSignals, gate: wrappedGate,
          }),
          maxSearches: 2 * run.config.maxSearchesPerCall,
        },
        { runId: run.id, promptVersion: researchPrompt.version },
      );

      const sourcesText = research.sources
        .map((s) => `- ${s.url}${s.title ? ` (${oneLine(s.title)})` : ''}${s.citedText ? `\n  cited: "${oneLine(s.citedText)}"` : ''}`)
        .join('\n');
      const draft = await router.structured(
        'case',
        {
          prompt: writePrompt.render({
            idea: wrappedIdea,
            market: marketText,
            currency: market.currency,
            signals: wrappedSignals,
            gate: wrappedGate,
            research: wrapUntrusted('research', research.text),
            researchSources: wrapUntrusted('research-sources', sourcesText || '(none)'),
          }),
          schema: CaseDraftSchema,
          schemaName: 'case_draft',
          maxTokens: WRITE_MAX_TOKENS,
        },
        { runId: run.id, promptVersion: writePrompt.version },
      );

      // Arithmetic is done by code: validate the inputs, then compute. Any model-supplied results are discarded.
      const inputs = NumberInputsSchema.parse(draft.numbers.inputs);
      const gateFlags = [...(flagsById.get(idea.id) ?? [])];
      const sections: CaseSections = {
        summary: { ...draft.summary, gateFlags },
        evidence: draft.evidence,
        numbers: { inputs, results: computeNumbers(inputs) },
        competitors: draft.competitors,
        pitch: draft.pitch,
      };

      const claimRows = (caseId: string): (typeof claims.$inferInsert)[] => [
        ...draft.evidence.claims.map((c) => ({ caseId, section: 'evidence', text: c.text, sourceUrl: c.sourceUrl, quote: c.quote })),
        ...listInputs(inputs).flatMap(({ label, sourced }) =>
          sourced.source
            ? [{ caseId, section: 'numbers', text: `${label}: ${sourced.value}`, sourceUrl: sourced.source.url, quote: sourced.source.quote }]
            : [],
        ),
      ];

      // One transaction per case so a crash can never leave a case without its claims.
      const caseId = await db.transaction(async (tx) => {
        const slug = await uniqueSlug(tx, slugify(draft.title));
        const [row] = await tx.insert(cases).values({
          ideaId: idea.id, slug, title: draft.title, stage: 'new', sections,
          gateAdvisory: gateFlags.length > 0, model, promptVersion: writePrompt.version,
        }).returning({ id: cases.id });
        await tx.insert(claims).values(claimRows(row!.id));
        return row!.id;
      });
      caseByIdea.set(idea.id, caseId);
    }
  }

  log(`deep-case: ${todo.length} written, ${input.passed.length - todo.length} already existed`);
  return { caseIds: input.passed.map((id) => caseByIdea.get(id)!) };
}
