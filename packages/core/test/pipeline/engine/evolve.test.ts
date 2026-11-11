import { and, eq, isNotNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../../src/db/client';
import { knowledgeItems, lenses, llmCalls, runs, signals, sketches, tournamentMatches } from '../../../src/db/schema';
import { evolve, evolveAttemptedKey, nearestComps } from '../../../src/pipeline/engine/evolve';
import { EVOLVE_TOP } from '../../../src/pipeline/engine/kinds';
import { BUSINESS_MODELS } from '../../../src/pipeline/business-models';
import { defaultRunConfig } from '../../../src/pipeline/types';
import type { ModelRouter } from '../../../src/llm/types';
import { getSetting, setSetting } from '../../../src/validation/settings';
import { fetchPage } from '../../../src/tools/fetch-page';
import { testDb, unit } from '../../helpers/db';

const RUN_ID = '00000000-0000-4000-8000-0000000000bb';
const reasons = { need: 'n', nonTrivial: 't', earn: 'e', edge: 'd', evidence: 'v' };

/** The `Title:` line of a wrapped block (the block starts with `<tag>` and a newline). */
const titleIn = (prompt: string, tag: string) => {
  const block = prompt.slice(prompt.indexOf(`<${tag}>\n`), prompt.indexOf(`</${tag}>`));
  return /Title: (.*)/.exec(block)![1]!.trim();
};
/** S3 scores 3, its variant S3.5 scores 3.5: lower wins, consistently in both orders. */
const score = (title: string) => Number(title.slice(1));

type Fields = { title: string; buyer: string; problem: string; howItEarns: string; businessModel: string; edge: string; edgeKind: string; whyNotTrivial: string; earnOrSave: string; signalIds: string[]; libraryItemIds: string[] };
type EvolveAnswer = ((parent: Fields, prompt: string) => unknown) | undefined;

/**
 * A router for evolve (stage `ideate`) and the judge. By default each parent becomes a `sharpen` variant titled
 * `<parent>.5` with the parent's signals; `answer` overrides per parent (return an Error to make the call fail).
 */
function stubRouter(parents: Map<string, Fields>, o: { answer?: EvolveAnswer; judgeFails?: boolean } = {}) {
  const evolvePrompts: string[] = [];
  const judgePrompts: string[] = [];
  let embeds = 0;
  const router = {
    async structured(stage: string, req: { prompt: string; schema: { parse: (v: unknown) => unknown } }, ctx: { promptVersion: string }) {
      if (stage === 'judge') {
        judgePrompts.push(req.prompt);
        if (o.judgeFails) throw new Error('judge down');
        const a = score(titleIn(req.prompt, 'sketch-a')), b = score(titleIn(req.prompt, 'sketch-b'));
        return { winner: a < b ? 'A' : 'B', confidence: 2, reasons };
      }
      if (stage !== 'ideate' || ctx.promptVersion !== 'evolve.v1') throw new Error(`unexpected ${stage} ${ctx.promptVersion}`);
      evolvePrompts.push(req.prompt);
      const parent = parents.get(titleIn(req.prompt, 'sketch'))!;
      const custom = o.answer?.(parent, req.prompt);
      if (custom instanceof Error) throw custom;
      const raw = custom ?? { operator: 'sharpen', sketch: { ...parent, title: `${parent.title}.5` } };
      return req.schema.parse(raw);
    },
    async embed(texts: string[]) {
      return texts.map(() => unit(1000 + (embeds++ % 500)));
    },
    modelFor: () => 'm',
  } as unknown as ModelRouter;
  return { router, evolvePrompts, judgePrompts };
}

async function setup(n: number, o: { db?: Db; cell?: (i: number) => string; model?: (i: number) => string } = {}) {
  const db = o.db ?? await testDb();
  const config = defaultRunConfig({ seedType: 'open' });
  await db.insert(runs).values({ id: RUN_ID, config, status: 'running' }).onConflictDoNothing();
  await db.insert(lenses).values({ id: 'l1', name: 'L', pattern: 'p', promptHint: 'h' }).onConflictDoNothing();
  const sig = await db.insert(signals).values(Array.from({ length: n + 2 }, (_, i) => ({
    marketId: 'ca-us', source: 'hn', url: `https://x.test/${i}`, title: `t${i}`, quote: `quote ${i}`, quoteHash: `h${i}`, voice: 'operator' as const,
  }))).returning({ id: signals.id });
  const signalIds = sig.map((s) => s.id);
  const ids: string[] = [];
  const parents = new Map<string, Fields>();
  for (let i = 0; i < n; i++) {
    const f: Fields = {
      title: `S${i}`, buyer: 'Landlords', problem: `problem ${i}`, howItEarns: 'subscription', businessModel: o.model?.(i) ?? 'subscription',
      edge: 'beats Buildium', edgeKind: 'workflow', whyNotTrivial: 'needs data', earnOrSave: 'earn', signalIds: [signalIds[i]!], libraryItemIds: [],
    };
    const [r] = await db.insert(sketches).values({
      runId: RUN_ID, lensId: 'l1', ...f, edgeKind: 'workflow', status: 'kept', cell: o.cell?.(i) ?? `c${i}`,
      embedding: unit(i), createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
    }).returning({ id: sketches.id });
    ids.push(r!.id);
    parents.set(f.title, f);
  }
  const logs: string[] = [];
  const run = { id: RUN_ID, config };
  const deps = (router: ModelRouter) => ({ db, router, sources: [], fetchPage, log: (m: string) => { logs.push(m); } });
  // The tournament stage's output (Ruling R1): its ratings rank S0 first.
  const ratings = Object.fromEntries(ids.map((id, i) => [id, 1300 - i * 10]));
  const input = { sketchIds: ids, signalIds, ratings, matches: 0, spentUsd: 0, extra: 'kept' };
  return { db, ids, parents, logs, run, deps, input, signalIds };
}

const variantsOf = (db: Db) => db.select().from(sketches).where(and(eq(sketches.runId, RUN_ID), isNotNull(sketches.parentSketchId)));
const elos = async (db: Db) => new Map((await db.select({ id: sketches.id, elo: sketches.elo }).from(sketches)).map((r) => [r.id, r.elo]));

async function startup(db: Db, o: { name: string; vec: number[]; dossier?: boolean; status?: 'active' | 'rejected' }) {
  const [r] = await db.insert(knowledgeItems).values({
    kind: 'startup', title: o.name, summary: `${o.name} sells software`, audience: 'business', countries: [], industries: [],
    facts: { name: o.name, whatItDoes: 'rent tools', businessModel: 'subscription', outcome: 'active', ...(o.dossier ? { dossierStatus: 'done', dossierAt: '2026-11-01T00:00:00Z', whoPays: 'landlords', priceRange: '$50-$200/mo' } : {}) },
    contentHash: `st-${o.name}`, embedding: o.vec, status: o.status ?? 'active',
  }).returning({ id: knowledgeItems.id });
  return r!.id;
}
async function pricing(db: Db, product: string, createdAt?: Date) {
  const [r] = await db.insert(knowledgeItems).values({
    kind: 'pricing', title: `${product} pricing`, summary: 's', audience: 'business', countries: [], industries: [],
    facts: { product, pricePoints: [{ amount: 50, currency: 'USD', unit: 'month' }], buyer: 'landlords', complaints: [] },
    contentHash: `pr-${product}-${createdAt?.getTime() ?? 0}`, ...(createdAt ? { createdAt } : {}),
  }).returning({ id: knowledgeItems.id });
  return r!.id;
}
const mix = (a: number, b: number) => { const v = unit(0).map((x) => x * a); v[1] = b; return v; };

describe('nearestComps', () => {
  it('prefers startups with a dossier, by cosine, skips inactive ones and adds their pricing by product name', async () => {
    const db = await testDb();
    const plain = await startup(db, { name: 'Plain', vec: unit(0) });
    const near = await startup(db, { name: 'Rentify', vec: mix(0.8, 0.6), dossier: true });
    const far = await startup(db, { name: 'Leasely', vec: mix(0.6, 0.8), dossier: true });
    await startup(db, { name: 'Gone', vec: unit(0), status: 'rejected' });
    const pro = await pricing(db, 'Rentify Pro');
    const exact = await pricing(db, 'rentify');
    await pricing(db, 'Rentifyer'); // another product, not Rentify's
    await pricing(db, 'Other');

    const two = await nearestComps(db, unit(0), 2);
    expect(two.map((c) => c.id)).toEqual([near, far]);
    expect(two[0]!.dossier).toBe(true);
    expect(two[0]!.pricing.map((p) => p.id).sort()).toEqual([pro, exact].sort());
    expect(two[1]!.pricing).toEqual([]);

    const three = await nearestComps(db, unit(0), 3);
    expect(three.map((c) => c.id)).toEqual([near, far, plain]);
  });

  it('prefers the nearest dossier entry globally, even behind many nearer entries without one (Ruling R8)', async () => {
    const db = await testDb();
    for (let i = 0; i < 6; i++) await startup(db, { name: `Plain${i}`, vec: mix(1, i * 0.01) });
    const remote = await startup(db, { name: 'Remote', vec: mix(0.1, 0.99), dossier: true });
    const one = await nearestComps(db, unit(0), 1);
    expect(one.map((c) => c.id)).toEqual([remote]);
    const two = await nearestComps(db, unit(0), 2);
    expect(two[0]!.id).toBe(remote);
    expect(two[1]!.name).toBe('Plain0');
  });

  it('shows the newest pricing entries first (Ruling R10)', async () => {
    const db = await testDb();
    await startup(db, { name: 'Rentify', vec: unit(0), dossier: true });
    const at = (d: number) => new Date(Date.UTC(2026, 0, d));
    const oldest = await pricing(db, 'Rentify', at(1));
    const newer = [await pricing(db, 'Rentify', at(2)), await pricing(db, 'Rentify', at(3)), await pricing(db, 'Rentify', at(4))];
    const [c] = await nearestComps(db, unit(0), 1);
    expect(c!.pricing.map((p) => p.id)).toEqual([...newer].reverse());
    expect(c!.pricing.map((p) => p.id)).not.toContain(oldest);
  });
});

describe('evolve', () => {
  it('stores each variant with its lineage, operator, cell and embedding, and shows sketch, comps and other titles', async () => {
    const t = await setup(3);
    const comp = await startup(t.db, { name: 'Rentify', vec: unit(0), dossier: true });
    const r = stubRouter(t.parents, { answer: (p) => (p.title === 'S1' ? { operator: 'combine', sketch: { ...p, title: 'S1.5', buyer: 'Freelance property managers', businessModel: 'usage', edgeKind: 'data' } } : undefined) });
    const out = await evolve(t.deps(r.router), t.run, t.input);
    expect(out.variants).toBe(3);
    const vs = await variantsOf(t.db);
    expect(vs).toHaveLength(3);
    const v1 = vs.find((v) => v.title === 'S1.5')!;
    expect(v1).toMatchObject({ parentSketchId: t.ids[1], operator: 'combine', status: 'kept', runId: RUN_ID, lensId: 'l1', cell: 'prosumer|data|usage' });
    expect(v1.embedding).toHaveLength(1536);
    expect(vs.find((v) => v.title === 'S0.5')).toMatchObject({ operator: 'sharpen', cell: 'business|workflow|subscription' });

    const p0 = r.evolvePrompts.find((p) => titleIn(p, 'sketch') === 'S0')!;
    expect(p0).toContain('<comps>\n');
    expect(p0).toContain('Rentify');
    expect(p0).toContain(comp);
    expect(p0).toContain('<other-sketches>\n');
    expect(p0).toContain('S1');
    expect(p0).toContain('S2');
    expect(p0).toContain('quote 0');
    // Ruling R9: further harvest signals the variant may add, wrapped, not the parent's own.
    const more = p0.slice(p0.indexOf('<harvest-signals>\n'), p0.indexOf('</harvest-signals>'));
    expect(more).toContain(t.signalIds[4]);
    expect(more).toContain('quote 3');
    expect(more).not.toContain('quote 0');
  });

  it('discards a variant that drops a parent signal or cites a signal outside the harvest', async () => {
    const t = await setup(3);
    const r = stubRouter(t.parents, {
      answer: (p) => {
        if (p.title === 'S0') return { operator: 'sharpen', sketch: { ...p, title: 'S0.5', signalIds: [t.signalIds[1]!] } };
        if (p.title === 'S1') return { operator: 'sharpen', sketch: { ...p, title: 'S1.5', signalIds: [...p.signalIds, '00000000-0000-4000-8000-00000000dead'] } };
        // A superset from the same harvest is fine.
        return { operator: 'simplify', sketch: { ...p, title: 'S2.5', signalIds: [...p.signalIds, t.signalIds[4]!] } };
      },
    });
    const out = await evolve(t.deps(r.router), t.run, t.input);
    const vs = await variantsOf(t.db);
    expect(vs.map((v) => v.title)).toEqual(['S2.5']);
    expect(vs[0]!.signalIds).toEqual([t.signalIds[2], t.signalIds[4]]);
    expect(out.variants).toBe(1);
    expect(t.logs.some((l) => /discard/i.test(l))).toBe(true);
  });

  it('evolves only the top EVOLVE_TOP, and every sketch when there are fewer', async () => {
    const t = await setup(8);
    const r = stubRouter(t.parents);
    const out = await evolve(t.deps(r.router), t.run, t.input);
    expect(r.evolvePrompts.map((p) => titleIn(p, 'sketch'))).toEqual(['S0', 'S1', 'S2', 'S3', 'S4', 'S5']);
    expect(out.variants).toBe(EVOLVE_TOP);

    const few = await setup(3);
    const r2 = stubRouter(few.parents);
    const out2 = await evolve(few.deps(r2.router), few.run, few.input);
    expect(r2.evolvePrompts).toHaveLength(3);
    expect(out2.variants).toBe(3);
  });

  it('an evolve call failure keeps the parent alone', async () => {
    const t = await setup(3);
    const r = stubRouter(t.parents, { answer: (p) => (p.title === 'S1' ? new Error('model down') : undefined) });
    const out = await evolve(t.deps(r.router), t.run, t.input);
    expect((await variantsOf(t.db)).map((v) => v.parentSketchId).sort()).toEqual([t.ids[0], t.ids[2]].sort());
    expect(out.variants).toBe(2);
    expect(out.sketchIds).toContain(t.ids[1]);
    expect(t.logs.some((l) => /S1|evolve/.test(l) && /fail/.test(l))).toBe(true);
  });

  it('appends the comp startup ids to dossiers.priority, deduplicated and capped at 50 (newest kept)', async () => {
    const t = await setup(1);
    const a = await startup(t.db, { name: 'Alpha', vec: unit(0) });
    const b = await startup(t.db, { name: 'Beta', vec: mix(0.9, 0.1) });
    const old = Array.from({ length: 49 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    await setSetting(t.db, 'dossiers.priority', [...old, a]);
    await evolve(t.deps(stubRouter(t.parents).router), t.run, t.input);
    const p = (await getSetting(t.db, 'dossiers.priority')) as string[];
    expect(p).toHaveLength(50);
    expect(new Set(p).size).toBe(50);
    expect(p).toContain(a);
    expect(p).toContain(b);
    expect(p.slice(-2).sort()).toEqual([a, b].sort());
    expect(p).not.toContain(old[0]);
  });

  it('plays the final phase from the main-stage ratings (never stored elo), variants at their parent rating', async () => {
    const t = await setup(1);
    // A stored elo from somewhere else must be ignored (Ruling R7): the input ratings are the start.
    await t.db.update(sketches).set({ elo: 999 }).where(eq(sketches.id, t.ids[0]!));
    const r = stubRouter(t.parents, { answer: (p) => ({ operator: 'sharpen', sketch: { ...p, title: 'S-1' } }) });
    const out = await evolve(t.deps(r.router), t.run, t.input);
    const ms = await t.db.select().from(tournamentMatches).where(eq(tournamentMatches.runId, RUN_ID));
    expect(ms.length).toBeGreaterThan(0);
    expect(ms.every((m) => m.phase === 'final')).toBe(true);
    const [v] = await variantsOf(t.db);
    // Both start at 1300: the variant wins one match, +12 each way.
    const e = await elos(t.db);
    expect(e.get(v!.id)).toBeCloseTo(1312, 6);
    expect(e.get(t.ids[0]!)).toBeCloseTo(1288, 6);
    expect(out.sketchIds).toEqual([v!.id, t.ids[0]]);
  });

  it('returns the top by Elo under the caps, with the input passed on (Ruling R1)', async () => {
    // Cells as the archive files them; a variant keeps its parent's buyer, edge kind and model, so its cell.
    const t = await setup(8, { cell: (i) => `business|workflow|${BUSINESS_MODELS[i % 4]}`, model: (i) => BUSINESS_MODELS[i % 4]! });
    const out = await evolve(t.deps(stubRouter(t.parents).router), t.run, t.input);
    expect(out).toMatchObject({ signalIds: t.signalIds, extra: 'kept', ratings: t.input.ratings, variants: 6 });
    // 14 sketches in 4 cells (and 4 models): the caps (2 each) leave 8.
    expect(out.sketchIds).toHaveLength(8);
    const rows = await t.db.select({ id: sketches.id, cell: sketches.cell, bm: sketches.businessModel }).from(sketches);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const perCell = new Map<string, number>();
    for (const id of out.sketchIds) perCell.set(byId.get(id)!.cell!, (perCell.get(byId.get(id)!.cell!) ?? 0) + 1);
    expect(Math.max(...perCell.values())).toBeLessThanOrEqual(2);
  });

  it('re-run after a crash past the final: same Elo and top 12, no call re-paid, no duplicate variants (Ruling R7)', async () => {
    const t = await setup(8);
    const first = stubRouter(t.parents);
    const out1 = await evolve(t.deps(first.router), t.run, t.input);
    expect(first.judgePrompts.length).toBeGreaterThan(0);
    const elo1 = await elos(t.db);
    // The worker dies before the stage output is stored: the stage runs again on the same input.
    const second = stubRouter(t.parents);
    const out2 = await evolve(t.deps(second.router), t.run, t.input);
    expect(second.evolvePrompts).toHaveLength(0);
    expect(second.judgePrompts).toHaveLength(0);
    expect(await elos(t.db)).toEqual(elo1);
    expect(out2.sketchIds).toEqual(out1.sketchIds);
    expect(out2.variants).toBe(out1.variants);
    expect(await variantsOf(t.db)).toHaveLength(6);
  });

  it('re-run after a crash past the final with a failed call: the parent is not asked again (I1)', async () => {
    const t = await setup(3);
    const first = stubRouter(t.parents, { answer: (p) => (p.title === 'S1' ? new Error('model down') : undefined) });
    const out1 = await evolve(t.deps(first.router), t.run, t.input);
    const elo1 = await elos(t.db);
    const second = stubRouter(t.parents);
    const out2 = await evolve(t.deps(second.router), t.run, t.input);
    expect(second.evolvePrompts).toHaveLength(0);
    expect(second.judgePrompts).toHaveLength(0);
    expect(await elos(t.db)).toEqual(elo1);
    expect(out2.sketchIds).toEqual(out1.sketchIds);
    expect(out2.variants).toBe(2);
  });

  it('re-run after a crash before the final: a failed or discarded call is not asked again', async () => {
    const t = await setup(3);
    const first = stubRouter(t.parents, {
      answer: (p) => (p.title === 'S1' ? new Error('model down') : p.title === 'S2' ? { operator: 'sharpen', sketch: { ...p, title: 'S2.5', signalIds: [] } } : undefined),
    });
    await evolve(t.deps(first.router), t.run, t.input);
    await t.db.delete(tournamentMatches).where(eq(tournamentMatches.runId, RUN_ID));
    const second = stubRouter(t.parents);
    const out = await evolve(t.deps(second.router), t.run, t.input);
    expect(second.evolvePrompts).toHaveLength(0);
    expect(out.variants).toBe(1);
    expect(await variantsOf(t.db)).toHaveLength(1);
  });

  it('re-run after a crash between evolve calls reuses stored variants and only asks for the missing ones', async () => {
    const t = await setup(3);
    await evolve(t.deps(stubRouter(t.parents).router), t.run, t.input);
    // Rewind to the state of a worker that died after S0 and S1 were asked, before S2 and the final.
    await t.db.delete(tournamentMatches).where(eq(tournamentMatches.runId, RUN_ID));
    await t.db.delete(sketches).where(eq(sketches.parentSketchId, t.ids[2]!));
    await setSetting(t.db, evolveAttemptedKey(RUN_ID), [t.ids[0], t.ids[1]]);
    const second = stubRouter(t.parents);
    const out = await evolve(t.deps(second.router), t.run, t.input);
    expect(second.evolvePrompts.map((p) => titleIn(p, 'sketch'))).toEqual(['S2']);
    expect(out.variants).toBe(3);
    expect(await variantsOf(t.db)).toHaveLength(3);
  });

  it('with no sketches returns an empty list without calls', async () => {
    const t = await setup(0);
    const r = stubRouter(t.parents);
    const out = await evolve(t.deps(r.router), t.run, { ...t.input, sketchIds: [] });
    expect(out).toMatchObject({ sketchIds: [], variants: 0, extra: 'kept' });
    expect(r.evolvePrompts).toHaveLength(0);
    expect(r.judgePrompts).toHaveLength(0);
  });

  it('over the engine budget, skips evolving and the final tournament and passes the main top on', async () => {
    const t = await setup(3);
    await t.db.insert(llmCalls).values({
      runId: RUN_ID, stage: 'judge', provider: 'openai', model: 'gpt-6-sol', inputTokens: 1, outputTokens: 1, searchRequests: 0,
      costUsd: '8.10', latencyMs: 1, promptVersion: 'judge.v1', ok: true,
    });
    const r = stubRouter(t.parents);
    const out = await evolve(t.deps(r.router), t.run, t.input);
    expect(r.evolvePrompts).toHaveLength(0);
    expect(r.judgePrompts).toHaveLength(0);
    expect(out).toMatchObject({ sketchIds: t.ids, variants: 0 });
    expect(t.logs.some((l) => /budget/.test(l))).toBe(true);
  });
});
