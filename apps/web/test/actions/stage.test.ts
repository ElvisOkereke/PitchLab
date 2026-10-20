import type { Db } from '@bcg/core/db/client';
import { runs } from '@bcg/core/db/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, eventsOf, getCase, seedCase, seedGatedOutIdea, snapshotDb } from '../helpers/db';
import { RedirectError, request, resetRequest } from '../helpers/next-mocks';

const state = vi.hoisted(() => ({ db: undefined as unknown as Db }));

vi.mock('@/lib/db', () => ({ getDb: () => state.db }));
vi.mock('@/lib/auth/require-owner', () => ({ requireOwnerAction: async () => {}, requireOwner: async () => {} }));
vi.mock('next/cache', () => import('../helpers/next-mocks').then((m) => m.nextCacheMock));
vi.mock('next/navigation', () => import('../helpers/next-mocks').then((m) => m.nextNavigationMock));

const { moveStageAction, overturnKillAction, rerunGateKillAction } = await import('@/actions/stage');

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(async () => {
  state.db = await createTestDb();
  resetRequest();
});

describe('moveStageAction', () => {
  it('moveStageAction persists the move and one stage event', async () => {
    const c = await seedCase(state.db);
    const r = await moveStageAction({}, form({ caseId: c.id, from: 'new', to: 'validating', slug: c.slug }));
    expect(r).toEqual({ ok: true });
    expect((await getCase(state.db, c.id)).stage).toBe('validating');
    const events = await eventsOf(state.db, c.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromStage: 'new', toStage: 'validating', kind: 'move' });
    expect(request.revalidated).toEqual(['/', `/cases/${c.slug}`]);
  });

  it('moveStageAction rejects a bad uuid or unknown stage with a message and writes nothing', async () => {
    const c = await seedCase(state.db);
    const before = await snapshotDb(state.db);
    for (const fields of <Record<string, string>[]>[
      { caseId: 'not-a-uuid', from: 'new', to: 'validating' },
      { caseId: c.id, from: 'new', to: 'archived' },
      { caseId: c.id, from: 'nope', to: 'validating' },
      { caseId: c.id, from: 'new' },
      { caseId: c.id, from: 'new', to: 'killed', note: 'x'.repeat(501) },
    ]) {
      const r = await moveStageAction({}, form(fields));
      expect(r.ok).toBeUndefined();
      expect(r.error).toMatch(/\w/);
    }
    expect(await snapshotDb(state.db)).toEqual(before);
    expect(request.revalidated).toEqual([]);
  });

  it('maps core refusals to messages', async () => {
    const c = await seedCase(state.db, { stage: 'validating' });
    expect(await moveStageAction({}, form({ caseId: c.id, from: 'new', to: 'pilot' })))
      .toEqual({ error: 'This case moved since you loaded the page. Refresh.' });
    expect(await moveStageAction({}, form({ caseId: c.id, from: 'validating', to: 'killed', note: '  ' })))
      .toEqual({ error: 'Add a note saying why you are killing it.' });
    expect(await moveStageAction({}, form({ caseId: c.id, from: 'validating', to: 'validating' })))
      .toEqual({ error: 'Pick a different stage.' });
    expect(await moveStageAction({}, form({ caseId: '00000000-0000-4000-8000-000000000000', from: 'new', to: 'pilot' })))
      .toEqual({ error: 'This case no longer exists. Refresh.' });
    expect(await eventsOf(state.db, c.id)).toHaveLength(0);
  });

  it('a kill stores the note as the kill reason; a bad slug is not revalidated', async () => {
    const c = await seedCase(state.db);
    expect(await moveStageAction({}, form({ caseId: c.id, from: 'new', to: 'killed', note: ' too crowded ', slug: '../x' }))).toEqual({ ok: true });
    expect(await getCase(state.db, c.id)).toMatchObject({ stage: 'killed', killReason: 'too crowded' });
    expect(request.revalidated).toEqual(['/']);
  });
});

describe('overturnKillAction', () => {
  it('overturnKillAction moves killed → new with kind overturn', async () => {
    const c = await seedCase(state.db, { stage: 'killed', killReason: 'meh' });
    await overturnKillAction(form({ caseId: c.id, slug: c.slug }));
    expect(await getCase(state.db, c.id)).toMatchObject({ stage: 'new', killReason: null });
    const events = await eventsOf(state.db, c.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromStage: 'killed', toStage: 'new', kind: 'overturn' });
    expect(request.revalidated).toEqual(['/', `/cases/${c.slug}`]);
  });

  it('rejects a bad id; a case that is no longer killed (or gone) is left alone with a visible notice', async () => {
    const c = await seedCase(state.db, { stage: 'pilot' });
    const before = await snapshotDb(state.db);
    await expect(overturnKillAction(form({ caseId: 'nope' }))).rejects.toThrow('Invalid request.');
    for (const caseId of [c.id, '00000000-0000-4000-8000-000000000000']) {
      const e = await overturnKillAction(form({ caseId })).catch((err: unknown) => err);
      expect(e).toBeInstanceOf(RedirectError);
      expect((e as RedirectError).url).toBe('/?stage=killed&notice=overturn_refused');
    }
    expect(await snapshotDb(state.db)).toEqual(before);
    expect(request.revalidated).toEqual([]);
  });
});

describe('returnTo (case page controls return to the case)', () => {
  const redirectOf = async (p: Promise<unknown>) => {
    const e = await p.catch((err: unknown) => err);
    expect(e).toBeInstanceOf(RedirectError);
    return (e as RedirectError).url;
  };

  it('moveStageAction returns to the given case tab after a successful move', async () => {
    const c = await seedCase(state.db);
    const url = await redirectOf(moveStageAction({}, form({ caseId: c.id, from: 'new', to: 'pilot', slug: c.slug, returnTo: `/cases/${c.slug}?tab=numbers` })));
    expect(url).toBe(`/cases/${c.slug}?tab=numbers`);
    expect((await getCase(state.db, c.id)).stage).toBe('pilot');
    expect(request.revalidated).toEqual(['/', `/cases/${c.slug}`]);
  });

  it('moveStageAction still reports a refusal as a message (no redirect) when returnTo is set', async () => {
    const c = await seedCase(state.db, { stage: 'pilot' });
    expect(await moveStageAction({}, form({ caseId: c.id, from: 'new', to: 'live', returnTo: `/cases/${c.slug}` })))
      .toEqual({ error: 'This case moved since you loaded the page. Refresh.' });
  });

  it('an off-site returnTo is replaced by the board', async () => {
    for (const returnTo of ['//evil.com', 'https://evil.com/x', '/\\evil.com', '/%2F%2Fevil.com', 'javascript:alert(1)']) {
      const c = await seedCase(state.db);
      expect(await redirectOf(moveStageAction({}, form({ caseId: c.id, from: 'new', to: 'live', returnTo })))).toBe('/');
    }
  });

  it('overturnKillAction returns to the case page, and a refusal lands there with the notice', async () => {
    const c = await seedCase(state.db, { stage: 'killed', killReason: 'meh' });
    expect(await redirectOf(overturnKillAction(form({ caseId: c.id, slug: c.slug, returnTo: `/cases/${c.slug}` })))).toBe(`/cases/${c.slug}`);
    expect(await getCase(state.db, c.id)).toMatchObject({ stage: 'new', killReason: null });
    // Second press: no longer killed.
    expect(await redirectOf(overturnKillAction(form({ caseId: c.id, slug: c.slug, returnTo: `/cases/${c.slug}?tab=score` }))))
      .toBe(`/cases/${c.slug}?tab=score&notice=overturn_refused`);
    expect(await eventsOf(state.db, c.id)).toHaveLength(1);
  });

  it('overturnKillAction with an off-site returnTo falls back to the board', async () => {
    const c = await seedCase(state.db, { stage: 'pilot' });
    expect(await redirectOf(overturnKillAction(form({ caseId: c.id, returnTo: '//evil.com' })))).toBe('/?notice=overturn_refused');
  });
});

describe('rerunGateKillAction', () => {
  it('queues an owner-idea run for a gate-killed idea and returns to the Killed column', async () => {
    const idea = await seedGatedOutIdea(state.db);
    const e = await rerunGateKillAction(form({ ideaId: idea.id })).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(RedirectError);
    expect((e as RedirectError).url).toBe('/?stage=killed&notice=rerun_queued');
    const queued = (await state.db.select().from(runs)).filter((r) => r.status === 'queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.config).toMatchObject({ seedType: 'idea', overturnOfIdeaId: idea.id });
  });

  it('reports a refusal through the notice and writes nothing for a bad id', async () => {
    const c = await seedCase(state.db);
    const before = await snapshotDb(state.db);
    await expect(rerunGateKillAction(form({ ideaId: 'nope' }))).rejects.toThrow('Invalid request.');
    const e = await rerunGateKillAction(form({ ideaId: c.ideaId })).catch((err: unknown) => err);
    expect((e as RedirectError).url).toBe('/?stage=killed&notice=rerun_refused');
    expect(await snapshotDb(state.db)).toEqual(before);
  });
});
