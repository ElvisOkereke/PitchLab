import type { Db } from '@bcg/core/db/client';
import { ideas } from '@bcg/core/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedGatedOutIdea, snapshotDb } from '../helpers/db';
import { request, resetRequest } from '../helpers/next-mocks';

const state = vi.hoisted(() => ({ db: undefined as unknown as Db, authed: true }));

vi.mock('@/lib/db', () => ({ getDb: () => state.db }));
vi.mock('@/lib/auth/require-owner', () => ({
  requireOwnerAction: async () => {
    if (!state.authed) throw new Error('NEXT_REDIRECT;/login');
  },
  requireOwner: async () => {},
}));
vi.mock('next/cache', () => import('../helpers/next-mocks').then((m) => m.nextCacheMock));

const { rateIdeaAction } = await import('@/actions/ideas');

function form(fields: Record<string, string | string[]>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return fd;
}
const row = async (id: string) => (await state.db.select().from(ideas).where(eq(ideas.id, id)))[0]!;

beforeEach(async () => {
  state.db = await createTestDb();
  state.authed = true;
  resetRequest();
});

describe('rateIdeaAction', () => {
  it('thumbs up and down set the rating, clear removes rating and tags, and /runs is revalidated', async () => {
    const idea = await seedGatedOutIdea(state.db);
    expect(await rateIdeaAction({}, form({ ideaId: idea.id, rating: '', op: 'up' }))).toEqual({ ok: true });
    expect((await row(idea.id)).ownerRating).toBe(1);
    expect(request.revalidated).toContain('/runs');
    await rateIdeaAction({}, form({ ideaId: idea.id, rating: '1', op: 'down' }));
    expect((await row(idea.id)).ownerRating).toBe(-1);
    await rateIdeaAction({}, form({ ideaId: idea.id, rating: '-1', op: 'clear' }));
    expect(await row(idea.id)).toMatchObject({ ownerRating: null, ownerTags: null, ownerRatedAt: null });
  });

  it('tags round-trip: toggling adds a tag, toggling it again removes it, and an unrated idea becomes neutral', async () => {
    const idea = await seedGatedOutIdea(state.db);
    await rateIdeaAction({}, form({ ideaId: idea.id, rating: '', toggleTag: 'too niche' }));
    expect(await row(idea.id)).toMatchObject({ ownerRating: 0, ownerTags: ['too niche'] });
    await rateIdeaAction({}, form({ ideaId: idea.id, rating: '0', tags: ['too niche'], toggleTag: 'boring' }));
    expect((await row(idea.id)).ownerTags).toEqual(['too niche', 'boring']);
    await rateIdeaAction({}, form({ ideaId: idea.id, rating: '0', tags: ['too niche', 'boring'], toggleTag: 'too niche' }));
    expect((await row(idea.id)).ownerTags).toEqual(['boring']);
    await rateIdeaAction({}, form({ ideaId: idea.id, rating: '0', tags: ['boring'], op: 'up' }));
    expect(await row(idea.id)).toMatchObject({ ownerRating: 1, ownerTags: ['boring'] });
  });

  it('rejects a bad id, an unknown op or tag, or a bad rating with a message and writes nothing', async () => {
    const idea = await seedGatedOutIdea(state.db);
    const before = await snapshotDb(state.db);
    for (const fields of <Record<string, string | string[]>[]>[
      { ideaId: 'nope', rating: '', op: 'up' },
      { ideaId: idea.id, rating: '', op: 'sideways' },
      { ideaId: idea.id, rating: '', toggleTag: 'not a tag' },
      { ideaId: idea.id, rating: '7', op: 'up' },
      { ideaId: idea.id, rating: '' },
      { ideaId: idea.id, rating: '1', tags: ['bogus'], op: 'up' },
    ]) {
      const r = await rateIdeaAction({}, form(fields));
      expect(r.ok).toBeUndefined();
      expect(r.error).toMatch(/refresh/i);
    }
    expect(await snapshotDb(state.db)).toEqual(before);
  });

  it('refuses an owner idea with a message and writes nothing', async () => {
    const idea = await seedGatedOutIdea(state.db);
    await state.db.update(ideas).set({ origin: 'owner' }).where(eq(ideas.id, idea.id));
    const before = await snapshotDb(state.db);
    const r = await rateIdeaAction({}, form({ ideaId: idea.id, rating: '', op: 'up' }));
    expect(r.ok).toBeUndefined();
    expect(r.error).toMatch(/only generated ideas/i);
    expect(await snapshotDb(state.db)).toEqual(before);
  });

  it('is refused without a session and writes nothing', async () => {
    const idea = await seedGatedOutIdea(state.db);
    const before = await snapshotDb(state.db);
    state.authed = false;
    await expect(rateIdeaAction({}, form({ ideaId: idea.id, rating: '', op: 'up' }))).rejects.toThrow('NEXT_REDIRECT;/login');
    expect(await snapshotDb(state.db)).toEqual(before);
  });
});
