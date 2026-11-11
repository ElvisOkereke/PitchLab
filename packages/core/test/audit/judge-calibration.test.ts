import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calibrateJudge, renderJudgeReport, runJudgeAudit, writeJudgeReport, type JudgeReport } from '../../src/audit/judge-calibration';
import { fewShotPairs, syncJudgePairs } from '../../src/audit/judge-pairs';
import { FEWSHOT_PAIRS_MAX } from '../../src/pipeline/engine/kinds';
import type { Db } from '../../src/db/client';
import { ideaReviews, judgePairs } from '../../src/db/schema';
import { getSetting } from '../../src/validation/settings';
import { defaultRunConfig } from '../../src/pipeline/types';
import type { ModelRouter } from '../../src/llm/types';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';

const reasons = { need: 'n', nonTrivial: 't', earn: 'e', edge: 'd', evidence: 'v' };

/** Judge scripted by a function of the shown titles: returns which position wins. */
function scripted(pick: (a: string, b: string) => { winner: 'A' | 'B'; confidence?: number } | 'throw'): ModelRouter & { n: number } {
  const r = {
    n: 0,
    modelFor: () => 'm',
    async structured(_stage: string, req: { prompt: string; schema: { parse(x: unknown): unknown } }) {
      r.n++;
      const grab = (tag: string) => /Title: (.*)/.exec(req.prompt.slice(req.prompt.indexOf(`<${tag}>\n`)))![1]!;
      const v = pick(grab('sketch-a'), grab('sketch-b'));
      if (v === 'throw') throw new Error('boom');
      return req.schema.parse({ winner: v.winner, confidence: v.confidence ?? 2, reasons });
    },
    async text() { return 'a reason'; },
    async research() { throw new Error('no'); },
    async embed() { throw new Error('no'); },
  };
  return r as unknown as ModelRouter & { n: number };
}

/** n kept x m killed decided cases, synced into judge pairs. */
async function board(kept: number, killed: number) {
  const db = await testDb();
  const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
  const mk = async (title: string, stage: 'live' | 'killed') => {
    const i = await insertIdea(db, run.id, { title });
    await insertCase(db, i.id, { stage, slug: `c-${title}` });
    return i;
  };
  const k = [];
  for (let i = 0; i < kept; i++) k.push(await mk(`K${i}`, 'live'));
  const x = [];
  for (let i = 0; i < killed; i++) x.push(await mk(`X${i}`, 'killed'));
  await syncJudgePairs(db);
  return { db, k, x };
}
/**
 * A board of n kept x m killed ideas where only pairs among K{ex} and X{ex} are train (few-shot examples) and every
 * other pair is test.
 */
async function examplesOn(kept: number, killed: number, ex: number[]) {
  const b = await board(kept, killed);
  const exIds = new Set([...ex.map((i) => b.k[i]!.id), ...ex.map((i) => b.x[i]!.id)]);
  await b.db.update(judgePairs).set({ split: 'test' });
  for (const p of await b.db.select().from(judgePairs)) {
    if (exIds.has(p.keptIdeaId) && exIds.has(p.killedIdeaId)) await b.db.update(judgePairs).set({ split: 'train' }).where(eq(judgePairs.id, p.id));
  }
  return b;
}
/** The judge only ever sees test pairs: force every pair to the test split. */
async function allTest(db: Db) {
  await db.update(judgePairs).set({ split: 'test' });
}

describe('calibrateJudge', () => {
  it('computes accuracy and consistency from two orders per test pair', async () => {
    const { db } = await board(5, 4); // 20 pairs
    await allTest(db);
    // The judge picks the K sketch, except pairs with X0, where it always says A (position bias).
    const router = scripted((a, b) => (a === 'X0' || b === 'X0' ? { winner: 'A' } : { winner: a.startsWith('K') ? 'A' : 'B' }));
    const rep = await calibrateJudge({ db, router, log: () => {} });
    expect(rep.pairs).toBe(20);
    expect(rep.tooFew).toBe(false);
    expect(router.n).toBe(40);
    expect(rep.accuracy).toBeCloseTo(15 / 20);
    expect(rep.consistency).toBeCloseTo(15 / 20);
    expect(rep.byConfidence[2]).toEqual({ n: 20, accuracy: 0.75 });
    expect(rep.byConfidence[1].n).toBe(0);
  });

  it('is too few under 10 pairs, and stores the summary setting', async () => {
    const { db } = await board(3, 3); // 9
    await allTest(db);
    const rep = await calibrateJudge({ db, router: scripted((a) => ({ winner: a.startsWith('K') ? 'A' : 'B' })), log: () => {} });
    expect(rep.pairs).toBe(9);
    expect(rep.tooFew).toBe(true);
    const s = (await getSetting(db, 'audit.judge.latest')) as Record<string, unknown>;
    expect(s).toMatchObject({ accuracy: 1, consistency: 1, pairs: 9, tooFew: true });
    expect(typeof s.at).toBe('string');
  });

  it('only judges test pairs and honours the limit', async () => {
    const { db, k, x } = await examplesOn(6, 6, [4, 5]); // 4 train pairs among K4 K5 X4 X5; 16 test pairs clear of them
    const router = scripted((a) => ({ winner: a.startsWith('K') ? 'A' : 'B' }));
    const rep = await calibrateJudge({ db, router, log: () => {} });
    expect(rep).toMatchObject({ pairs: 16, examples: 4, excludedPairs: 16 });
    expect((await calibrateJudge({ db, router, limit: 2, log: () => {} })).pairs).toBe(2);
    expect(k.length + x.length).toBe(12);
  });

  it('an erroring judge counts as a miss and an inconsistency; no pairs gives zeros', async () => {
    const { db } = await board(3, 4);
    await allTest(db);
    const rep = await calibrateJudge({ db, router: scripted(() => 'throw'), log: () => {} });
    expect(rep).toMatchObject({ pairs: 12, accuracy: 0, consistency: 0 });
    const empty = await calibrateJudge({ db: await testDb(), router: scripted(() => 'throw'), log: () => {} });
    expect(empty).toMatchObject({ pairs: 0, accuracy: 0, consistency: 0, tooFew: true });
  });

  it('reviewerAccuracy uses the sum of reviewer dimensions as the prediction', async () => {
    const { db, k, x } = await board(3, 4);
    await allTest(db);
    const review = async (id: string, scale: number) => {
      await db.insert(ideaReviews).values({ ideaId: id, scale, edge: 1, novelty: 1, niche: 1, reasons: {}, model: 'm', promptVersion: 'idea-review.v2' });
    };
    // Sums: K0 8, K1 7, K2 6; X0 6, X1 8. Both-reviewed pairs: 3 x 2 = 6.
    await review(k[0]!.id, 5); await review(k[1]!.id, 4); await review(k[2]!.id, 3);
    await review(x[0]!.id, 3); await review(x[1]!.id, 5);
    const rep = await calibrateJudge({ db, router: scripted((a) => ({ winner: a.startsWith('K') ? 'A' : 'B' })), log: () => {} });
    // K0>X0 win, K0=X1 tie, K1>X0 win, K1<X1 loss, K2=X0 tie, K2<X1 loss: (1 + .5 + 1 + 0 + .5 + 0) / 6.
    expect(rep.reviewerAccuracy).toBeCloseTo(3 / 6);
  });
});

describe('renderJudgeReport', () => {
  const rep = (o: Partial<JudgeReport>): JudgeReport => ({
    pairs: 20, accuracy: 0.75, consistency: 0.7, byConfidence: { 1: { n: 5, accuracy: 0.4 }, 2: { n: 10, accuracy: 0.8 }, 3: { n: 5, accuracy: 1 } },
    reviewerAccuracy: 0.6, spentUsd: 0.5, tooFew: false, examples: 6, excludedPairs: 3, ...o,
  });

  it('says how many examples the judge saw and how many held-out pairs were left out', () => {
    expect(renderJudgeReport(rep({}), '2026-11-10')).toMatch(/6 few-shot example\(s\).*3 held-out pair\(s\) share an idea with an example and were left out/);
  });

  it('shows both goal lines with pass or fail', () => {
    const md = renderJudgeReport(rep({}), '2026-11-10');
    expect(md).toContain('2026-11-10');
    expect(md).toMatch(/Accuracy.*0\.75.*0\.70.*PASS/);
    expect(md).toMatch(/consistency.*0\.70.*0\.80.*FAIL/i);
    expect(md).toContain('Reviewer');
    expect(md.toLowerCase()).not.toContain('too few pairs');
  });

  it('says too few pairs under 10', () => {
    expect(renderJudgeReport(rep({ pairs: 4, tooFew: true }), '2026-11-10').toLowerCase()).toContain('too few pairs');
  });
});

describe('writeJudgeReport', () => {
  it('writes output/audit/judge-<date>.md under the directory and returns the path', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'judge-')), 'audit');
    const r: JudgeReport = { pairs: 12, accuracy: 0.8, consistency: 0.9, byConfidence: { 1: { n: 0, accuracy: 0 }, 2: { n: 12, accuracy: 0.8 }, 3: { n: 0, accuracy: 0 } }, reviewerAccuracy: null, spentUsd: 0, tooFew: false, examples: 0, excludedPairs: 0 };
    const path = writeJudgeReport(r, dir, '2026-11-10');
    expect(path).toBe(join(dir, 'judge-2026-11-10.md'));
    expect(readFileSync(path, 'utf8')).toBe(renderJudgeReport(r, '2026-11-10'));
  });
});

describe('calibration leakage and the CLI work', () => {
  it('shows the same few-shot examples as the tournament and judges only test pairs sharing no idea with them', async () => {
    const { db } = await examplesOn(5, 5, [3, 4]);
    const prompts: string[] = [];
    const base = scripted(() => ({ winner: 'A' }));
    const router = { ...base, structured: (s: string, req: { prompt: string; schema: { parse(x: unknown): unknown } }) => { prompts.push(req.prompt); return (base as never as { structured: (a: string, b: unknown) => Promise<unknown> }).structured(s, req); } } as unknown as ModelRouter;
    const rep = await calibrateJudge({ db, router, log: () => {} });
    // The tournament's examples: fewShotPairs with its defaults (FEWSHOT_PAIRS_MAX, train split only).
    const tournamentShots = await fewShotPairs(db, FEWSHOT_PAIRS_MAX);
    expect(rep.examples).toBe(tournamentShots.length);
    expect(rep.examples).toBe(4);
    expect(rep.pairs).toBe(9); // K0-K2 x X0-X2
    expect(rep.excludedPairs).toBe(12); // test pairs touching K3, K4, X3 or X4
    const shown = new Set(tournamentShots.flatMap((p) => [p.kept.title, p.killed.title]));
    expect([...shown].sort()).toEqual(['K3', 'K4', 'X3', 'X4']);
    for (const p of prompts) {
      const examples = p.slice(p.indexOf('<examples>'), p.indexOf('</examples>'));
      for (const t of shown) expect(examples).toContain(t);
      const judged = [/Title: (.*)/.exec(p.slice(p.indexOf('<sketch-a>\n')))![1]!, /Title: (.*)/.exec(p.slice(p.indexOf('<sketch-b>\n')))![1]!];
      for (const t of judged) expect(shown.has(t.trim())).toBe(false);
    }
  });

  it('runJudgeAudit writes the file under the directory and prints its path', async () => {
    const { db } = await board(4, 4);
    await allTest(db);
    const dir = join(mkdtempSync(join(tmpdir(), 'judge-cli-')), 'output', 'audit');
    const lines: string[] = [];
    const { path } = await runJudgeAudit({ db, router: scripted((a) => ({ winner: a.startsWith('K') ? 'A' : 'B' })), dir, date: '2026-11-10', out: (s) => lines.push(s), log: () => {} });
    expect(path).toBe(join(dir, 'judge-2026-11-10.md'));
    expect(readFileSync(path, 'utf8')).toContain('Judge calibration, 2026-11-10');
    expect(lines.some((l) => l === `Written to ${path}`)).toBe(true);
    expect(lines.some((l) => l.startsWith('Judged 16 pair(s)'))).toBe(true);
  });
});
