import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { CRITERIA } from '../../src/case/schema';
import { claims, scores } from '../../src/db/schema';
import { score } from '../../src/pipeline/score';
import { defaultRunConfig, type StageDeps } from '../../src/pipeline/types';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';
import { fakeRouter } from '../helpers/fake-router';

const aiScores = (evidence = 5) => Object.fromEntries(CRITERIA.map((c) => [c, { value: c === 'evidence' ? evidence : 4, note: `${c} note` }]));

async function setup(statuses: ('verified' | 'unsupported' | 'unreachable' | 'unverified')[]) {
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
