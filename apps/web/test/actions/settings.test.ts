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

const { saveSettingsAction, saveHoldoutAction, resetTelegramPairingAction } = await import('@/actions/settings');

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
    expect(r).toEqual({ ok: true, values: expect.objectContaining({ 'sender.name': 'Al Owner', 'landing.privacyContact': '' }) });
    expect(r.values).not.toHaveProperty('worker.status');
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
      expect(await saveSettingsAction({}, form({ 'sender.name': 'Al', 'landing.formEndpoint': bad, 'worker.status': 'x' })))
        .toEqual({ error: 'Form endpoint: The form endpoint must be an https URL (or empty).', values: { 'sender.name': 'Al', 'landing.formEndpoint': bad } });
    }
    expect(await saveSettingsAction({}, form({ 'sender.address': 'x'.repeat(501) })))
      .toEqual({ error: 'Mailing address: At most 500 characters.', values: { 'sender.address': 'x'.repeat(501) } });
    expect(await snapshotDb(state.db)).toEqual(before);
  });
});

describe('resetTelegramPairingAction', () => {
  it('forgets the bot owner, makes a new pairing code and refreshes Settings and Finds', async () => {
    await setSetting(state.db, 'telegram.ownerChatId', 1111);
    await resetTelegramPairingAction();
    expect(await getSetting(state.db, 'telegram.ownerChatId')).toBeNull();
    expect(await getSetting(state.db, 'telegram.pairingCode')).toMatch(/^[A-Z2-9]{8}$/);
    expect(request.revalidated).toEqual(expect.arrayContaining(['/settings', '/library/finds']));
  });

  it('does nothing while TELEGRAM_OWNER_CHAT_ID pins the owner (the code would not be used)', async () => {
    await setSetting(state.db, 'telegram.ownerChatId', 1111);
    await setSetting(state.db, 'telegram.pinnedByEnv', true);
    await resetTelegramPairingAction();
    expect(await getSetting(state.db, 'telegram.ownerChatId')).toBe(1111);
    expect(await getSetting(state.db, 'telegram.pairingCode')).toBeNull();
  });
});

describe('saveHoldoutAction', () => {
  it('saves one example per line, trimmed and de-duplicated, and echoes what is stored', async () => {
    const r = await saveHoldoutAction({}, form({ holdout: ' An AI bookkeeper \n\nan ai bookkeeper\nA marketplace for site inspections' }));
    expect(r).toEqual({ ok: true, values: { holdout: 'An AI bookkeeper\nA marketplace for site inspections' } });
    expect(await getSetting(state.db, 'audit.holdout')).toEqual(['An AI bookkeeper', 'A marketplace for site inspections']);
    expect(request.revalidated).toEqual(expect.arrayContaining(['/settings', '/progress']));
  });

  it('an empty box clears the list', async () => {
    await setSetting(state.db, 'audit.holdout', ['x']);
    expect(await saveHoldoutAction({}, form({ holdout: '' }))).toMatchObject({ ok: true });
    expect(await getSetting(state.db, 'audit.holdout')).toEqual([]);
  });

  it('refuses more than 10 examples or one over 1,000 characters, saving nothing and keeping what was typed', async () => {
    await setSetting(state.db, 'audit.holdout', ['keep me']);
    const eleven = Array.from({ length: 11 }, (_, i) => `idea ${i}`).join('\n');
    expect(await saveHoldoutAction({}, form({ holdout: eleven }))).toEqual({ error: 'You can keep at most 10 examples. Remove one first.', values: { holdout: eleven } });
    const long = 'x'.repeat(1001);
    expect(await saveHoldoutAction({}, form({ holdout: long }))).toEqual({ error: 'Each example can be at most 1000 characters.', values: { holdout: long } });
    expect(await getSetting(state.db, 'audit.holdout')).toEqual(['keep me']);
  });
});
