import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client';
import { claims, gateVerdicts, scores } from '../../src/db/schema';
import { getCaseView } from '../../src/dashboard/case-view';
import { moveStage } from '../../src/dashboard/stage';
import { defaultRunConfig } from '../../src/pipeline/types';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';

let db: Db;

beforeEach(async () => {
  db = await testDb();
});

describe('getCaseView', () => {
  it('getCaseView rejects a bad slug and orders failed gate checks first', async () => {
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await insertIdea(db, run.id, { lensId: 'money-leak' });
    const c = await insertCase(db, idea.id, { slug: 'good-slug' });
    const v = (check: 'generic' | 'control' | 'evidence', pass: boolean, reasoning: string, s: number) =>
      ({ ideaId: idea.id, check, pass, reasoning, model: 'm', promptVersion: 'p', createdAt: new Date(Date.UTC(2026, 9, 3, 0, 0, s)) });
    await db.insert(gateVerdicts).values([
      v('control', true, 'ok', 0), v('evidence', true, 'old pass', 0), v('evidence', false, 'thin', 1), v('generic', true, 'fine', 0),
    ]);
    await db.insert(claims).values({ caseId: c.id, section: 'evidence', text: 'c', sourceUrl: 'https://x.test' });
    await db.insert(scores).values({ caseId: c.id, criterion: 'gut', value: 3, note: '', by: 'owner' });
    await moveStage(db, { caseId: c.id, from: 'new', to: 'validating' });

    for (const bad of ['', 'Bad-Slug', 'a/b', "x' or 1=1", 'a'.repeat(121), 'slug with space']) expect(await getCaseView(db, bad)).toBeNull();
    expect(await getCaseView(db, 'missing-slug')).toBeNull();

    const view = (await getCaseView(db, 'good-slug'))!;
    expect(view.case.id).toBe(c.id);
    expect(view.case.stage).toBe('validating');
    expect(view.lensName).toBe('Money-leak recovery');
    expect(view.gate.map((g) => [g.check, g.pass])).toEqual([['evidence', false], ['generic', true], ['control', true]]);
    expect(view.claims).toHaveLength(1);
    expect(view.scores).toHaveLength(1);
    expect(view.events).toHaveLength(1);
    expect(view.events[0]!.kind).toBe('move');
  });

  it('keeps only the latest 20 stage events, newest first, and a null lens for owner ideas', async () => {
    const run = await insertRun(db, defaultRunConfig({ seedType: 'idea' }));
    const idea = await insertIdea(db, run.id, { origin: 'owner' });
    const c = await insertCase(db, idea.id, { slug: 'busy' });
    let from: 'new' | 'validating' = 'new';
    for (let i = 0; i < 22; i++) {
      const to: 'new' | 'validating' = from === 'new' ? 'validating' : 'new';
      await moveStage(db, { caseId: c.id, from, to });
      from = to;
    }
    const view = (await getCaseView(db, 'busy'))!;
    expect(view.lensName).toBeNull();
    expect(view.events).toHaveLength(20);
    const times = view.events.map((e) => e.at.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});
