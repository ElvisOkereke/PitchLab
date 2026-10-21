import type { Db } from '@bcg/core/db/client';
import { validationJobs } from '@bcg/core/db/schema';
import { setSetting } from '@bcg/core/validation/settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedCase } from '../helpers/db';
import { request, resetRequest } from '../helpers/next-mocks';

const state = vi.hoisted(() => ({ db: undefined as unknown as Db }));

vi.mock('@/lib/db', () => ({ getDb: () => state.db }));
vi.mock('@/lib/auth/require-owner', () => ({ requireOwnerAction: async () => {}, requireOwner: async () => {} }));
vi.mock('next/cache', () => import('../helpers/next-mocks').then((m) => m.nextCacheMock));
vi.mock('next/navigation', () => import('../helpers/next-mocks').then((m) => m.nextNavigationMock));

const { queueValidationAction } = await import('@/actions/validation');

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

async function setSender(db: Db) {
  await setSetting(db, 'sender.name', 'Al Owner');
  await setSetting(db, 'sender.address', '1 Main St, Toronto');
  await setSetting(db, 'sender.contact', 'al@owner.example');
}

beforeEach(async () => {
  state.db = await createTestDb();
  resetRequest();
});

describe('queueValidationAction', () => {
  it('queues a job with the form options and revalidates the case page', async () => {
    await setSender(state.db);
    const c = await seedCase(state.db);
    const r = await queueValidationAction({}, form({ caseId: c.id, slug: c.slug, prospects: '10', skipProspects: 'on', redraft: 'on' }));
    expect(r).toEqual({ ok: true });
    const [job] = await state.db.select().from(validationJobs);
    expect(job!.options).toEqual({ prospects: 10, skipProspects: true, refresh: false, redraft: true });
    expect(request.revalidated).toContain(`/cases/${c.slug}`);
  });

  it('defaults blank prospects to 25', async () => {
    await setSender(state.db);
    const c = await seedCase(state.db);
    expect(await queueValidationAction({}, form({ caseId: c.id, slug: c.slug, prospects: '' }))).toEqual({ ok: true });
    const [job] = await state.db.select().from(validationJobs);
    expect(job!.options).toMatchObject({ prospects: 25 });
  });

  it.each(['abc', '0', '101', '2.5'])('rejects prospects=%s with a field message and queues nothing', async (prospects) => {
    await setSender(state.db);
    const c = await seedCase(state.db);
    const r = await queueValidationAction({}, form({ caseId: c.id, slug: c.slug, prospects }));
    expect(r.error).toBe('Prospects must be a whole number from 1 to 100.');
    expect(r.error).not.toContain('abc');
    expect(r.values).toMatchObject({ prospects });
    expect(await state.db.select().from(validationJobs)).toHaveLength(0);
  });

  it('refuses a bad case id', async () => {
    const r = await queueValidationAction({}, form({ caseId: 'nope', slug: 'x', prospects: '5' }));
    expect(r.error).toBe('This case no longer exists.');
  });

  it('maps refusals to their copy', async () => {
    const ex = await seedCase(state.db, { isExample: true });
    expect((await queueValidationAction({}, form({ caseId: ex.id, slug: ex.slug, prospects: '5' }))).error).toBe(
      'This is the example case. Its validation pack is already there.',
    );
    const c = await seedCase(state.db);
    const f = () => form({ caseId: c.id, slug: c.slug, prospects: '5' });
    expect((await queueValidationAction({}, f())).error).toBe(
      'Set your name, mailing address and contact in Settings first. Every email must include them.',
    );
    await setSender(state.db);
    expect((await queueValidationAction({}, f())).ok).toBe(true);
    expect((await queueValidationAction({}, f())).error).toBe('A validation job for this case is already waiting or running.');
    for (let i = 0; i < 2; i++) {
      const o = await seedCase(state.db);
      await queueValidationAction({}, form({ caseId: o.id, slug: o.slug, prospects: '5' }));
    }
    const last = await seedCase(state.db);
    expect((await queueValidationAction({}, form({ caseId: last.id, slug: last.slug, prospects: '5' }))).error).toBe(
      '3 validation jobs are already waiting. Wait for the worker.',
    );
  });
});
