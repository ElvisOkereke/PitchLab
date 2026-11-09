import { randomInt } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { settings } from '../db/schema';
import { getSetting, setSetting } from '../validation/settings';
import { readWorkerStatus } from './settings';

/**
 * Telegram pairing (web-safe: drizzle, the schema, settings and node:crypto only). The bot binds its owner only when a
 * chat sends `/start <code>` with the one-time code below; the code is shown in Settings → Connections and the worker
 * log, and cleared once paired. `TELEGRAM_OWNER_CHAT_ID` on the worker pins the owner instead.
 */

export const TELEGRAM_OWNER_KEY = 'telegram.ownerChatId';
export const TELEGRAM_OFFSET_KEY = 'telegram.offset';
export const TELEGRAM_PAIRING_KEY = 'telegram.pairingCode';
export const PAIRING_CODE_LENGTH = 8;
/** No 0/O, 1/I/L: easy to read off a screen and type on a phone. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = new RegExp(`^[${ALPHABET}]{${PAIRING_CODE_LENGTH}}$`);

export type TelegramStatus = { connected: boolean; paired: boolean; pairingCode: string | null };

const isOwner = (v: unknown): boolean => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '');

function newCode(): string {
  let s = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

/** The stored pairing code when it is well formed, else null. */
export async function readPairingCode(db: Db): Promise<string | null> {
  const v = await getSetting(db, TELEGRAM_PAIRING_KEY);
  return typeof v === 'string' && CODE_RE.test(v) ? v : null;
}

/** The current pairing code, created when there is none; null once an owner is bound. */
export async function ensurePairingCode(db: Db): Promise<string | null> {
  if (isOwner(await getSetting(db, TELEGRAM_OWNER_KEY))) return null;
  const existing = await readPairingCode(db);
  if (existing) return existing;
  const code = newCode();
  await setSetting(db, TELEGRAM_PAIRING_KEY, code);
  return code;
}

/** Forgets the owner and makes a new pairing code (gen telegram reset). */
export async function resetTelegramPairing(db: Db): Promise<string> {
  await db.delete(settings).where(inArray(settings.key, [TELEGRAM_OWNER_KEY, TELEGRAM_PAIRING_KEY]));
  const code = newCode();
  await setSetting(db, TELEGRAM_PAIRING_KEY, code);
  return code;
}

/** Binds the owner (the code matched, or TELEGRAM_OWNER_CHAT_ID) and clears the pairing code. */
export async function pinTelegramOwner(db: Db, chatId: number | string): Promise<void> {
  await setSetting(db, TELEGRAM_OWNER_KEY, chatId);
  await db.delete(settings).where(inArray(settings.key, [TELEGRAM_PAIRING_KEY]));
}

/** For Settings → Connections: the worker has the bot token, an owner is bound, and the code while unpaired. */
export async function telegramStatus(db: Db): Promise<TelegramStatus> {
  const worker = await readWorkerStatus(db);
  const paired = isOwner(await getSetting(db, TELEGRAM_OWNER_KEY));
  return { connected: Boolean(worker?.providers.telegram), paired, pairingCode: paired ? null : await readPairingCode(db) };
}
