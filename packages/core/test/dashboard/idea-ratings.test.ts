import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { OWNER_IDEA_TAGS } from '../../src/audit/owner-tags';
import { rateIdea } from '../../src/dashboard/idea-ratings';
import { ideas } from '../../src/db/schema';
import { defaultRunConfig } from '../../src/pipeline/types';
import { insertIdea, insertRun, testDb } from '../helpers/db';

const setup = async () => {
  const db = await testDb();
  const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
  const idea = await insertIdea(db, run.id);
  const get = async () => (await db.select().from(ideas).where(eq(ideas.id, idea.id)))[0]!;
  return { db, idea, get };
};

describe('OWNER_IDEA_TAGS', () => {
  it('is the nine fixed tags', () => {
    expect([...OWNER_IDEA_TAGS]).toEqual(['too niche', 'no edge', 'not scalable', 'already exists', 'boring', 'platform-dependent', 'wordpress or plugin', 'love it', 'would build']);
  });
});

describe('rateIdea', () => {
  it('sets rating, tags and time', async () => {
    const { db, idea, get } = await setup();
    await rateIdea(db, { ideaId: idea.id, rating: 1, tags: ['love it', 'would build'] });
    const row = await get();
    expect(row).toMatchObject({ ownerRating: 1, ownerTags: ['love it', 'would build'] });
    expect(row.ownerRatedAt).toBeInstanceOf(Date);
  });

  it('accepts 0 and -1, and dedupes tags keeping order', async () => {
    const { db, idea, get } = await setup();
    await rateIdea(db, { ideaId: idea.id, rating: 0, tags: ['boring', 'boring', 'no edge'] });
    expect(await get()).toMatchObject({ ownerRating: 0, ownerTags: ['boring', 'no edge'] });
    await rateIdea(db, { ideaId: idea.id, rating: -1, tags: [] });
    expect(await get()).toMatchObject({ ownerRating: -1, ownerTags: [] });
  });

  it('a null rating clears rating, tags and time', async () => {
    const { db, idea, get } = await setup();
    await rateIdea(db, { ideaId: idea.id, rating: 1, tags: ['love it'] });
    await rateIdea(db, { ideaId: idea.id, rating: null, tags: ['love it'] });
    expect(await get()).toMatchObject({ ownerRating: null, ownerTags: null, ownerRatedAt: null });
  });

  it('rejects unknown tags, bad ratings and bad ids; dedupes before the 9-tag cap', async () => {
    const { db, idea, get } = await setup();
    await expect(rateIdea(db, { ideaId: idea.id, rating: 1, tags: ['nope' as never] })).rejects.toThrow();
    await expect(rateIdea(db, { ideaId: idea.id, rating: 2 as never, tags: [] })).rejects.toThrow();
    await expect(rateIdea(db, { ideaId: 'not-a-uuid', rating: 1, tags: [] })).rejects.toThrow();
    await rateIdea(db, { ideaId: idea.id, rating: 1, tags: [...OWNER_IDEA_TAGS, ...OWNER_IDEA_TAGS] }); // 18 raw, 9 distinct
    expect((await get()).ownerTags).toHaveLength(9);
  });

  it('rating an idea that does not exist changes nothing and does not throw', async () => {
    const { db, get } = await setup();
    expect(await rateIdea(db, { ideaId: '00000000-0000-4000-8000-000000000000', rating: 1, tags: [] })).toBe(false);
    expect((await get()).ownerRating).toBeNull();
  });

  it('refuses a non-generated (owner) idea: returns false and writes nothing; a generated idea returns true', async () => {
    const { db, idea } = await setup();
    const owner = await insertIdea(db, idea.runId, { origin: 'owner', title: 'Mine' });
    expect(await rateIdea(db, { ideaId: owner.id, rating: 1, tags: ['love it'] })).toBe(false);
    expect((await db.select().from(ideas).where(eq(ideas.id, owner.id)))[0]).toMatchObject({ ownerRating: null, ownerTags: null, ownerRatedAt: null });
    expect(await rateIdea(db, { ideaId: idea.id, rating: 1, tags: [] })).toBe(true);
  });
});
