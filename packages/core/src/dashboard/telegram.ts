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
/**
 * Wrong `/start <code>` guesses per chat, as { chatId: count } (cleared by a reset or once the owner pairs). The shared
 * code is never rotated because of guesses: a stranger could otherwise keep replacing it and lock the owner out.
 */
export const TELEGRAM_GUESSES_KEY = 'telegram.wrongGuesses';
/** A chat with this many wrong guesses is ignored from then on (no counting, no reply), even with the right code. */
export const MAX_PAIRING_GUESSES = 10;
/** At most this many chats are counted; past it the lowest counts are dropped first (locked chats are kept longest). */
export const MAX_GUESS_CHATS = 200;
/** True while the worker runs with TELEGRAM_OWNER_CHAT_ID (written at worker start): Settings then hides Reset pairing. */
export const TELEGRAM_PINNED_KEY = 'telegram.pinnedByEnv';
export const PAIRING_CODE_LENGTH = 8;
/** No 0/O, 1/I/L: easy to read off a screen and type on a phone. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = new RegExp(`^[${ALPHABET}]{${PAIRING_CODE_LENGTH}}$`);

export type TelegramStatus = {
  connected: boolean;
  paired: boolean;
  pairingCode: string | null;
  /** The owner is pinned by TELEGRAM_OWNER_CHAT_ID on the worker (the pairing code is not used). */
  pinned?: boolean;
};

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

/** Forgets the owner and makes a new pairing code (gen telegram reset, Settings → Reset pairing). */
export async function resetTelegramPairing(db: Db): Promise<string> {
  await db.delete(settings).where(inArray(settings.key, [TELEGRAM_OWNER_KEY, TELEGRAM_PAIRING_KEY, TELEGRAM_GUESSES_KEY]));
  const code = newCode();
  await setSetting(db, TELEGRAM_PAIRING_KEY, code);
  return code;
}

/** Binds the owner (the code matched, or TELEGRAM_OWNER_CHAT_ID) and clears the pairing code. */
export async function pinTelegramOwner(db: Db, chatId: number | string): Promise<void> {
  await setSetting(db, TELEGRAM_OWNER_KEY, chatId);
  await db.delete(settings).where(inArray(settings.key, [TELEGRAM_PAIRING_KEY, TELEGRAM_GUESSES_KEY]));
}

async function readGuesses(db: Db): Promise<Record<string, number>> {
  const v = await getSetting(db, TELEGRAM_GUESSES_KEY);
  const out: Record<string, number> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) out[k] = Math.min(n, MAX_PAIRING_GUESSES);
  }
  return out;
}

/** True when this chat has used up its wrong guesses (it is then ignored until a reset). */
export async function pairingLockedOut(db: Db, chatId: number | string): Promise<boolean> {
  return ((await readGuesses(db))[String(chatId)] ?? 0) >= MAX_PAIRING_GUESSES;
}

/**
 * Counts one wrong pairing guess for this chat (never past MAX_PAIRING_GUESSES) and keeps at most MAX_GUESS_CHATS chats,
 * dropping the lowest counts first so a flood of new chats cannot free a locked one cheaply. Returns true when this guess
 * locked the chat out. The pairing code itself never changes here.
 */
export async function recordWrongPairingGuess(db: Db, chatId: number | string): Promise<boolean> {
  const guesses = await readGuesses(db);
  const key = String(chatId);
  const count = Math.min((guesses[key] ?? 0) + 1, MAX_PAIRING_GUESSES);
  delete guesses[key];
  const others = Object.entries(guesses).sort((x, y) => y[1] - x[1]).slice(0, MAX_GUESS_CHATS - 1);
  await setSetting(db, TELEGRAM_GUESSES_KEY, Object.fromEntries([...others, [key, count]]));
  return count >= MAX_PAIRING_GUESSES;
}

/** The worker records at start whether TELEGRAM_OWNER_CHAT_ID pins the owner (false clears it). */
export async function markTelegramPinned(db: Db, pinned: boolean): Promise<void> {
  if (pinned) await setSetting(db, TELEGRAM_PINNED_KEY, true);
  else await db.delete(settings).where(inArray(settings.key, [TELEGRAM_PINNED_KEY]));
}

/** True while TELEGRAM_OWNER_CHAT_ID pins the owner (as last recorded by the worker). */
export async function telegramPinned(db: Db): Promise<boolean> {
  return (await getSetting(db, TELEGRAM_PINNED_KEY)) === true;
}

/** For Settings → Connections: the worker has the bot token, an owner is bound, the code while unpaired, and the env pin. */
export async function telegramStatus(db: Db): Promise<TelegramStatus> {
  const worker = await readWorkerStatus(db);
  const paired = isOwner(await getSetting(db, TELEGRAM_OWNER_KEY));
  const pinned = await telegramPinned(db);
  return { connected: Boolean(worker?.providers.telegram), paired, pairingCode: paired ? null : await readPairingCode(db), pinned };
}
