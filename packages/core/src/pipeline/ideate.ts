import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { ideas, lenses, markets, signals } from '../db/schema';
import { loadPrompt } from '../llm/prompts';
import { capField, wrapUntrusted } from '../llm/untrusted';
import type { RunConfig, StageDeps } from './types';

const MAX_SIGNALS = 40;

const ideaFields = {
  title: z.string(),
  oneLiner: z.string(),
  buyer: z.string(),
  problem: z.string(),
  solution: z.string(),
};
const lensIdeasSchema = z.object({
  ideas: z.array(z.object({ ...ideaFields, signalUrls: z.array(z.string()) })),
});
const ownerIdeaSchema = z.object(ideaFields);

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

type IdeaInsert = typeof ideas.$inferInsert;

/**
 * Idempotent per run (R20): in one transaction, drop any ideas an earlier attempt left for this run and insert
 * the new set. Safe because no later stage can have run while ideate is not done.
 */
async function replaceRunIdeas(db: Db, runId: string, values: IdeaInsert[]): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.delete(ideas).where(eq(ideas.runId, runId));
    if (values.length === 0) return [];
    const inserted = await tx.insert(ideas).values(values).returning({ id: ideas.id });
    return inserted.map((r) => r.id);
  });
}

export async function ideate(
  { db, router, log }: StageDeps,
  run: { id: string; config: RunConfig },
  input: { signalIds: string[] },
): Promise<{ ideaIds: string[] }> {
  const cfg = run.config;

  if (cfg.seedType === 'idea') {
    const ideaText = cfg.ideaText?.trim();
    if (!ideaText) throw new Error('ideaText is required for idea seeds');
    const prompt = loadPrompt('owner-idea');
    const out = await router.structured(
      'ideate',
      { prompt: prompt.render({ idea: wrapUntrusted('idea', ideaText) }), schema: ownerIdeaSchema, schemaName: 'owner_idea' },
      { runId: run.id, promptVersion: prompt.version },
    );
    const ideaIds = await replaceRunIdeas(db, run.id, [{
      runId: run.id, lensId: null, origin: 'owner', ...out, signalIds: input.signalIds, status: 'candidate',
    }]);
    log('ideate: 1 owner idea');
    return { ideaIds };
  }

  const [market] = await db.select().from(markets).where(eq(markets.id, cfg.marketId));
  if (!market) throw new Error(`Unknown market: ${cfg.marketId}`);

  const allLenses = await db.select().from(lenses);
  const wanted = cfg.lensIds;
  const chosen = allLenses.filter((l) => l.active && (!wanted || wanted.includes(l.id)));
  if (chosen.length === 0) {
    throw new Error(`No active lenses found${wanted ? ` for lens ids: ${wanted.join(', ')}` : ''}`);
  }

  const used = input.signalIds.slice(0, MAX_SIGNALS);
  const rows = used.length ? await db.select().from(signals).where(inArray(signals.id, used)) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const passed = used.map((id) => byId.get(id)).filter((r): r is NonNullable<typeof r> => !!r);
  const signalsText = passed.map((s) => `- url: ${s.url}\n  quote: ${oneLine(s.quote)}`).join('\n');

  const count = Math.ceil(cfg.ideaCount / chosen.length);
  const prompt = loadPrompt('ideate');
  const pending: IdeaInsert[] = [];
  for (const lens of chosen) {
    // Titles from earlier lenses in this run, so each lens steers away from buyers/problems already covered.
    const priorTitles = pending.map((v) => `- ${capField(v.title, 200)}`).join('\n');
    const out = await router.structured(
      'ideate',
      {
        prompt: prompt.render({
          market: `${market.name} (${market.countries.join(', ')})`,
          lensName: lens.name,
          lensPattern: lens.pattern,
          lensHint: lens.promptHint,
          signals: wrapUntrusted('signals', signalsText),
          priorIdeas: wrapUntrusted('prior-ideas', priorTitles || '(none yet)'),
          count: String(count),
          minSignals: String(cfg.minSignals),
        }),
        schema: lensIdeasSchema,
        schemaName: 'ideate_ideas',
      },
      { runId: run.id, promptVersion: prompt.version },
    );
    const values = out.ideas.slice(0, count).map(({ signalUrls, ...f }) => {
      const urls = new Set(signalUrls);
      return {
        runId: run.id,
        lensId: lens.id,
        origin: 'generated' as const,
        ...f,
        signalIds: passed.filter((s) => urls.has(s.url)).map((s) => s.id),
        status: 'candidate' as const,
      };
    });
    pending.push(...values);
  }
  // Written only after every lens call succeeded, so a failed (and resumed) ideate leaves no partial set.
  const ideaIds = await replaceRunIdeas(db, run.id, pending);
  log(`ideate: ${ideaIds.length} ideas from ${chosen.length} lenses`);
  return { ideaIds };
}
