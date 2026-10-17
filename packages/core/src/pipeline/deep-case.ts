import { asc, eq, inArray } from 'drizzle-orm';
import { listInputs } from '../calc/inputs';
import { computeNumbers } from '../calc/numbers';
import { NumberInputsSchema, type NumberInputs } from '../calc/schema';
import { CaseDraftSchema, type CaseSections } from '../case/schema';
import type { Db } from '../db/client';
import { cases, claims, gateVerdicts, ideas, markets, signals } from '../db/schema';
import { loadPrompt } from '../llm/prompts';
import { capField, wrapUntrusted } from '../llm/untrusted';
import { isBannedSource } from '../tools/banned-sources';
import { ideaBlock } from './idea-text';
import type { RunConfig, StageDeps } from './types';

const SLUG_MAX = 60;
const WRITE_MAX_TOKENS = 16000;
/** Per case, at most this many signal claims and this many competitor claims are written for verification. */
const LINK_CLAIMS_MAX = 15;

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

const BANNED_SOURCE_ASSUMPTION = 'source removed: banned domain';

/** A copy of the inputs where every banned-domain source is replaced by an assumption (the value is kept). */
function withoutBannedSources(raw: NumberInputs): NumberInputs {
  const copy = structuredClone(raw);
  for (const { sourced } of listInputs(copy)) {
    if (sourced.source && isBannedSource(sourced.source.url)) {
      delete sourced.source;
      sourced.assumption = BANNED_SOURCE_ASSUMPTION;
    }
  }
  return copy;
}

const urlList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((u): u is string => typeof u === 'string') : []);

/** A readable source name for a signal: its hostname without "www.", else the harvest source id. */
function sourceName(url: string, fallback: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '') || fallback;
  } catch {
    return fallback;
  }
}

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
      const wrappedIdea = wrapUntrusted('idea', ideaBlock(idea));

      const sigFound = idea.signalIds.length
        ? await db.select().from(signals).where(inArray(signals.id, idea.signalIds))
        : [];
      const sigById = new Map(sigFound.map((s) => [s.id, s]));
      const allSigRows = idea.signalIds.flatMap((id) => sigById.get(id) ?? []).filter((s) => !isBannedSource(s.url));
      const wrappedSignals = wrapUntrusted(
        'signals',
        allSigRows
          .map((s) => `- source: ${capField(s.source, 100)}\n  url: ${capField(s.url, 2000)}\n  quote: ${capField(s.quote, 1000)}`)
          .join('\n') || '(none)',
      );

      const verdicts = await db.select().from(gateVerdicts).where(eq(gateVerdicts.ideaId, idea.id)).orderBy(asc(gateVerdicts.createdAt));
      const latest = new Map(verdicts.map((v) => [v.check, v]));
      const wrappedGate = wrapUntrusted(
        'gate-findings',
        [...latest.values()]
          .map((v) => `- ${v.check} (${v.pass ? 'pass' : 'fail'}): ${capField(v.reasoning, 1000)}\n  urls: ${urlList(v.sources).join(' ') || '(none)'}`)
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
        .map((s) => `- ${capField(s.url, 2000)}${s.title ? ` (${capField(s.title, 300)})` : ''}${s.citedText ? `\n  cited: "${capField(s.citedText, 2000)}"` : ''}`)
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
      // Evidence signals come from the real signal rows used for this idea, never from the model.
      // Banned-domain sources are dropped (claims, competitors) or turned into assumptions (number inputs).
      const inputs = NumberInputsSchema.parse(withoutBannedSources(draft.numbers.inputs));
      const evidenceClaims = draft.evidence.claims.filter((c) => !isBannedSource(c.sourceUrl));
      // Only the first LINK_CLAIMS_MAX signals/competitors are stored, so every displayed link has a verification claim.
      const sigRows = allSigRows.slice(0, LINK_CLAIMS_MAX);
      const competitorList = draft.competitors.list.filter((c) => !isBannedSource(c.url)).slice(0, LINK_CLAIMS_MAX);
      const gateFlags = [...(flagsById.get(idea.id) ?? [])];
      const sections: CaseSections = {
        summary: { ...draft.summary, gateFlags },
        evidence: {
          signals: sigRows.map((s) => ({ quote: s.quote, url: s.url, sourceName: sourceName(s.url, s.source) })),
          claims: evidenceClaims,
        },
        numbers: { inputs, results: computeNumbers(inputs) },
        competitors: { ...draft.competitors, list: competitorList },
        pitch: draft.pitch,
      };

      const claimRows = (caseId: string): (typeof claims.$inferInsert)[] => [
        ...evidenceClaims.map((c) => ({ caseId, section: 'evidence', text: c.text, sourceUrl: c.sourceUrl, quote: c.quote })),
        ...listInputs(inputs).flatMap(({ label, sourced }) =>
          sourced.source
            ? [{ caseId, section: 'numbers', text: `${label}: ${sourced.value}`, sourceUrl: sourced.source.url, quote: sourced.source.quote }]
            : [],
        ),
        // Displayed links are verified too: sigRows and competitorList are already capped at LINK_CLAIMS_MAX
        // (all http(s): isBannedSource fails closed). Legacy cases may still render a link as "not checked".
        ...sigRows
          .map((s) => ({ caseId, section: 'signal', text: capField(s.quote, 1000), sourceUrl: s.url, quote: s.quote })),
        ...competitorList
          .map((c) => ({ caseId, section: 'competitor', text: `${c.name}: ${c.pricing}`, sourceUrl: c.url, quote: null })),
      ];

      // One transaction per case so a crash can never leave a case without its claims.
      const caseId = await db.transaction(async (tx) => {
        const slug = await uniqueSlug(tx, slugify(draft.title));
        const [row] = await tx.insert(cases).values({
          ideaId: idea.id, slug, title: draft.title, stage: 'new', sections,
          gateAdvisory: gateFlags.length > 0, model, promptVersion: writePrompt.version,
        }).returning({ id: cases.id });
        const rows = claimRows(row!.id);
        if (rows.length) await tx.insert(claims).values(rows);
        return row!.id;
      });
      caseByIdea.set(idea.id, caseId);
    }
  }

  log(`deep-case: ${todo.length} written, ${input.passed.length - todo.length} already existed`);
  return { caseIds: input.passed.map((id) => caseByIdea.get(id)!) };
}
