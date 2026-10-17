import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { ideas, lenses, markets, signals } from '../db/schema';
import { loadPrompt } from '../llm/prompts';
import { wrapUntrusted } from '../llm/untrusted';
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
    const [row] = await db.insert(ideas).values({
      runId: run.id, lensId: null, origin: 'owner', ...out, signalIds: input.signalIds, status: 'candidate',
    }).returning({ id: ideas.id });
    log('ideate: 1 owner idea');
    return { ideaIds: [row!.id] };
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
  const ideaIds: string[] = [];
  for (const lens of chosen) {
    const out = await router.structured(
      'ideate',
      {
        prompt: prompt.render({
          market: `${market.name} (${market.countries.join(', ')})`,
          lensName: lens.name,
          lensPattern: lens.pattern,
          lensHint: lens.promptHint,
          signals: wrapUntrusted('signals', signalsText),
          count: String(count),
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
    if (values.length === 0) continue;
    const inserted = await db.insert(ideas).values(values).returning({ id: ideas.id });
    ideaIds.push(...inserted.map((r) => r.id));
  }
  log(`ideate: ${ideaIds.length} ideas from ${chosen.length} lenses`);
  return { ideaIds };
}
