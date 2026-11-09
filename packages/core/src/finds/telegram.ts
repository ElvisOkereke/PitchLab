import type { Db } from '../db/client';
import { request, SourceError } from '../research/http';
import { scrubSecrets } from '../tools/scrub';
import { getSetting, setSetting } from '../validation/settings';
import { addFinds } from './store';

/**
 * The private Telegram bot (worker-side, outbound only): getUpdates on api.telegram.org, never a webhook. The first chat
 * that sends /start becomes the owner (setting telegram.ownerChatId); every other chat is ignored silently and nothing
 * from it is stored. Links in the owner's messages become finds; the rest of the text is the note. Replies are plain
 * text (no parse mode).
 *
 * The token appears only in the request url path. Request errors never carry the url (http.ts), and every message this
 * module logs or throws has the token removed as well (sanitize), so it never reaches a log, a heartbeat or a row.
 */

export const TELEGRAM_OWNER_KEY = 'telegram.ownerChatId';
export const TELEGRAM_OFFSET_KEY = 'telegram.offset';
const API = 'https://api.telegram.org';
const MAX_UPDATES = 50;
const MAX_TEXT = 4096;
const MAX_URLS = 10;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCT = /[.,;:!?)\]}'"»”’]+$/;

export type TelegramTransport = { token: string; fetch?: typeof fetch; log: (m: string) => void };
export type TelegramDeps = TelegramTransport & {
  db: Db;
  /** getUpdates `timeout` in seconds. 0 (the default) returns at once, so a worker pass is never held. */
  timeoutSec?: number;
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

/**
 * One getUpdates pass from the stored offset (setting telegram.offset, advanced past every update seen, owner or not).
 * Returns how many updates arrived, how many finds were added and how many updates were ignored (strangers, or links
 * before an owner exists). A getUpdates failure throws (token-free); a failed reply is only logged.
 */
export async function pollTelegram(deps: TelegramDeps): Promise<{ received: number; added: number; ignored: number }> {
  const { db } = deps;
  const stored = await getSetting(db, TELEGRAM_OFFSET_KEY);
  const offset = typeof stored === 'number' && Number.isInteger(stored) && stored > 0 ? stored : null;
  const timeout = Math.max(0, Math.min(50, Math.floor(deps.timeoutSec ?? 0)));
  const query = `?${offset !== null ? `offset=${offset}&` : ''}timeout=${timeout}&limit=${MAX_UPDATES}&allowed_updates=${encodeURIComponent('["message"]')}`;
  const result = await call(deps, 'getUpdates', { query, timeoutMs: (timeout + 10) * 1000 });
  const updates = (Array.isArray(result) ? result : []) as Update[];
  let owner = await getSetting(db, TELEGRAM_OWNER_KEY);
  let next = offset ?? 0;
  const out = { received: 0, added: 0, ignored: 0 };
  for (const u of updates) {
    if (typeof u?.update_id !== 'number' || !Number.isInteger(u.update_id)) continue;
    out.received++;
    next = Math.max(next, u.update_id + 1);
    const msg = u.message;
    const chatId = msg?.chat?.id;
    if (!msg || (typeof chatId !== 'number' && typeof chatId !== 'string')) {
      out.ignored++;
      continue;
    }
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    const isStart = /^\/start(?:@\w+)?(?:\s|$)/i.test(text);
    if (owner === null || owner === undefined) {
      if (!isStart) {
        out.ignored++; // nobody owns the bot yet: only /start counts
        continue;
      }
      await setSetting(db, TELEGRAM_OWNER_KEY, chatId);
      owner = chatId;
      deps.log('telegram: owner chat saved');
      await sendTelegram(deps, chatId, 'Hi! Send me links to videos or posts you like and I will add them to your PitchLab library.');
      continue;
    }
    if (!sameChat(chatId, owner)) {
      out.ignored++; // strangers get no reply and nothing is stored
      continue;
    }
    if (isStart) {
      await sendTelegram(deps, chatId, 'Ready. Send me a link (and a note if you like).');
      continue;
    }
    const { urls, note } = messageParts(msg);
    if (urls.length === 0) {
      await sendTelegram(deps, chatId, 'Send me a link to capture (you can add a note after it).');
      continue;
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
  if (next > (offset ?? 0)) await setSetting(db, TELEGRAM_OFFSET_KEY, next);
  return out;
}
