import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client';
import { cases, stageEvents } from '../../src/db/schema';
import { MoveStageInputSchema, moveStage } from '../../src/dashboard/stage';
import { defaultRunConfig } from '../../src/pipeline/types';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';

let db: Db;
let caseId: string;

const getCase = async (id: string) => (await db.select().from(cases).where(eq(cases.id, id)))[0]!;
const eventsOf = (id: string) => db.select().from(stageEvents).where(eq(stageEvents.caseId, id));

beforeEach(async () => {
  db = await testDb();
  const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
  const idea = await insertIdea(db, run.id);
  caseId = (await insertCase(db, idea.id)).id;
});

describe('moveStage', () => {
  it('new → validating writes one move event', async () => {
    const r = await moveStage(db, { caseId, from: 'new', to: 'validating' });
    expect(r).toEqual({ ok: true, kind: 'move' });
    const events = await eventsOf(caseId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromStage: 'new', toStage: 'validating', kind: 'move', note: null });
    expect((await getCase(caseId)).stage).toBe('validating');
  });

  it('kill needs a note and stores it as killReason', async () => {
    expect(await moveStage(db, { caseId, from: 'new', to: 'killed' })).toEqual({ ok: false, reason: 'note_required' });
    expect(await moveStage(db, { caseId, from: 'new', to: 'killed', note: '   ' })).toEqual({ ok: false, reason: 'note_required' });
    expect(await eventsOf(caseId)).toHaveLength(0);
    expect(await moveStage(db, { caseId, from: 'new', to: 'killed', note: 'too crowded' })).toEqual({ ok: true, kind: 'kill' });
    const kase = await getCase(caseId);
    expect(kase.killReason).toBe('too crowded');
    expect(kase.stage).toBe('killed');
    expect((await eventsOf(caseId))[0]).toMatchObject({ kind: 'kill', note: 'too crowded' });
  });

  it('moving out of killed is an overturn and clears killReason', async () => {
    await moveStage(db, { caseId, from: 'new', to: 'killed', note: 'too crowded' });
    const r = await moveStage(db, { caseId, from: 'killed', to: 'pilot', note: 'changed my mind' });
    expect(r).toEqual({ ok: true, kind: 'overturn' });
    const kase = await getCase(caseId);
    expect(kase.killReason).toBeNull();
    expect(kase.stage).toBe('pilot');
    expect((await eventsOf(caseId)).map((e) => e.kind).sort()).toEqual(['kill', 'overturn']);
  });

  it('bumps updatedAt', async () => {
    const before = (await getCase(caseId)).updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await moveStage(db, { caseId, from: 'new', to: 'live' });
    expect((await getCase(caseId)).updatedAt.getTime()).toBeGreaterThan(before.getTime());
  });

  it('a stale from-stage changes nothing', async () => {
    const r = await moveStage(db, { caseId, from: 'validating', to: 'pilot' });
    expect(r).toEqual({ ok: false, reason: 'stale' });
    expect(await eventsOf(caseId)).toHaveLength(0);
    expect((await getCase(caseId)).stage).toBe('new');
  });

  it('same stage is rejected; unknown id is not_found', async () => {
    expect(await moveStage(db, { caseId, from: 'new', to: 'new' })).toEqual({ ok: false, reason: 'same_stage' });
    expect(await moveStage(db, { caseId: randomUUID(), from: 'new', to: 'pilot' })).toEqual({ ok: false, reason: 'not_found' });
    expect(await eventsOf(caseId)).toHaveLength(0);
  });

  it('MoveStageInputSchema rejects a bad uuid, unknown stage and a note over 500 chars', () => {
    expect(MoveStageInputSchema.safeParse({ caseId: 'x', from: 'new', to: 'pilot' }).success).toBe(false);
    expect(MoveStageInputSchema.safeParse({ caseId, from: 'new', to: 'archived' }).success).toBe(false);
    expect(MoveStageInputSchema.safeParse({ caseId, from: 'new', to: 'killed', note: 'x'.repeat(501) }).success).toBe(false);
    expect(MoveStageInputSchema.parse({ caseId, from: 'new', to: 'killed', note: '  why  ' }).note).toBe('why');
  });
});
