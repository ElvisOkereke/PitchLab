import { describe, expect, it } from 'vitest';
import { WORKER_STATUS_KEY } from '../../src/dashboard/settings';
import {
  TELEGRAM_OWNER_KEY, TELEGRAM_PAIRING_KEY, ensurePairingCode, markTelegramPinned, pinTelegramOwner, resetTelegramPairing, telegramStatus,
} from '../../src/dashboard/telegram';
import { getSetting, setSetting } from '../../src/validation/settings';
import { testDb } from '../helpers/db';

const heartbeat = (telegram: boolean) => ({
  at: new Date().toISOString(), providers: { llm: true, github: false, stackexchange: false, places: false, telegram }, models: {},
});

describe('Telegram pairing', () => {
  it('ensurePairingCode makes one random 8-character code and keeps it until paired', async () => {
    const db = await testDb();
    const a = await ensurePairingCode(db);
    expect(a).toMatch(/^[A-Z2-9]{8}$/);
    expect(await ensurePairingCode(db)).toBe(a);
    const other = await ensurePairingCode(await testDb());
    expect(other).not.toBe(a);
    await setSetting(db, TELEGRAM_OWNER_KEY, 1234);
    expect(await ensurePairingCode(db)).toBeNull();
  });

  it('resetTelegramPairing forgets the owner and makes a new code', async () => {
    const db = await testDb();
    const first = await ensurePairingCode(db);
    await setSetting(db, TELEGRAM_OWNER_KEY, 1234);
    const code = await resetTelegramPairing(db);
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    expect(code).not.toBe(first);
    expect(await getSetting(db, TELEGRAM_OWNER_KEY)).toBeNull();
    expect(await getSetting(db, TELEGRAM_PAIRING_KEY)).toBe(code);
  });

  it('pinTelegramOwner stores the pinned chat and drops the code', async () => {
    const db = await testDb();
    await ensurePairingCode(db);
    await pinTelegramOwner(db, '987654');
    expect(String(await getSetting(db, TELEGRAM_OWNER_KEY))).toBe('987654'); // jsonb may hand a numeric string back as a number; chats are compared as strings
    expect(await getSetting(db, TELEGRAM_PAIRING_KEY)).toBeNull();
  });

  it('telegramStatus reports connected (worker has the token), paired, and the code only while unpaired', async () => {
    const db = await testDb();
    expect(await telegramStatus(db)).toEqual({ connected: false, paired: false, pairingCode: null, pinned: false });
    await setSetting(db, WORKER_STATUS_KEY, heartbeat(true));
    const code = await ensurePairingCode(db);
    expect(await telegramStatus(db)).toEqual({ connected: true, paired: false, pairingCode: code, pinned: false });
    await setSetting(db, TELEGRAM_OWNER_KEY, 1234);
    expect(await telegramStatus(db)).toEqual({ connected: true, paired: true, pairingCode: null, pinned: false });
  });

  it('telegramStatus says when TELEGRAM_OWNER_CHAT_ID pins the owner (marked by the worker at start, cleared when unset)', async () => {
    const db = await testDb();
    await markTelegramPinned(db, true);
    expect((await telegramStatus(db)).pinned).toBe(true);
    await markTelegramPinned(db, false);
    expect((await telegramStatus(db)).pinned).toBe(false);
  });
});
