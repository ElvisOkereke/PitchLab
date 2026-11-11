import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Db } from '../../../src/db/client';
import { judgePairs, knowledgeItems, lenses, llmCalls, runs, signals, sketches, tournamentMatches } from '../../../src/db/schema';
import { JUDGE_CALLS_MAX, SWISS_ROUNDS } from '../../../src/pipeline/engine/kinds';
import { runTournament, tournament } from '../../../src/pipeline/engine/tournament';
import { defaultRunConfig } from '../../../src/pipeline/types';
import type { ModelRouter } from '../../../src/llm/types';
import { fetchPage } from '../../../src/tools/fetch-page';
import { syncJudgePairs } from '../../../src/audit/judge-pairs';
import { insertCase, insertIdea, testDb } from '../../helpers/db';
import { fakeRouter } from '../../helpers/fake-router';

const RUN_ID = '00000000-0000-4000-8000-0000000000aa';
const reasons = { need: 'n', nonTrivial: 't', earn: 'e', edge: 'd', evidence: 'v' };
const titleIn = (prompt: string, tag: string) => {
  // The wrapped block (the prompt's rules also name the tags, but never followed by a newline).
  const block = prompt.slice(prompt.indexOf(`<${tag}>\n`), prompt.indexOf(`</${tag}>`));
  return /Title: (.*)/.exec(block)![1]!.trim();
};

/** A judge router that answers from the prompt: the lower title number wins (consistently in both orders). */
function stubJudge(o: { fail?: boolean } = {}) {
  const prompts: string[] = [];
  const router = {
    async structured(stage: string, req: { prompt: string }) {
      if (stage !== 'judge') throw new Error(`unexpected stage ${stage}`);
      prompts.push(req.prompt);
      if (o.fail) throw new Error('judge down');
      const a = Number(titleIn(req.prompt, 'sketch-a').slice(1)), b = Number(titleIn(req.prompt, 'sketch-b').slice(1));
      return { winner: a < b ? 'A' : 'B', confidence: 2, reasons };
    },
    modelFor: () => 'gpt-6-sol',
  } as unknown as ModelRouter;
  return { router, prompts };
}

async function setup(n: number, o: { cell?: (i: number) => string; model?: (i: number) => string; db?: Db } = {}) {
  const db = o.db ?? await testDb();
  await db.insert(runs).values({ id: RUN_ID, config: defaultRunConfig({ seedType: 'open' }), status: 'running' }).onConflictDoNothing();
  await db.insert(lenses).values({ id: 'l1', name: 'L', pattern: 'p', promptHint: 'h' }).onConflictDoNothing();
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const [r] = await db.insert(sketches).values({
      runId: RUN_ID, lensId: 'l1', title: `S${i}`, buyer: 'Landlords', problem: `problem ${i}`, howItEarns: 'h',
      businessModel: o.model?.(i) ?? `m${i}`, edge: 'e', edgeKind: 'workflow', whyNotTrivial: 'w', earnOrSave: 'earn',
      signalIds: [], libraryItemIds: [], status: 'kept', cell: o.cell?.(i) ?? `c${i % 4}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
    }).returning({ id: sketches.id });
    ids.push(r!.id);
  }
  const logs: string[] = [];
  const run = { id: RUN_ID, config: defaultRunConfig({ seedType: 'open' }) };
  const deps = (router: ModelRouter) => ({ db, router, sources: [], fetchPage, log: (m: string) => { logs.push(m); } });
  return { db, ids, logs, run, deps };
}
const elos = async (db: Db) => new Map((await db.select({ id: sketches.id, elo: sketches.elo }).from(sketches)).map((r) => [r.id, r.elo]));

describe('runTournament', () => {
  it('judges every pair twice with the order swapped, then updates Elo', async () => {
    const t = await setup(2);
    const router = fakeRouter({ structured: { judge: [{ winner: 'A', confidence: 3, reasons }, { winner: 'B', confidence: 1, reasons }] } });
    const ratings = await runTournament(t.deps(router), t.run, { phase: 'main', sketchIds: t.ids, rounds: 1, maxCalls: 10 });
    expect(router.calls).toHaveLength(2);
    const [ab, ba] = router.calls.map((c) => c.prompt);
    const first = titleIn(ab!, 'sketch-a'), second = titleIn(ab!, 'sketch-b');
    expect(titleIn(ba!, 'sketch-a')).toBe(second);
    expect(titleIn(ba!, 'sketch-b')).toBe(first);
    // The first-shown sketch of call 1 won both calls.
    const winner = t.ids[Number(first.slice(1))]!, loser = t.ids[Number(second.slice(1))]!;
    expect(ratings.get(winner)).toBe(1212);
    expect(ratings.get(loser)).toBe(1188);
    expect((await elos(t.db)).get(winner)).toBe(1212);
    const [m] = await t.db.select().from(tournamentMatches);
    expect(m).toMatchObject({ runId: RUN_ID, phase: 'main', round: 1, aId: winner, bId: loser, verdictAB: 'a', verdictBA: 'b', result: 'a', confidence: 2 });
    expect(m!.reasons).toMatchObject({ ab: reasons, ba: reasons });
  });

  it('an error verdict gives a draw and a log line', async () => {
    const t = await setup(2);
    const router = fakeRouter({ structured: { judge: [{ junk: true }, { winner: 'A', confidence: 2, reasons }] } });
    const ratings = await runTournament(t.deps(router), t.run, { phase: 'main', sketchIds: t.ids, rounds: 1, maxCalls: 10 });
    expect([...ratings.values()]).toEqual([1200, 1200]);
    const [m] = await t.db.select().from(tournamentMatches);
    expect(m).toMatchObject({ verdictAB: 'error', verdictBA: 'a', result: 'draw' });
    expect(t.logs.some((l) => /judge error/.test(l) && /draw/.test(l))).toBe(true);
  });

  it('stops at maxCalls (a pair needs two calls)', async () => {
    const t = await setup(20);
    const j = stubJudge();
    await runTournament(t.deps(j.router), t.run, { phase: 'main', sketchIds: t.ids, rounds: 5, maxCalls: 11 });
    expect(j.prompts).toHaveLength(10);
    expect(await t.db.select().from(tournamentMatches)).toHaveLength(5);
    expect(t.logs.some((l) => /budget/.test(l))).toBe(true);
  });

  it('plays 5 Swiss rounds of 20 with no rematch', async () => {
    const t = await setup(20);
    const j = stubJudge();
    await runTournament(t.deps(j.router), t.run, { phase: 'main', sketchIds: t.ids, rounds: SWISS_ROUNDS, maxCalls: JUDGE_CALLS_MAX });
    const ms = await t.db.select().from(tournamentMatches);
    expect(ms).toHaveLength(50);
    expect(j.prompts).toHaveLength(100);
    expect(new Set(ms.map((m) => [m.aId, m.bId].sort().join('|'))).size).toBe(50);
    // The consistent judge ranks S0 first.
    const final = await elos(t.db);
    expect(Math.max(...[...final.values()].map(Number))).toBe(final.get(t.ids[0]!));
  });

  it('starts from a stored elo (Ruling R3) and from an explicit start', async () => {
    const t = await setup(2);
    await t.db.update(sketches).set({ elo: 1300 }).where(eq(sketches.id, t.ids[1]!));
    const router = fakeRouter({ structured: { judge: [{ junk: 1 }, { junk: 1 }] } });
    const ratings = await runTournament(t.deps(router), t.run, { phase: 'main', sketchIds: t.ids, rounds: 1, maxCalls: 10 });
    // A draw against a lower rating loses points.
    expect(ratings.get(t.ids[1]!)).toBeLessThan(1300);
    expect(ratings.get(t.ids[0]!)).toBeGreaterThan(1200);
  });

  it('resume: an interrupted tournament finishes with the same pairs and Elo as an uninterrupted one, without re-paying', async () => {
    const whole = await setup(20);
    await runTournament(whole.deps(stubJudge().router), whole.run, { phase: 'main', sketchIds: whole.ids, rounds: 5, maxCalls: 300 });
    const wholeElo = [...(await elos(whole.db))].map(([id, e]) => [whole.ids.indexOf(id), e]).sort();
    const wholePairs = (await whole.db.select().from(tournamentMatches)).map((m) => `${m.round}:${whole.ids.indexOf(m.aId)}-${whole.ids.indexOf(m.bId)}`).sort();

    const part = await setup(20);
    const first = stubJudge();
    await runTournament(part.deps(first.router), part.run, { phase: 'main', sketchIds: part.ids, rounds: 5, maxCalls: 30 });
    expect(first.prompts).toHaveLength(30);
    // The worker restarts: the stage resets ratings to their pre-phase value (null), then replays.
    await part.db.update(sketches).set({ elo: null });
    const second = stubJudge();
    await runTournament(part.deps(second.router), part.run, { phase: 'main', sketchIds: part.ids, rounds: 5, maxCalls: 300 });
    expect(second.prompts).toHaveLength(70);
    const partElo = [...(await elos(part.db))].map(([id, e]) => [part.ids.indexOf(id), e]).sort();
    const partPairs = (await part.db.select().from(tournamentMatches)).map((m) => `${m.round}:${part.ids.indexOf(m.aId)}-${part.ids.indexOf(m.bId)}`).sort();
    expect(partPairs).toEqual(wholePairs);
    expect(partElo).toEqual(wholeElo);
  });

  it('pairing depends only on the set: a reordered sketch list replays every stored match (no re-pay, nothing dropped)', async () => {
    const t = await setup(12);
    await runTournament(t.deps(stubJudge().router), t.run, { phase: 'main', sketchIds: t.ids, rounds: 3, maxCalls: 300 });
    const before = (await t.db.select().from(tournamentMatches)).map((m) => m.id).sort();
    const elo1 = await elos(t.db);
    await t.db.update(sketches).set({ elo: null });
    const again = fakeRouter({});
    await runTournament(t.deps(again), t.run, { phase: 'main', sketchIds: [...t.ids].reverse(), rounds: 3, maxCalls: 300 });
    expect(again.calls).toHaveLength(0);
    expect((await t.db.select().from(tournamentMatches)).map((m) => m.id).sort()).toEqual(before);
    expect(await elos(t.db)).toEqual(elo1);
    expect(t.logs.some((l) => /removed/.test(l))).toBe(false);
  });

  it('final phase avoids pairs already played in the main phase', async () => {
    const t = await setup(4);
    await runTournament(t.deps(stubJudge().router), t.run, { phase: 'main', sketchIds: t.ids, rounds: 1, maxCalls: 10 });
    const main = (await t.db.select().from(tournamentMatches)).map((m) => [m.aId, m.bId].sort().join('|'));
    await runTournament(t.deps(stubJudge().router), t.run, { phase: 'final', sketchIds: t.ids, rounds: 1, maxCalls: 10 });
    const final = (await t.db.select().from(tournamentMatches).where(eq(tournamentMatches.phase, 'final'))).map((m) => [m.aId, m.bId].sort().join('|'));
    expect(final).toHaveLength(2);
    for (const k of final) expect(main).not.toContain(k);
  });

  it('shows the strength labels of cited signals and library entries in the judge prompt', async () => {
    const t = await setup(2);
    const assessment = { directness: 'first_hand', bias: null, strength: 4, why: 'w', corroboration: 0 };
    const [item] = await t.db.insert(knowledgeItems).values({
      kind: 'pricing', title: 'Rent tool pricing', summary: 's', audience: 'business', countries: [], industries: [], facts: {}, contentHash: 'k1',
      assessment: { ...assessment, strength: 2, directness: 'vendor' },
    }).returning({ id: knowledgeItems.id });
    const [promoted] = await t.db.insert(knowledgeItems).values({
      kind: 'problem', title: 'Landlord pain', summary: 's', audience: 'business', countries: [], industries: [], facts: {}, contentHash: 'k2', assessment,
    }).returning({ id: knowledgeItems.id });
    const sig = await t.db.insert(signals).values([
      { marketId: 'ca-us', source: 'hn', url: 'https://x.test/a', title: 'a', quote: 'late rent kills us', quoteHash: 'ha', voice: 'operator', knowledgeItemId: promoted!.id },
      { marketId: 'ca-us', source: 'hn', url: 'https://x.test/b', title: 'b', quote: 'no assessment here', quoteHash: 'hb', voice: 'vendor' },
    ]).returning({ id: signals.id });
    await t.db.update(sketches).set({ signalIds: sig.map((s) => s.id), libraryItemIds: [item!.id] }).where(eq(sketches.id, t.ids[0]!));
    const j = stubJudge();
    await runTournament(t.deps(j.router), t.run, { phase: 'main', sketchIds: t.ids, rounds: 1, maxCalls: 10 });
    const p = j.prompts[0]!;
    expect(p).toContain('strength 4/5, first-hand');
    expect(p).toContain('late rent kills us');
    expect(p).toContain('vendor voice');
    expect(p).toContain('strength 2/5, vendor');
    expect(p).toContain('Rent tool pricing');
  });
});

describe('tournament stage', () => {
  it('returns the top 12 by Elo with the input passed on and the judge spend', async () => {
    const t = await setup(20, { cell: (i) => `c${i % 10}` }); // 10 cells: the caps leave room for 12
    await t.db.insert(llmCalls).values({
      runId: RUN_ID, stage: 'judge', provider: 'openai', model: 'gpt-6-sol', inputTokens: 1, outputTokens: 1, searchRequests: 0,
      costUsd: '0.25', latencyMs: 1, promptVersion: 'judge.v1', ok: true,
    });
    const out = await tournament(t.deps(stubJudge().router), t.run, { sketchIds: t.ids, signalIds: ['sig'], extra: 1 });
    expect(out.sketchIds).toHaveLength(12);
    expect(out.sketchIds[0]).toBe(t.ids[0]);
    expect(out).toMatchObject({ signalIds: ['sig'], extra: 1, matches: 50, spentUsd: 0.25 });
    expect(Object.keys(out.ratings)).toHaveLength(20);
  });

  it('all calls failing still returns 12 by cell order with a warning, and does not fail', async () => {
    const t = await setup(20, { cell: (i) => `c${Math.floor(i / 3)}`, model: (i) => `m${i % 10}` });
    const out = await tournament(t.deps(stubJudge({ fail: true }).router), t.run, { sketchIds: t.ids, signalIds: [] });
    const idx = out.sketchIds.map((id) => t.ids.indexOf(id));
    expect(idx).toEqual([0, 3, 6, 9, 12, 15, 18, 1, 4, 7, 10, 13]);
    expect(t.logs.some((l) => /warning/i.test(l) && /every judge call failed/.test(l))).toBe(true);
  });

  it('resume: a second run of the stage makes 0 router calls and gives the same Elo and output', async () => {
    const t = await setup(20);
    const out1 = await tournament(t.deps(stubJudge().router), t.run, { sketchIds: t.ids, signalIds: [] });
    const elo1 = await elos(t.db);
    const again = fakeRouter({});
    const out2 = await tournament(t.deps(again), t.run, { sketchIds: t.ids, signalIds: [] });
    expect(again.calls).toHaveLength(0);
    expect(await elos(t.db)).toEqual(elo1);
    expect(out2.sketchIds).toEqual(out1.sketchIds);
    expect(out2.matches).toBe(out1.matches);
  });

  it('drops stale stored matches whose pairs are no longer played', async () => {
    const t = await setup(4);
    await tournament(t.deps(stubJudge().router), t.run, { sketchIds: t.ids, signalIds: [] });
    // The archive kept fewer sketches on a re-run: the pairs change.
    await tournament(t.deps(stubJudge().router), t.run, { sketchIds: t.ids.slice(0, 2), signalIds: [] });
    const ms = await t.db.select().from(tournamentMatches).where(and(eq(tournamentMatches.runId, RUN_ID), eq(tournamentMatches.phase, 'main')));
    expect(ms).toHaveLength(1);
  });

  it('logs when the hard caps leave fewer than 12', async () => {
    const t = await setup(20, { cell: (i) => `c${i % 5}`, model: (i) => `m${i % 3}` });
    const out = await tournament(t.deps(stubJudge().router), t.run, { sketchIds: t.ids, signalIds: [] });
    expect(out.sketchIds).toHaveLength(6);
    expect(t.logs.some((l) => /caps left 6 of 12/.test(l))).toBe(true);
  });

  it('splits new Board decisions into judge pairs at the start, so they become few-shot examples', async () => {
    const t = await setup(2);
    const kept = await insertIdea(t.db, RUN_ID, { title: 'KeptIdea' });
    await insertCase(t.db, kept.id, { stage: 'live', slug: 'kept-idea' });
    const killed = await insertIdea(t.db, RUN_ID, { title: 'KilledIdea' });
    await insertCase(t.db, killed.id, { stage: 'killed', slug: 'killed-idea' });
    expect(await t.db.select().from(judgePairs)).toHaveLength(0);
    await tournament(t.deps(stubJudge().router), t.run, { sketchIds: t.ids, signalIds: [] });
    expect(await t.db.select().from(judgePairs)).toHaveLength(1);
  });

  it('with no sketches returns an empty list without calls', async () => {
    const t = await setup(0);
    const router = fakeRouter({});
    const out = await tournament(t.deps(router), t.run, { sketchIds: [], signalIds: ['s'] });
    expect(out).toMatchObject({ sketchIds: [], signalIds: ['s'], matches: 0, spentUsd: 0 });
    expect(router.calls).toHaveLength(0);
  });
});

describe('tournament few-shot reasons', () => {
  it('writes and stores a missing pair reason once, under the run', async () => {
    const t = await setup(2);
    const kept = await insertIdea(t.db, RUN_ID, { title: 'KeptIdea' });
    await insertCase(t.db, kept.id, { stage: 'live', slug: 'kept-idea' });
    const killed = await insertIdea(t.db, RUN_ID, { title: 'KilledIdea' });
    await insertCase(t.db, killed.id, { stage: 'killed', slug: 'killed-idea' });
    await syncJudgePairs(t.db);
    await t.db.update(judgePairs).set({ split: 'train' });
    const judge = stubJudge();
    let reasonCalls = 0;
    const router = { ...judge.router, structured: judge.router.structured.bind(judge.router), modelFor: () => 'm', text: async () => { reasonCalls++; return 'because it earns more'; } } as unknown as ModelRouter;
    await runTournament(t.deps(router), t.run, { phase: 'main', sketchIds: t.ids, rounds: 1, maxCalls: 10 });
    expect(reasonCalls).toBe(1);
    expect((await t.db.select().from(judgePairs))[0]!.reason).toBe('because it earns more');
    expect(judge.prompts[0]).toContain('because it earns more');
  });
});

describe('tournament judge prompt setting', () => {
  it('uses judge.v1 by default and judge.v2 when setting judge.promptVersion says so', async () => {
    const { setSetting } = await import('../../../src/validation/settings');
    const t1 = await setup(2);
    const r1 = fakeRouter({ structured: { judge: [{ winner: 'A', confidence: 3, reasons }, { winner: 'B', confidence: 3, reasons }] } });
    await runTournament(t1.deps(r1), t1.run, { phase: 'main', sketchIds: t1.ids, rounds: 1, maxCalls: 10 });
    expect(r1.calls[0]!.prompt).not.toContain('smaller revenue ceiling');
    const t2 = await setup(2);
    await setSetting(t2.db, 'judge.promptVersion', 'v2');
    const r2 = fakeRouter({ structured: { judge: [{ winner: 'A', confidence: 3, reasons }, { winner: 'B', confidence: 3, reasons }] } });
    await runTournament(t2.deps(r2), t2.run, { phase: 'main', sketchIds: t2.ids, rounds: 1, maxCalls: 10 });
    expect(r2.calls[0]!.prompt).toContain('smaller revenue ceiling');
  });
});
