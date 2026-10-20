import type { Db } from '@bcg/core/db/client';
import { WORKER_STATUS_KEY } from '@bcg/core/dashboard/settings';
import { getSetting, setSetting } from '@bcg/core/validation/settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, snapshotDb } from '../helpers/db';
import { request, resetRequest } from '../helpers/next-mocks';

const state = vi.hoisted(() => ({ db: undefined as unknown as Db }));

vi.mock('@/lib/db', () => ({ getDb: () => state.db }));
vi.mock('@/lib/auth/require-owner', () => ({ requireOwnerAction: async () => {}, requireOwner: async () => {} }));
vi.mock('next/cache', () => import('../helpers/next-mocks').then((m) => m.nextCacheMock));
vi.mock('next/navigation', () => import('../helpers/next-mocks').then((m) => m.nextNavigationMock));

const { saveSettingsAction } = await import('@/actions/settings');

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(async () => {
  state.db = await createTestDb();
  resetRequest();
});

describe('saveSettingsAction', () => {
  it('saveSettingsAction writes sender.* and landing.* only and ignores worker.status', async () => {
    await setSetting(state.db, WORKER_STATUS_KEY, { keep: true });
    const r = await saveSettingsAction({}, form({
      'sender.name': '  Al Owner ', 'sender.address': '1 Main St, Toronto', 'landing.formEndpoint': 'https://forms.example/f',
      'landing.privacyContact': '', 'worker.status': '{"hacked":true}', 'other.key': 'x',
    }));
    expect(r).toEqual({ ok: true });
    expect(await getSetting(state.db, 'sender.name')).toBe('Al Owner');
    expect(await getSetting(state.db, 'sender.address')).toBe('1 Main St, Toronto');
    expect(await getSetting(state.db, 'landing.formEndpoint')).toBe('https://forms.example/f');
    expect(await getSetting(state.db, 'landing.privacyContact')).toBe('');
    expect(await getSetting(state.db, WORKER_STATUS_KEY)).toEqual({ keep: true });
    expect(await getSetting(state.db, 'other.key')).toBeNull();
    expect(request.revalidated).toContain('/settings');
  });

  it('saveSettingsAction rejects a non-https formEndpoint', async () => {
    const before = await snapshotDb(state.db);
    for (const bad of ['http://forms.example/f', 'javascript:alert(1)', 'not a url', 'https://user:pw@forms.example/']) {
      expect(await saveSettingsAction({}, form({ 'sender.name': 'Al', 'landing.formEndpoint': bad })))
        .toEqual({ error: 'Form endpoint: The form endpoint must be an https URL (or empty).' });
    }
    expect(await saveSettingsAction({}, form({ 'sender.address': 'x'.repeat(501) }))).toEqual({ error: 'Mailing address: At most 500 characters.' });
    expect(await snapshotDb(state.db)).toEqual(before);
  });
});
