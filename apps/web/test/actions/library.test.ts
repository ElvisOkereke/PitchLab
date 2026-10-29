import type { Db } from '@bcg/core/db/client';
import { knowledgeItems, researchMissions } from '@bcg/core/db/schema';
import { getResearchSettings } from '@bcg/core/dashboard/missions';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedLibraryItem, snapshotDb } from '../helpers/db';
import { RedirectError, request, resetRequest } from '../helpers/next-mocks';

const state = vi.hoisted(() => ({ db: undefined as unknown as Db }));

vi.mock('@/lib/db', () => ({ getDb: () => state.db }));
vi.mock('@/lib/auth/require-owner', () => ({ requireOwnerAction: async () => {}, requireOwner: async () => {} }));
vi.mock('next/cache', () => import('../helpers/next-mocks').then((m) => m.nextCacheMock));
vi.mock('next/navigation', () => import('../helpers/next-mocks').then((m) => m.nextNavigationMock));

const { queueMissionAction, rejectItemAction, restoreItemAction, saveResearchSettingsAction } = await import('@/actions/library');

function form(fields: Record<string, string | string[]>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) fd.append(k, x);
  return fd;
}
const redirectOf = async (p: Promise<unknown>) => {
  const e = await p.catch((err: unknown) => err);
  expect(e).toBeInstanceOf(RedirectError);
  return (e as RedirectError).url;
};

beforeEach(async () => {
  state.db = await createTestDb();
  resetRequest();
});

describe('queueMissionAction', () => {
  it('queues one mission with kinds, uppercased countries, audience and budget', async () => {
    const r = await queueMissionAction({}, form({ topic: ' invoice chasing ', kinds: ['problem', 'pricing'], countries: 'ca, us ,Global,', audience: 'business', budgetUsd: '3.5' }));
    expect(r).toEqual({ ok: true });
    const rows = await state.db.select().from(researchMissions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ topic: 'invoice chasing', kinds: ['problem', 'pricing'], countries: ['CA', 'US', 'global'], audience: 'business', status: 'queued', origin: 'owner' });
    expect(Number(rows[0]!.budgetUsd)).toBe(3.5);
    expect(request.revalidated).toContain('/library');
  });

  it('uses the default budget when blank and no audience', async () => {
    expect(await queueMissionAction({}, form({ topic: 'dental billing', kinds: 'startup', budgetUsd: '', audience: '' }))).toEqual({ ok: true });
    const row = (await state.db.select().from(researchMissions))[0]!;
    expect(Number(row.budgetUsd)).toBe(2);
    expect(row.audience).toBeNull();
  });

  it('names the invalid field, never echoes the value in the message, writes nothing', async () => {
    const before = await snapshotDb(state.db);
    const cases: [Record<string, string | string[]>, string][] = [
      [{ topic: 'ab', kinds: 'problem' }, 'Topic must be 3 to 200 characters.'],
      [{ topic: 'x'.repeat(201), kinds: 'problem' }, 'Topic must be 3 to 200 characters.'],
      [{ topic: 'valid topic' }, 'Pick 1 to 6 kinds.'],
      [{ topic: 'valid topic', kinds: ['gossip'] }, 'Pick 1 to 6 kinds.'],
      [{ topic: 'valid topic', kinds: 'problem', countries: 'Canada' }, 'Countries must be two-letter codes or global, up to 10, separated by commas.'],
      [{ topic: 'valid topic', kinds: 'problem', audience: 'robots' }, 'Audience must be business, consumer or both.'],
      [{ topic: 'valid topic', kinds: 'problem', budgetUsd: '0.1' }, 'Budget must be a number from 0.5 to 25.'],
      [{ topic: 'valid topic', kinds: 'problem', budgetUsd: '26' }, 'Budget must be a number from 0.5 to 25.'],
      [{ topic: 'valid topic', kinds: 'problem', budgetUsd: 'abc' }, 'Budget must be a number from 0.5 to 25.'],
    ];
    for (const [fields, message] of cases) {
      const r = await queueMissionAction({}, form(fields));
      expect(r.error, JSON.stringify(fields)).toBe(message);
      expect(r.error).not.toContain('Canada');
    }
    expect(await snapshotDb(state.db)).toEqual(before);
  });

  it('keeps what was typed on a refusal', async () => {
    const r = await queueMissionAction({}, form({ topic: 'ab', kinds: ['problem'], countries: 'ca', budgetUsd: '3' }));
    expect(r.values).toMatchObject({ topic: 'ab', kinds: ['problem'], countries: 'ca', budgetUsd: '3' });
  });

  it('refuses a 4th queued mission with the waiting message', async () => {
    for (let i = 0; i < 3; i++) expect(await queueMissionAction({}, form({ topic: `topic ${i}`, kinds: 'problem' }))).toEqual({ ok: true });
    const r = await queueMissionAction({}, form({ topic: 'topic 4', kinds: 'problem' }));
    expect(r.error).toBe('3 research missions are already waiting. Wait for the worker.');
    expect(await state.db.select().from(researchMissions)).toHaveLength(3);
  });
});

describe('rejectItemAction / restoreItemAction', () => {
  it('reject sets the status and reason, then redirects to the same Library URL', async () => {
    const id = await seedLibraryItem(state.db);
    const url = await redirectOf(rejectItemAction(form({ id, reason: 'spam', returnTo: `/library?kind=problem&page=2&item=${id}` })));
    expect(url).toBe(`/library?kind=problem&page=2&item=${id}`);
    const row = (await state.db.select().from(knowledgeItems).where(eq(knowledgeItems.id, id)))[0]!;
    expect(row.status).toBe('rejected');
    expect(row.rejectReason).toBe('spam');
    expect(request.revalidated).toContain('/library');
  });

  it('restore flips it back', async () => {
    const id = await seedLibraryItem(state.db);
    await redirectOf(rejectItemAction(form({ id, returnTo: '/library' })));
    const url = await redirectOf(restoreItemAction(form({ id, returnTo: '/library?status=rejected' })));
    expect(url).toBe('/library?status=rejected');
    expect((await state.db.select().from(knowledgeItems).where(eq(knowledgeItems.id, id)))[0]!.status).toBe('active');
  });

  it('returnTo is normalised: off-site or other pages fall back to /library', async () => {
    const id = await seedLibraryItem(state.db);
    expect(await redirectOf(rejectItemAction(form({ id, returnTo: 'https://evil.example/x' })))).toBe('/library');
    expect(await redirectOf(restoreItemAction(form({ id, returnTo: '//evil.example' })))).toBe('/library');
    expect(await redirectOf(restoreItemAction(form({ id, returnTo: '/settings' })))).toBe('/library');
    expect(await redirectOf(restoreItemAction(form({ id })))).toBe('/library');
  });

  it('rejects a bad id or a reason over 200 characters, writing nothing', async () => {
    const id = await seedLibraryItem(state.db);
    const before = await snapshotDb(state.db);
    await expect(rejectItemAction(form({ id: 'nope' }))).rejects.toThrow('Invalid request.');
    await expect(rejectItemAction(form({ id, reason: 'x'.repeat(201) }))).rejects.toThrow('Invalid request.');
    await expect(restoreItemAction(form({ id: '' }))).rejects.toThrow('Invalid request.');
    expect(await snapshotDb(state.db)).toEqual(before);
  });
});

describe('saveResearchSettingsAction', () => {
  it('saves the checkbox and cap and echoes them', async () => {
    const r = await saveResearchSettingsAction({}, form({ background: 'on', dailyCapUsd: '7.5' }));
    expect(r).toEqual({ ok: true, values: { background: 'on', dailyCapUsd: '7.5' } });
    expect(await getResearchSettings(state.db)).toEqual({ background: true, dailyCapUsd: 7.5 });
    const off = await saveResearchSettingsAction({}, form({ dailyCapUsd: '0' }));
    expect(off.ok).toBe(true);
    expect(await getResearchSettings(state.db)).toEqual({ background: false, dailyCapUsd: 0 });
  });

  it('refuses a cap outside 0 to 50 or not a number, writing nothing and keeping the typed value', async () => {
    const before = await snapshotDb(state.db);
    for (const cap of ['-1', '51', 'abc', '']) {
      const r = await saveResearchSettingsAction({}, form({ background: 'on', dailyCapUsd: cap }));
      expect(r.error, cap).toBe('Daily cap must be a number from 0 to 50.');
      expect(r.values).toEqual({ background: 'on', dailyCapUsd: cap });
    }
    expect(await snapshotDb(state.db)).toEqual(before);
  });
});
