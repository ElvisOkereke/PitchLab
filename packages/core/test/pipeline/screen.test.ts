import { describe, expect, it } from 'vitest';
import { CRITERIA } from '../../src/case/schema';
import { screen } from '../../src/pipeline/screen';
import { defaultRunConfig, type StageDeps } from '../../src/pipeline/types';
import { getIdea, insertCase, insertIdea, insertRun, testDb, unit } from '../helpers/db';
import { fakeRouter } from '../helpers/fake-router';

const scores = (v: number) => Object.fromEntries(CRITERIA.map((c) => [c, { value: v, note: 'n' }]));
const deps = (db: unknown, router: unknown) => ({ db, router, log: () => {} }) as unknown as StageDeps;

describe('screen', () => {
  it('advances the top N by mean score, ties by input order', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 2 }));
    const [a, b, c] = [await insertIdea(db, run.id), await insertIdea(db, run.id), await insertIdea(db, run.id)];
    const router = fakeRouter({ structured: { screen: [scores(3), scores(5), scores(3)] } });
    const out = await screen(deps(db, router), run, { ideaIds: [a.id, b.id, c.id] });
    expect(out.ideaIds).toEqual([b.id, a.id]);
    expect((await getIdea(db, a.id)).status).toBe('advanced');
    expect((await getIdea(db, b.id)).status).toBe('advanced');
    expect((await getIdea(db, c.id)).status).toBe('screened_out');
    expect((await getIdea(db, b.id)).screenTotal).toBe(5);
    expect((await getIdea(db, b.id)).screenScores).toEqual(scores(5));
  });

  it('skips a winner too similar (cosine > 0.8) to an already-advanced idea', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 2 }));
    const nearA = unit(0);
    nearA[1] = 0.1; // cosine with unit(0) ≈ 0.995
    const a = await insertIdea(db, run.id, { embedding: unit(0) });
    const b = await insertIdea(db, run.id, { embedding: nearA });
    const c = await insertIdea(db, run.id, { embedding: unit(1) });
    const router = fakeRouter({ structured: { screen: [scores(5), scores(4), scores(3)] } });
    const out = await screen(deps(db, router), run, { ideaIds: [a.id, b.id, c.id] });
    expect(out.ideaIds).toEqual([a.id, c.id]);
    expect((await getIdea(db, b.id)).status).toBe('screened_out');
    expect((await getIdea(db, c.id)).status).toBe('advanced');
  });

  it('lets at most 2 generated ideas per mechanism through, filling the slots from the rest of the ranking', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 3 }));
    const mon = [];
    for (let i = 0; i < 4; i++) mon.push(await insertIdea(db, run.id, { title: `Mon ${i}`, mechanism: 'monitoring' }));
    const money = await insertIdea(db, run.id, { title: 'Money', mechanism: 'money_recovery' });
    const logs: string[] = [];
    const router = fakeRouter({ structured: { screen: [scores(5), scores(5), scores(4), scores(4), scores(2)] } });
    const out = await screen({ db, router, log: (m: string) => logs.push(m) } as unknown as StageDeps, run, { ideaIds: [...mon.map((i) => i.id), money.id] });
    expect(out.ideaIds).toEqual([mon[0]!.id, mon[1]!.id, money.id]);
    expect((await getIdea(db, mon[2]!.id)).status).toBe('screened_out');
    expect((await getIdea(db, mon[3]!.id)).status).toBe('screened_out');
    expect((await getIdea(db, money.id)).status).toBe('advanced');
    expect(logs.some((l) => l.includes('Mon 2') && l.includes('monitoring'))).toBe(true);
  });

  it('never caps ideas without a mechanism', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 3 }));
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await insertIdea(db, run.id, { mechanism: null })).id);
    const router = fakeRouter({ structured: { screen: [scores(5), scores(4), scores(3)] } });
    const out = await screen(deps(db, router), run, { ideaIds: ids });
    expect(out.ideaIds).toEqual(ids);
  });

  it('skips a candidate too similar (cosine >= 0.82) to an idea from any run that already has a case', async () => {
    const db = await testDb();
    const past = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const written = await insertIdea(db, past.id, { embedding: unit(0), status: 'advanced' });
    await insertCase(db, written.id);
    await insertIdea(db, past.id, { embedding: unit(1), status: 'screened_out' }); // no case: does not block
    await insertIdea(db, past.id, { embedding: Array<number>(1536).fill(0), status: 'advanced' }).then((z) => insertCase(db, z.id)); // NaN similarity: ignored

    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 1 }));
    const copy = unit(0);
    copy[2] = 0.5; // cosine with unit(0) ≈ 0.894
    const regenerated = await insertIdea(db, run.id, { title: 'Regenerated', embedding: copy });
    const fresh = await insertIdea(db, run.id, { title: 'Fresh', embedding: unit(1) });
    const logs: string[] = [];
    const router = fakeRouter({ structured: { screen: [scores(5), scores(3)] } });
    const out = await screen({ db, router, log: (m: string) => logs.push(m) } as unknown as StageDeps, run, { ideaIds: [regenerated.id, fresh.id] });
    expect(out.ideaIds).toEqual([fresh.id]);
    expect((await getIdea(db, regenerated.id)).status).toBe('screened_out');
    expect(logs.some((l) => l.includes('Regenerated') && l.includes('case'))).toBe(true);
  });

  it('does not skip a candidate below the 0.82 similarity to a past case idea', async () => {
    const db = await testDb();
    const past = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const written = await insertIdea(db, past.id, { embedding: unit(0), status: 'advanced' });
    await insertCase(db, written.id);
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 1 }));
    const near = unit(0);
    near[2] = 0.75; // cosine ≈ 0.8
    const idea = await insertIdea(db, run.id, { embedding: near });
    const out = await screen(deps(db, fakeRouter({ structured: { screen: [scores(4)] } })), run, { ideaIds: [idea.id] });
    expect(out.ideaIds).toEqual([idea.id]);
  });

  it('leaves owner ideas alone: never capped or skipped, and they use no mechanism slot', async () => {
    const db = await testDb();
    const past = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const written = await insertIdea(db, past.id, { embedding: unit(0), status: 'advanced' });
    await insertCase(db, written.id);
    const run = await insertRun(db, defaultRunConfig({ seedType: 'idea', advanceCount: 2 }));
    const owner = await insertIdea(db, run.id, { origin: 'owner', mechanism: 'monitoring', embedding: unit(0) });
    const g1 = await insertIdea(db, run.id, { mechanism: 'monitoring', embedding: unit(3) });
    const g2 = await insertIdea(db, run.id, { mechanism: 'monitoring', embedding: unit(4) });
    const out = await screen(deps(db, fakeRouter({ structured: { screen: [scores(4), scores(3)] } })), run, { ideaIds: [owner.id, g1.id, g2.id] });
    expect(out.ideaIds).toEqual([owner.id, g1.id, g2.id]);
    expect((await getIdea(db, owner.id)).status).toBe('advanced');
  });

  it('caps idea fields and collapses newlines before they reach the prompt', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', advanceCount: 1 }));
    const idea = await insertIdea(db, run.id, { title: 'Line one\nLine two', problem: 'p'.repeat(5000) });
    const router = fakeRouter({ structured: { screen: [scores(3)] } });
    await screen(deps(db, router), run, { ideaIds: [idea.id] });
    const prompt = router.calls[0]!.prompt;
    expect(prompt).toContain('Title: Line one Line two\n');
    expect(prompt).toContain('p'.repeat(2000));
    expect(prompt).not.toContain('p'.repeat(2001));
  });

  it('advances owner ideas without scoring or using a slot', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'idea', advanceCount: 1 }));
    const owner = await insertIdea(db, run.id, { origin: 'owner' });
    const g1 = await insertIdea(db, run.id);
    const g2 = await insertIdea(db, run.id);
    const router = fakeRouter({ structured: { screen: [scores(2), scores(4)] } });
    const out = await screen(deps(db, router), run, { ideaIds: [owner.id, g1.id, g2.id] });
    expect(router.calls).toHaveLength(2);
    expect(out.ideaIds).toEqual([owner.id, g2.id]);
    expect((await getIdea(db, owner.id)).status).toBe('advanced');
    expect((await getIdea(db, g1.id)).status).toBe('screened_out');
  });
});
