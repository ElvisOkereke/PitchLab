import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { CRITERIA } from '../../src/case/schema';
import { claims, scores } from '../../src/db/schema';
import { score } from '../../src/pipeline/score';
import { defaultRunConfig, type StageDeps } from '../../src/pipeline/types';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';
import { fakeRouter } from '../helpers/fake-router';

const aiScores = (evidence = 5) => Object.fromEntries(CRITERIA.map((c) => [c, { value: c === 'evidence' ? evidence : 4, note: `${c} note` }]));

async function setup(statuses: ('verified' | 'unsupported' | 'unreachable' | 'unverified' | 'needs_review')[]) {
  const db = await testDb();
  const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
  const idea = await insertIdea(db, run.id);
  const kase = await insertCase(db, idea.id);
  if (statuses.length)
    await db.insert(claims).values(statuses.map((verified, i) => ({ caseId: kase.id, section: 'evidence', text: `c${i}`, sourceUrl: `https://x.com/${i}`, quote: 'q', verified })));
  return { db, run, kase };
}
const depsOf = (db: unknown, router: unknown) => ({ db, router, log: () => {} }) as unknown as StageDeps;

describe('score', () => {
  it('caps evidence score when under half the claims verify', async () => {
    const { db, run, kase } = await setup(['verified', 'unsupported', 'unreachable']);
    const router = fakeRouter({ structured: { score: [aiScores(5)] }, models: { score: 'gemini-x' } });
    const out = await score(depsOf(db, router), run, { caseIds: [kase.id] });
    expect(out).toEqual({ caseIds: [kase.id] });
    const rows = await db.select().from(scores).where(eq(scores.caseId, kase.id));
    expect(rows).toHaveLength(7);
    const ev = rows.find((r) => r.criterion === 'evidence')!;
    expect(ev.value).toBe(2);
    expect(ev.note).toBe('evidence note (capped: 1/3 claims verified)');
    expect(rows.find((r) => r.criterion === 'pain')!.value).toBe(4);
    expect(rows.every((r) => r.by === 'ai' && r.model === 'gemini-x' && r.promptVersion === 'score.v1')).toBe(true);
    expect(router.calls[0]!.prompt).toContain('1/3');
  });

  it('caps at 3 when ratio is under 0.8, and does not annotate when not lowered', async () => {
    const { db, run, kase } = await setup(['verified', 'verified', 'verified', 'unsupported']);
    await score(depsOf(db, fakeRouter({ structured: { score: [aiScores(5)] } })), run, { caseIds: [kase.id] });
    let ev = (await db.select().from(scores).where(and(eq(scores.caseId, kase.id), eq(scores.criterion, 'evidence'))))[0]!;
    expect(ev.value).toBe(3);
    expect(ev.note).toBe('evidence note (capped: 3/4 claims verified)');

    await score(depsOf(db, fakeRouter({ structured: { score: [aiScores(2)] } })), run, { caseIds: [kase.id] });
    ev = (await db.select().from(scores).where(and(eq(scores.caseId, kase.id), eq(scores.criterion, 'evidence'))))[0]!;
    expect(ev.value).toBe(2);
    expect(ev.note).toBe('evidence note');
  });

  it('leaves evidence alone at ratio >= 0.8', async () => {
    const { db, run, kase } = await setup(['verified', 'verified', 'verified', 'verified', 'verified']);
    await score(depsOf(db, fakeRouter({ structured: { score: [aiScores(5)] } })), run, { caseIds: [kase.id] });
    const [ev] = await db.select().from(scores).where(and(eq(scores.caseId, kase.id), eq(scores.criterion, 'evidence')));
    expect(ev).toMatchObject({ value: 5, note: 'evidence note' });
  });

  it('treats zero claims as ratio 0', async () => {
    const { db, run, kase } = await setup([]);
    await score(depsOf(db, fakeRouter({ structured: { score: [aiScores(5)] } })), run, { caseIds: [kase.id] });
    const [ev] = await db.select().from(scores).where(and(eq(scores.caseId, kase.id), eq(scores.criterion, 'evidence')));
    expect(ev).toMatchObject({ value: 2, note: 'evidence note (capped: 0/0 claims verified)' });
  });

  it('caps evidence on evidence and numbers claims only, and reports signal and competitor checks', async () => {
    const { db, run, kase } = await setup(['verified', 'verified']);
    await db.insert(claims).values([
      { caseId: kase.id, section: 'numbers', text: 'reachableBuyers: 3000', sourceUrl: 'https://n.com', quote: 'q', verified: 'verified' },
      { caseId: kase.id, section: 'signal', text: 's1', sourceUrl: 'https://s.com/1', quote: 's1', verified: 'unsupported' },
      { caseId: kase.id, section: 'signal', text: 's2', sourceUrl: 'https://s.com/2', quote: 's2', verified: 'verified' },
      { caseId: kase.id, section: 'competitor', text: 'Acme: $5', sourceUrl: 'https://acme.com', quote: null, verified: 'unreachable' },
    ]);
    const router = fakeRouter({ structured: { score: [aiScores(5)] } });
    await score(depsOf(db, router), run, { caseIds: [kase.id] });
    const [ev] = await db.select().from(scores).where(and(eq(scores.caseId, kase.id), eq(scores.criterion, 'evidence')));
    expect(ev).toMatchObject({ value: 5, note: 'evidence note' });
    const prompt = router.calls[0]!.prompt;
    expect(prompt).toContain('3/3 cited claims verified');
    expect(prompt).toContain('1/2 harvested signal links verified');
    expect(prompt).toContain('0/1 competitor links verified');
  });

  it('treats needs_review as non-credit in the evidence ratio and reports it separately', async () => {
    const { db, run, kase } = await setup(['verified', 'needs_review', 'needs_review', 'unsupported']);
    await db.insert(claims).values([
      { caseId: kase.id, section: 'competitor', text: 'Acme', sourceUrl: 'https://acme.com', quote: null, verified: 'needs_review' },
      { caseId: kase.id, section: 'competitor-pricing', text: 'Acme pricing: $5', sourceUrl: 'https://acme.com', quote: null, verified: 'verified' },
    ]);
    const router = fakeRouter({ structured: { score: [aiScores(5)] } });
    await score(depsOf(db, router), run, { caseIds: [kase.id] });
    const [ev] = await db.select().from(scores).where(and(eq(scores.caseId, kase.id), eq(scores.criterion, 'evidence')));
    expect(ev).toMatchObject({ value: 2, note: 'evidence note (capped: 1/4 claims verified)' });
    const prompt = router.calls[0]!.prompt;
    expect(prompt).toContain('1/4 cited claims verified');
    expect(prompt).toContain('2 left for the owner to check (checker unsure)');
    expect(prompt).toContain('1 not supported by the page');
    expect(prompt).toContain('0/1 competitor links verified (1 left for the owner to check)');
    expect(prompt).toContain('1/1 quoted competitor prices verified');
  });

  it('is idempotent and keeps owner scores', async () => {
    const { db, run, kase } = await setup(['verified']);
    await db.insert(scores).values({ caseId: kase.id, criterion: 'gut', value: 3, note: 'n', by: 'owner' });
    const router = fakeRouter({ structured: { score: [aiScores(4), aiScores(4)] } });
    await score(depsOf(db, router), run, { caseIds: [kase.id] });
    await score(depsOf(db, router), run, { caseIds: [kase.id] });
    const rows = await db.select().from(scores).where(eq(scores.caseId, kase.id));
    expect(rows.filter((r) => r.by === 'ai')).toHaveLength(7);
    expect(rows.filter((r) => r.by === 'owner')).toHaveLength(1);
  });

  it('makes no calls for empty input', async () => {
    const { db, run } = await setup([]);
    const router = fakeRouter({});
    expect(await score(depsOf(db, router), run, { caseIds: [] })).toEqual({ caseIds: [] });
    expect(router.calls).toHaveLength(0);
  });
});
