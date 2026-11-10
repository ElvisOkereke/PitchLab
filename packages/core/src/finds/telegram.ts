import { timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/client';
import {
  TELEGRAM_OFFSET_KEY, TELEGRAM_OWNER_KEY, ensurePairingCode, pairingLockedOut, pinTelegramOwner, readPairingCode, recordWrongPairingGuess,
} from '../dashboard/telegram';
import { request, SourceError } from '../research/http';
import { scrubSecrets } from '../tools/scrub';
import { getSetting, setSetting } from '../validation/settings';
import { addFinds as defaultAddFinds } from './store';

/**
 * The private Telegram bot (worker-side, outbound only): getUpdates on api.telegram.org, never a webhook. The owner is
 * bound only by `/start <code>` with the one-time pairing code (setting telegram.pairingCode, shown in Settings and the
 * worker log; compared in constant time and cleared once used), or pinned by TELEGRAM_OWNER_CHAT_ID. Every other chat,
 * a bare /start and a wrong code are ignored silently, and nothing from them is stored; a chat with 10 wrong codes is
 * ignored from then on (per chat, setting telegram.wrongGuesses; the shared code is never rotated by guesses). Links in the owner's messages become finds; the rest of the text is the note. Replies are plain
 * text (no parse mode).
 *
 * The token appears only in the request url path. Request errors never carry the url (http.ts), and every message this
 * module logs or throws has the token removed as well (sanitize), so it never reaches a log, a heartbeat or a row.
 */

export { TELEGRAM_OFFSET_KEY, TELEGRAM_OWNER_KEY } from '../dashboard/telegram';
const API = 'https://api.telegram.org';
const MAX_UPDATES = 50;
const MAX_TEXT = 4096;
const MAX_URLS = 10;
/** Handling failures in a row for one update (setting, survives passes): { updateId, count }. */
export const TELEGRAM_FAILURES_KEY = 'telegram.updateFailures';
/** An update that fails this many times in a row is skipped (the offset moves past it). */
export const MAX_UPDATE_FAILURES = 3;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCT = /[.,;:!?)\]}'"»”’]+$/;

export type TelegramTransport = { token: string; fetch?: typeof fetch; log: (m: string) => void };
export type TelegramDeps = TelegramTransport & {
  db: Db;
  /** getUpdates `timeout` in seconds. 0 (the default) returns at once, so a worker pass is never held. */
  timeoutSec?: number;
  /** TELEGRAM_OWNER_CHAT_ID: pins the owner (the pairing code is then not used). */
  ownerChatId?: string;
  /** Tests only. */
  addFinds?: typeof defaultAddFinds;
};

type Entity = { type?: unknown; offset?: unknown; length?: unknown; url?: unknown };
type Message = { chat?: { id?: unknown }; text?: unknown; caption?: unknown; entities?: unknown; caption_entities?: unknown };
type Update = { update_id?: unknown; message?: Message };

/** The token (and anything credential-shaped) taken out of a message. */
function sanitize(token: string, text: string): string {
  return scrubSecrets(token ? text.split(token).join('[token]') : text);
}

function methodUrl(token: string, method: string, query = ''): string {
  return `${API}/bot${token}/${method}${query}`;
}

/** A Bot API call through the fixed-host request helper; a failure is rethrown with a token-free message. */
async function call(t: TelegramTransport, method: string, init: { query?: string; body?: unknown; timeoutMs: number }): Promise<unknown> {
  try {
    const res = await request('telegram', methodUrl(t.token, method, init.query), {
      method: init.body === undefined ? 'GET' : 'POST',
      headers: init.body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      timeoutMs: init.timeoutMs,
      maxBytes: 1_000_000,
    }, { fetch: t.fetch });
    if (!res || typeof res !== 'object' || (res as { ok?: unknown }).ok !== true) throw new SourceError('bad_response', 'telegram');
    return (res as { result?: unknown }).result;
  } catch (e) {
    const msg = e instanceof SourceError ? e.message : 'telegram: request failed';
    throw new Error(sanitize(t.token, `${method}: ${msg}`));
  }
}

/** Sends a plain-text message. Never throws: a failure is logged (without the token) and returns false. */
export async function sendTelegram(t: TelegramTransport, chatId: number | string, text: string): Promise<boolean> {
  try {
    await call(t, 'sendMessage', { body: { chat_id: chatId, text: text.slice(0, MAX_TEXT) }, timeoutMs: 15_000 });
    return true;
  } catch (e) {
    t.log(sanitize(t.token, `telegram: reply failed (${e instanceof Error ? e.message : String(e)})`));
    return false;
  }
}

const cleanUrl = (u: string): string | null => {
  const s = u.trim().replace(TRAILING_PUNCT, '');
  return /^https?:\/\//i.test(s) ? s : null;
};

/** Links in a message (url entities, text_link entities, then any http(s) link in the text) and the remaining text as the note. */
export function messageParts(m: { text?: unknown; caption?: unknown; entities?: unknown; caption_entities?: unknown }): { urls: string[]; note: string } {
  const text = typeof m.text === 'string' ? m.text : typeof m.caption === 'string' ? m.caption : '';
  const body = text.slice(0, MAX_TEXT);
  const rawEntities = Array.isArray(m.entities) ? m.entities : Array.isArray(m.caption_entities) ? m.caption_entities : [];
  const urls: string[] = [];
  const add = (u: string | null) => {
    if (u && !urls.includes(u) && urls.length < MAX_URLS) urls.push(u);
  };
  const cut: [number, number][] = [];
  for (const e of rawEntities as Entity[]) {
    const offset = typeof e.offset === 'number' ? e.offset : -1;
    const length = typeof e.length === 'number' ? e.length : 0;
    if (e.type === 'text_link' && typeof e.url === 'string') add(cleanUrl(e.url));
    if (e.type === 'url' && offset >= 0 && length > 0) {
      const piece = body.slice(offset, offset + length);
      add(cleanUrl(/^https?:\/\//i.test(piece) ? piece : `https://${piece}`));
      cut.push([offset, offset + length]);
    }
  }
  for (const match of body.matchAll(URL_IN_TEXT)) add(cleanUrl(match[0]));
  // The note: the text without the links.
  let rest = body;
  for (const [a, b] of cut.sort((x, y) => y[0] - x[0])) rest = rest.slice(0, a) + ' ' + rest.slice(b);
  rest = rest.replace(URL_IN_TEXT, ' ');
  return { urls, note: rest.replace(/\s+/g, ' ').trim() };
}

const sameChat = (a: unknown, b: unknown) => (typeof a === 'number' || typeof a === 'string') && String(a) === String(b);

/** Constant-time comparison of a sent code with the stored one (different lengths never match). */
function codeMatches(sent: string, expected: string): boolean {
  const a = Buffer.from(sent.toUpperCase(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * One getUpdates pass from the stored offset (setting telegram.offset, saved after every update, owner or not, so a
 * failure mid-batch never replays the updates before it). Returns how many updates arrived, how many finds were added
 * and how many updates were ignored (strangers, a bare /start, a wrong code, anything before pairing). A getUpdates
 * failure throws (token-free); a failed reply is only logged.
 */
export async function pollTelegram(deps: TelegramDeps): Promise<{ received: number; added: number; ignored: number }> {
  const { db } = deps;
  const addFinds = deps.addFinds ?? defaultAddFinds;
  const stored = await getSetting(db, TELEGRAM_OFFSET_KEY);
  const offset = typeof stored === 'number' && Number.isInteger(stored) && stored > 0 ? stored : null;
  const timeout = Math.max(0, Math.min(50, Math.floor(deps.timeoutSec ?? 0)));
  const query = `?${offset !== null ? `offset=${offset}&` : ''}timeout=${timeout}&limit=${MAX_UPDATES}&allowed_updates=${encodeURIComponent('["message"]')}`;
  const result = await call(deps, 'getUpdates', { query, timeoutMs: (timeout + 10) * 1000 });
  const updates = (Array.isArray(result) ? result : []) as Update[];
  const pinned = deps.ownerChatId?.trim() || null;
  let owner: unknown = pinned ?? (await getSetting(db, TELEGRAM_OWNER_KEY));
  const unpaired = () => owner === null || owner === undefined || owner === '';
  if (unpaired()) await ensurePairingCode(db);
  let next = offset ?? 0;
  const out = { received: 0, added: 0, ignored: 0 };
  for (const u of updates) {
    if (typeof u?.update_id !== 'number' || !Number.isInteger(u.update_id)) continue;
    out.received++;
    try {
      await handle(u);
    } catch (err) {
      if (!(await skipPoison(u.update_id, err))) throw err;
      out.ignored++;
    }
    if (u.update_id + 1 > next) {
      next = u.update_id + 1;
      await setSetting(db, TELEGRAM_OFFSET_KEY, next);
    }
  }
  return out;

  /** Counts a failure for this update; true (logged once) when it has now failed MAX_UPDATE_FAILURES times in a row. */
  async function skipPoison(updateId: number, err: unknown): Promise<boolean> {
    const prev = (await getSetting(db, TELEGRAM_FAILURES_KEY).catch(() => null)) as { updateId?: unknown; count?: unknown } | null;
    const count = (prev && prev.updateId === updateId && typeof prev.count === 'number' ? prev.count : 0) + 1;
    if (count < MAX_UPDATE_FAILURES) {
      await setSetting(db, TELEGRAM_FAILURES_KEY, { updateId, count }).catch(() => {});
      return false;
    }
    deps.log(sanitize(deps.token, `telegram: skipped an update after ${count} failed attempts (${err instanceof Error ? err.message : String(err)})`));
    await setSetting(db, TELEGRAM_FAILURES_KEY, null).catch(() => {});
    return true;
  }

  async function handle(u: Update): Promise<void> {
    const msg = u.message;
    const chatId = msg?.chat?.id;
    if (!msg || (typeof chatId !== 'number' && typeof chatId !== 'string')) {
      out.ignored++;
      return;
    }
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    const start = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/i.exec(text);
    const isStart = /^\/start(?:@\w+)?(?:\s|$)/i.test(text);
    if (unpaired()) {
      // A chat that used up its wrong guesses is ignored from then on, even with the right code (gen telegram reset clears it).
      if (await pairingLockedOut(db, chatId)) {
        out.ignored++;
        return;
      }
      const code = await readPairingCode(db);
      if (!start?.[1] || !code || !codeMatches(start[1], code)) {
        out.ignored++; // nobody owns the bot yet: only /start with the right code counts, and nothing is said back
        // A wrong code counts against this chat only; the shared code never changes because of guesses.
        if (start?.[1] && code && (await recordWrongPairingGuess(db, chatId))) deps.log('telegram: a chat was locked out after too many wrong pairing codes');
        return;
      }
      await pinTelegramOwner(db, chatId);
      owner = chatId;
      deps.log('telegram: paired with the owner chat');
      await sendTelegram(deps, chatId, 'Paired. Send me links to videos or posts you like and I will add them to your PitchLab library.');
      return;
    }
    if (!sameChat(chatId, owner)) {
      out.ignored++; // strangers get no reply and nothing is stored
      return;
    }
    if (isStart) {
      await sendTelegram(deps, chatId, 'Ready. Send me a link (and a note if you like).');
      return;
    }
    const { urls, note } = messageParts(msg);
    if (urls.length === 0) {
      await sendTelegram(deps, chatId, 'Send me a link to capture (you can add a note after it).');
      return;
    }
    const r = await addFinds(db, urls.map((url) => ({ url, note: note || undefined, source: 'telegram' as const })));
    out.added += r.added;
    let reply: string;
    if (r.added === 0 && r.duplicates > 0) reply = 'Already captured';
    else if (r.added === 0) reply = 'That link cannot be captured (only http and https links).';
    else if (r.duplicates > 0) reply = `Got it: ${r.added} new, ${r.duplicates} already captured.`;
    else reply = r.added === 1 ? 'Got it' : `Got it: ${r.added} links.`;
    await sendTelegram(deps, chatId, reply);
  }
}

const BACKOFF_FIRST_MS = 10_000;
const BACKOFF_MAX_MS = 5 * 60_000;

/**
 * Wraps the per-pass poll: after a failure (Telegram rate limiting, a timeout, a network drop) the next polls are skipped
 * for 10 s, doubling up to 5 minutes, so a bad spell neither hammers the API nor floods the log. Only the first failure
 * and the recovery are logged. Never throws.
 */
export function withBackoff(poll: () => Promise<void>, o: { log: (m: string) => void; now?: () => number }): () => Promise<void> {
  const now = o.now ?? Date.now;
  let failures = 0;
  let nextAt = 0;
  return async () => {
    if (now() < nextAt) return;
    try {
      await poll();
      if (failures > 0) o.log(`telegram: reachable again after ${failures} failed poll${failures === 1 ? '' : 's'}`);
      failures = 0;
      nextAt = 0;
    } catch (err) {
      failures++;
      if (failures === 1) o.log(`telegram poll failed: ${err instanceof Error ? err.message : String(err)} (retrying with a growing delay; repeats are not logged)`);
      nextAt = now() + Math.min(BACKOFF_FIRST_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
    }
  };
}
