import { describe, expect, it } from 'vitest';
import { scores } from '../../src/db/schema';
import { LEADERBOARD_LIMIT, LeaderSortSchema, listLeaderboard, sortLeaderboard, type LeaderRow } from '../../src/dashboard/leaderboard';
import { defaultRunConfig } from '../../src/pipeline/types';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';

const row = (title: string, o: Partial<LeaderRow> = {}): LeaderRow =>
  ({ slug: title.toLowerCase(), title, stage: 'new', ai: {}, owner: {}, aiTotal: null, ownerTotal: null, ...o });

describe('leaderboard', () => {
  it('listLeaderboard reads the latest AI and owner score per criterion', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const c = await insertCase(db, (await insertIdea(db, run.id)).id, { slug: 'one', title: 'One' });
    await insertCase(db, (await insertIdea(db, run.id)).id, { slug: 'two', title: 'Two' });
    await db.insert(scores).values([
      { caseId: c.id, criterion: 'pain', value: 2, note: '', by: 'ai', createdAt: new Date('2026-10-01T00:00:00Z') },
      { caseId: c.id, criterion: 'pain', value: 4, note: '', by: 'ai', createdAt: new Date('2026-10-02T00:00:00Z') },
      { caseId: c.id, criterion: 'roi', value: 3, note: '', by: 'ai' },
      { caseId: c.id, criterion: 'pain', value: 5, note: '', by: 'owner' },
      { caseId: c.id, criterion: 'gut', value: 2, note: '', by: 'owner' },
    ]);
    const rows = await listLeaderboard(db);
    expect(rows).toHaveLength(2);
    const one = rows.find((r) => r.slug === 'one')!;
    expect(one).toEqual({ slug: 'one', title: 'One', stage: 'new', ai: { pain: 4, roi: 3 }, owner: { pain: 5, gut: 2 }, aiTotal: 3.5, ownerTotal: 3.5 });
    expect(rows.find((r) => r.slug === 'two')).toMatchObject({ ai: {}, owner: {}, aiTotal: null, ownerTotal: null });
    expect(LEADERBOARD_LIMIT).toBe(500);
  });

  it('sortLeaderboard: nulls last both ways; invalid sort falls back to ai desc', () => {
    const rows = [row('B', { aiTotal: 2 }), row('A', { aiTotal: null }), row('C', { aiTotal: 4 })];
    const def = LeaderSortSchema.parse({});
    expect(def).toEqual({ key: 'ai', by: 'ai', dir: 'desc' });
    expect(sortLeaderboard(rows, def).map((r) => r.title)).toEqual(['C', 'B', 'A']);
    expect(sortLeaderboard(rows, { key: 'ai', by: 'ai', dir: 'asc' }).map((r) => r.title)).toEqual(['B', 'C', 'A']);
    expect(LeaderSortSchema.parse({ key: 'title;drop table cases' }).key).toBe('ai');
    expect(LeaderSortSchema.parse({ key: 'pain', by: 'sideways', dir: 'up' })).toEqual({ key: 'pain', by: 'ai', dir: 'desc' });
    expect(LeaderSortSchema.parse(undefined)).toEqual({ key: 'ai', by: 'ai', dir: 'desc' });
  });

  it('sorts by title, owner total and a criterion read from AI or owner; gut always reads owner', () => {
    const rows = [
      row('b', { ownerTotal: 1, ai: { pain: 5 }, owner: { pain: 1, gut: 3 } }),
      row('a', { ownerTotal: 3, ai: { pain: 1 }, owner: { pain: 5 } }),
      row('c', { ownerTotal: null, ai: {}, owner: { gut: 5 } }),
    ];
    expect(sortLeaderboard(rows, { key: 'title', by: 'ai', dir: 'asc' }).map((r) => r.title)).toEqual(['a', 'b', 'c']);
    expect(sortLeaderboard(rows, { key: 'owner', by: 'ai', dir: 'desc' }).map((r) => r.title)).toEqual(['a', 'b', 'c']);
    expect(sortLeaderboard(rows, { key: 'pain', by: 'ai', dir: 'desc' }).map((r) => r.title)).toEqual(['b', 'a', 'c']);
    expect(sortLeaderboard(rows, { key: 'pain', by: 'owner', dir: 'desc' }).map((r) => r.title)).toEqual(['a', 'b', 'c']);
    expect(sortLeaderboard(rows, { key: 'gut', by: 'ai', dir: 'asc' }).map((r) => r.title)).toEqual(['b', 'c', 'a']);
    expect(rows.map((r) => r.title)).toEqual(['b', 'a', 'c']); // input not mutated
  });
});
