import type { Db } from '@bcg/core/db/client';
import { scores } from '@bcg/core/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedCase, snapshotDb } from '../helpers/db';
import { request, resetRequest } from '../helpers/next-mocks';

const state = vi.hoisted(() => ({ db: undefined as unknown as Db }));

vi.mock('@/lib/db', () => ({ getDb: () => state.db }));
vi.mock('@/lib/auth/require-owner', () => ({ requireOwnerAction: async () => {}, requireOwner: async () => {} }));
vi.mock('next/cache', () => import('../helpers/next-mocks').then((m) => m.nextCacheMock));
vi.mock('next/navigation', () => import('../helpers/next-mocks').then((m) => m.nextNavigationMock));

const { saveOwnerScoresAction } = await import('@/actions/scores');

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

const ownerRows = async (caseId: string) =>
  (await state.db.select().from(scores).where(eq(scores.caseId, caseId))).filter((r) => r.by === 'owner');

beforeEach(async () => {
  state.db = await createTestDb();
  resetRequest();
});

describe('saveOwnerScoresAction', () => {
  it('saveOwnerScoresAction stores gut and replaces earlier owner rows', async () => {
    const c = await seedCase(state.db);
    await state.db.insert(scores).values({ caseId: c.id, criterion: 'pain', value: 2, note: 'ai', by: 'ai', model: 'm', promptVersion: 'p' });
    const aiBefore = (await state.db.select().from(scores)).filter((r) => r.by === 'ai');

    const first = await saveOwnerScoresAction({}, form({ caseId: c.id, slug: c.slug, value_gut: '4', note_gut: ' love it ', value_pain: '3', value_roi: '' }));
    // The saved values come back (notes trimmed as stored) so the form shows exactly what was saved.
    expect(first).toEqual({ ok: true, values: expect.objectContaining({ value_gut: '4', note_gut: 'love it', value_pain: '3', value_roi: '' }) });
    expect(await saveOwnerScoresAction({}, form({ caseId: c.id, slug: c.slug, value_gut: '5', note_gut: 'b' })))
      .toEqual({ ok: true, values: expect.objectContaining({ value_gut: '5', note_gut: 'b' }) });

    const rows = await ownerRows(c.id);
    expect(rows.map((r) => [r.criterion, r.value, r.note]).sort()).toEqual([['gut', 5, 'b'], ['pain', 3, '']]);
    expect(rows.every((r) => r.model === null && r.promptVersion === null)).toBe(true);
    expect((await state.db.select().from(scores)).filter((r) => r.by === 'ai')).toEqual(aiBefore);
    expect(request.revalidated).toEqual(expect.arrayContaining([`/cases/${c.slug}`, '/', '/leaderboard', '/command']));
  });

  it('saveOwnerScoresAction rejects value 6, unknown criterion and an all-blank form', async () => {
    const c = await seedCase(state.db);
    const before = await snapshotDb(state.db);
    const cases: [Record<string, string>, RegExp][] = [
      [{ caseId: c.id, value_gut: '6' }, /whole numbers from 1 to 5/],
      [{ caseId: c.id, value_gut: '0' }, /whole numbers from 1 to 5/],
      [{ caseId: c.id, value_gut: '2.5' }, /whole numbers from 1 to 5/],
      [{ caseId: c.id, value_gut: 'abc' }, /whole numbers from 1 to 5/],
      [{ caseId: c.id, value_charm: '4' }, /Score at least one criterion/],
      [{ caseId: c.id, value_gut: '', value_pain: '' }, /Score at least one criterion/],
      [{ caseId: c.id, value_gut: '3', note_gut: 'x'.repeat(1001) }, /at most 1000 characters/],
      [{ caseId: c.id, note_pain: 'forgot the score' }, /Pick a score for “Pain severity” or clear its note/],
      [{ caseId: 'not-a-uuid', value_gut: '3' }, /Refresh/],
    ];
    for (const [fields, message] of cases) {
      const r = await saveOwnerScoresAction({}, form(fields));
      expect(r.ok, JSON.stringify(fields)).toBeUndefined();
      expect(r.error).toMatch(message);
    }
    expect(await snapshotDb(state.db)).toEqual(before);
    expect(request.revalidated).toEqual([]);
  });

  it('reports a case that no longer exists', async () => {
    expect(await saveOwnerScoresAction({}, form({ caseId: '00000000-0000-4000-8000-000000000000', value_gut: '3' })))
      .toEqual({ error: 'This case no longer exists. Refresh.', values: expect.objectContaining({ value_gut: '3' }) });
  });

  it('an error echoes every score field (and nothing else) so the form keeps the edits', async () => {
    const c = await seedCase(state.db);
    const r = await saveOwnerScoresAction({}, form({ caseId: c.id, value_gut: '6', note_gut: 'big', value_roi: '2', note_roi: 'ok', other: 'x' }));
    expect(r.error).toMatch(/whole numbers/);
    expect(r.values).toEqual({
      value_pain: '', note_pain: '', value_roi: '2', note_roi: 'ok', value_evidence: '', note_evidence: '', value_speed: '', note_speed: '',
      value_autonomy: '', note_autonomy: '', value_novelty: '', note_novelty: '', value_reach: '', note_reach: '', value_gut: '6', note_gut: 'big',
    });
  });
});
