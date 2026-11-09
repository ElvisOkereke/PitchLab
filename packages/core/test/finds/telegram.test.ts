import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client';
import { finds } from '../../src/db/schema';
import {
  MAX_GUESS_CHATS, MAX_PAIRING_GUESSES, TELEGRAM_GUESSES_KEY, TELEGRAM_OFFSET_KEY, TELEGRAM_OWNER_KEY, TELEGRAM_PAIRING_KEY, ensurePairingCode, resetTelegramPairing,
} from '../../src/dashboard/telegram';
import { addFinds } from '../../src/finds/store';
import { messageParts, pollTelegram, sendTelegram } from '../../src/finds/telegram';
import { getSetting, setSetting } from '../../src/validation/settings';
import { testDb } from '../helpers/db';

const TOKEN = '000000:fake-token-for-tests-only';
const OWNER = 1111;
const STRANGER = 2222;

type Msg = { chatId: number; text?: string; caption?: string; entities?: unknown[] };
const update = (id: number, m: Msg) => ({
  update_id: id,
  message: { message_id: id, chat: { id: m.chatId, type: 'private' }, from: { id: m.chatId }, date: 0, text: m.text, caption: m.caption, entities: m.entities },
});

/** A fake Bot API: queued getUpdates batches, records every call (url, body). */
function fakeTelegram(batches: unknown[][], o: { fail?: 'getUpdates' | 'sendMessage'; status?: number } = {}) {
  const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = url.split('/').pop()!.split('?')[0]!;
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (o.fail === method) {
      if (o.status) return new Response('{"ok":false}', { status: o.status });
      throw new Error(`connect ECONNREFUSED ${url}`);
    }
    if (method === 'getUpdates') return Response.json({ ok: true, result: batches.shift() ?? [] });
    return Response.json({ ok: true, result: {} });
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

const replies = (calls: { method: string; body: Record<string, unknown> | null }[]) =>
  calls.filter((c) => c.method === 'sendMessage').map((c) => ({ chat: c.body!.chat_id, text: c.body!.text, parse: c.body!.parse_mode }));

async function poll(db: Db, batches: unknown[][], logs: string[] = [], o: Parameters<typeof fakeTelegram>[1] = {}) {
  const tg = fakeTelegram(batches, o);
  const r = await pollTelegram({ db, token: TOKEN, fetch: tg.fetch, log: (m) => logs.push(m) });
  return { r, calls: tg.calls };
}

describe('messageParts', () => {
  it('takes urls from the text and from entities; the rest is the note', () => {
    const text = 'Look at this https://www.instagram.com/reel/ABC/?igsh=1 so good';
    expect(messageParts({ text })).toEqual({ urls: ['https://www.instagram.com/reel/ABC/?igsh=1'], note: 'Look at this so good' });
    // A text_link entity carries its url outside the text; a url entity points into it (UTF-16 offsets).
    const t2 = '🔥 idea here and tiktok.com/@a/video/1';
    const off = t2.indexOf('tiktok');
    expect(messageParts({
      text: t2,
      entities: [{ type: 'text_link', offset: 3, length: 4, url: 'https://example.com/article' }, { type: 'url', offset: off, length: t2.length - off }],
    }).urls).toEqual(['https://example.com/article', 'https://tiktok.com/@a/video/1']);
    expect(messageParts({ caption: 'see https://youtu.be/x.' }).urls).toEqual(['https://youtu.be/x']);
    expect(messageParts({ text: 'no links here' })).toEqual({ urls: [], note: 'no links here' });
    expect(messageParts({ text: 'javascript:alert(1) ftp://x.com/y' }).urls).toEqual([]);
  });
});

describe('pollTelegram', () => {
  it('binds the owner only on /start with the pairing code, then clears the code; replies are plain text', async () => {
    const db = await testDb();
    const code = await ensurePairingCode(db);
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    const { r, calls } = await poll(db, [[update(10, { chatId: OWNER, text: `/start ${code}` })]]);
    expect(await getSetting(db, TELEGRAM_OWNER_KEY)).toBe(OWNER);
    expect(await getSetting(db, TELEGRAM_PAIRING_KEY)).toBeNull();
    expect(r).toMatchObject({ received: 1, added: 0, ignored: 0 });
    const rs = replies(calls);
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ chat: OWNER, parse: undefined });
  });

  it('ignores a bare /start, a wrong code and links while unpaired, silently', async () => {
    const db = await testDb();
    const code = (await ensurePairingCode(db))!;
    const wrong = code.slice(0, 7) + (code[7] === 'A' ? 'B' : 'A');
    const out = await poll(db, [[
      update(1, { chatId: STRANGER, text: '/start' }),
      update(2, { chatId: STRANGER, text: `/start ${wrong}` }),
      update(3, { chatId: STRANGER, text: `/start ${code}x` }),
      update(4, { chatId: STRANGER, text: `https://example.com/a ${code}` }),
    ]]);
    expect(out.r).toMatchObject({ received: 4, added: 0, ignored: 4 });
    expect(replies(out.calls)).toEqual([]);
    expect(await getSetting(db, TELEGRAM_OWNER_KEY)).toBeNull();
    expect(await getSetting(db, TELEGRAM_PAIRING_KEY)).toBe(code);
    expect(await db.select().from(finds)).toHaveLength(0);
  });

  it('a poll while unpaired creates the pairing code when there is none', async () => {
    const db = await testDb();
    await poll(db, [[update(1, { chatId: STRANGER, text: '/start' })]]);
    expect(await getSetting(db, TELEGRAM_PAIRING_KEY)).toMatch(/^[A-Z2-9]{8}$/);
    expect(await getSetting(db, TELEGRAM_OWNER_KEY)).toBeNull();
  });

  it('two /start <code> in one batch: the first binds, the second is a stranger', async () => {
    const db = await testDb();
    const code = (await ensurePairingCode(db))!;
    const out = await poll(db, [[update(1, { chatId: OWNER, text: `/start ${code}` }), update(2, { chatId: STRANGER, text: `/start ${code}` })]]);
    expect(await getSetting(db, TELEGRAM_OWNER_KEY)).toBe(OWNER);
    expect(out.r).toMatchObject({ received: 2, ignored: 1 });
    expect(replies(out.calls).map((x) => x.chat)).toEqual([OWNER]);
  });

  it('an owner pinned by TELEGRAM_OWNER_CHAT_ID wins over the code and the stored owner', async () => {
    const db = await testDb();
    await setSetting(db, TELEGRAM_OWNER_KEY, STRANGER);
    const code = (await ensurePairingCode(db))!;
    const tg = fakeTelegram([[update(1, { chatId: STRANGER, text: `/start ${code}` }), update(2, { chatId: OWNER, text: 'https://example.com/pinned' })]]);
    const r = await pollTelegram({ db, token: TOKEN, fetch: tg.fetch, log: () => {}, ownerChatId: String(OWNER) });
    expect(r).toMatchObject({ received: 2, added: 1, ignored: 1 });
    expect(replies(tg.calls).map((x) => x.chat)).toEqual([OWNER]);
  });

  it('ignores strangers silently and stores nothing once paired', async () => {
    const db = await testDb();
    await setSetting(db, TELEGRAM_OWNER_KEY, OWNER);
    const out = await poll(db, [[update(2, { chatId: STRANGER, text: '/start' }), update(3, { chatId: STRANGER, text: 'https://example.com/b' })]]);
    expect(out.r).toMatchObject({ received: 2, added: 0, ignored: 2 });
    expect(replies(out.calls)).toEqual([]);
    expect(await getSetting(db, TELEGRAM_OWNER_KEY)).toBe(OWNER);
    expect(await db.select().from(finds)).toHaveLength(0);
  });

  it('saves the offset after each update, so a failure mid-batch does not replay the earlier ones', async () => {
    const db = await testDb();
    await setSetting(db, TELEGRAM_OWNER_KEY, OWNER);
    const tg = fakeTelegram([[update(50, { chatId: OWNER, text: 'https://example.com/1' }), update(51, { chatId: OWNER, text: 'https://example.com/2' })]]);
    let n = 0;
    const add: typeof addFinds = async (d, items) => {
      if (++n === 2) throw new Error('db down');
      return addFinds(d, items);
    };
    await expect(pollTelegram({ db, token: TOKEN, fetch: tg.fetch, log: () => {}, addFinds: add })).rejects.toThrow('db down');
    expect(await getSetting(db, TELEGRAM_OFFSET_KEY)).toBe(51);
  });

  it('turns the owner\'s links into finds, replies "Got it", and "Already captured" for a repeat', async () => {
    const db = await testDb();
    await setSetting(db, TELEGRAM_OWNER_KEY, OWNER);
    const { r, calls } = await poll(db, [[
      update(5, { chatId: OWNER, text: 'Check https://www.tiktok.com/@a/video/1?_t=x neat' }),
      update(6, { chatId: OWNER, text: 'https://www.tiktok.com/@a/video/1' }),
    ]]);
    expect(r).toMatchObject({ received: 2, added: 1, ignored: 0 });
    const rows = await db.select().from(finds);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'telegram', note: 'Check neat', url: 'https://www.tiktok.com/@a/video/1' });
    expect(replies(calls).map((x) => x.text)).toEqual([expect.stringMatching(/^Got it/), 'Already captured']);
  });

  it('advances the offset past every update and asks from it next time', async () => {
    const db = await testDb();
    await setSetting(db, TELEGRAM_OWNER_KEY, OWNER);
    const first = await poll(db, [[update(41, { chatId: STRANGER, text: 'x' }), update(42, { chatId: OWNER, text: 'hello' })]]);
    expect(await getSetting(db, TELEGRAM_OFFSET_KEY)).toBe(43);
    expect(first.calls[0]!.url).not.toContain('offset=');
    const second = await poll(db, [[]]);
    expect(second.calls[0]!.url).toContain('offset=43');
    expect(second.calls[0]!.url).toContain('timeout=0');
    expect(await getSetting(db, TELEGRAM_OFFSET_KEY)).toBe(43);
  });

  it('never puts the token in logs or thrown errors', async () => {
    const db = await testDb();
    const logs: string[] = [];
    await expect(poll(db, [[]], logs, { fail: 'getUpdates' })).rejects.toSatisfy((e: Error) => !e.message.includes(TOKEN) && !e.message.includes('fake-token'));
    await expect(poll(db, [[]], logs, { fail: 'getUpdates', status: 401 })).rejects.toSatisfy((e: Error) => !e.message.includes(TOKEN));
    await setSetting(db, TELEGRAM_OWNER_KEY, OWNER);
    // A failing reply is logged, never thrown, and the log has no token.
    const { r } = await poll(db, [[update(7, { chatId: OWNER, text: 'https://example.com/z' })]], logs, { fail: 'sendMessage' });
    expect(r.added).toBe(1);
    expect(logs.length).toBeGreaterThan(0);
    for (const l of logs) {
      expect(l).not.toContain(TOKEN);
      expect(l).not.toContain('fake-token');
    }
  });

  it("a stranger's 50 wrong guesses never change the code; the owner still pairs with the displayed code", async () => {
    const db = await testDb();
    const code = (await ensurePairingCode(db))!;
    const wrong = code.slice(0, 7) + (code[7] === 'A' ? 'B' : 'A');
    const guesses = (from: number, count: number) => Array.from({ length: count }, (_, i) => update(from + i, { chatId: STRANGER, text: `/start ${wrong}` }));
    await poll(db, [guesses(1, 25)]);
    await poll(db, [guesses(26, 25)]);
    expect(await getSetting(db, TELEGRAM_PAIRING_KEY)).toBe(code);
    // Counted per chat, capped at the lockout (a locked chat is no longer counted).
    expect(await getSetting(db, TELEGRAM_GUESSES_KEY)).toEqual({ [String(STRANGER)]: MAX_PAIRING_GUESSES });
    await poll(db, [[update(60, { chatId: OWNER, text: `/start ${code}` })]]);
    expect(await getSetting(db, TELEGRAM_OWNER_KEY)).toBe(OWNER);
    expect(await getSetting(db, TELEGRAM_GUESSES_KEY)).toBeNull();
  });

  it('a chat with 10 wrong guesses (across passes) is ignored from then on, even with the right code; a bare /start is not a guess', async () => {
    const db = await testDb();
    const code = (await ensurePairingCode(db))!;
    const wrong = code.slice(0, 7) + (code[7] === 'A' ? 'B' : 'A');
    const guesses = (from: number, count: number) => Array.from({ length: count }, (_, i) => update(from + i, { chatId: STRANGER, text: `/start ${wrong}` }));
    await poll(db, [guesses(1, 5)]);
    await poll(db, [[update(6, { chatId: STRANGER, text: '/start' }), ...guesses(7, 4)]]);
    expect(await getSetting(db, TELEGRAM_GUESSES_KEY)).toEqual({ [String(STRANGER)]: 9 });
    await poll(db, [guesses(11, 1)]);
    const out = await poll(db, [[update(12, { chatId: STRANGER, text: `/start ${code}` })]]);
    expect(out.r).toMatchObject({ received: 1, ignored: 1 });
    expect(replies(out.calls)).toEqual([]);
    expect(await getSetting(db, TELEGRAM_OWNER_KEY)).toBeNull();
    expect(await getSetting(db, TELEGRAM_PAIRING_KEY)).toBe(code);
    // gen telegram reset clears the counters (and makes a new code).
    const fresh = await resetTelegramPairing(db);
    expect(await getSetting(db, TELEGRAM_GUESSES_KEY)).toBeNull();
    await poll(db, [[update(13, { chatId: STRANGER, text: `/start ${fresh}` })]]);
    expect(await getSetting(db, TELEGRAM_OWNER_KEY)).toBe(STRANGER);
  });

  it('keeps wrong-guess counters for at most 200 chats, dropping the lowest counts first (locked chats are kept)', async () => {
    const db = await testDb();
    const code = (await ensurePairingCode(db))!;
    const wrong = code.slice(0, 7) + (code[7] === 'A' ? 'B' : 'A');
    const seeded: Record<string, number> = { [String(STRANGER)]: MAX_PAIRING_GUESSES };
    for (let i = 0; i < MAX_GUESS_CHATS - 1; i++) seeded[String(900_000 + i)] = 1;
    await setSetting(db, TELEGRAM_GUESSES_KEY, seeded);
    await poll(db, [[update(1, { chatId: 5555, text: `/start ${wrong}` })]]);
    const after = (await getSetting(db, TELEGRAM_GUESSES_KEY)) as Record<string, number>;
    expect(Object.keys(after)).toHaveLength(MAX_GUESS_CHATS);
    expect(after['5555']).toBe(1);
    expect(after[String(STRANGER)]).toBe(MAX_PAIRING_GUESSES);
    expect(await getSetting(db, TELEGRAM_PAIRING_KEY)).toBe(code);
  });

  it('skips an update that fails 3 times in a row (offset advanced, logged once) and carries on', async () => {
    const db = await testDb();
    await setSetting(db, TELEGRAM_OWNER_KEY, OWNER);
    const logs: string[] = [];
    const add: typeof addFinds = async (d, items) => {
      if (items.some((i) => i.url.includes('/poison'))) throw new Error('db down');
      return addFinds(d, items);
    };
    const batch = () => [update(60, { chatId: OWNER, text: 'https://example.com/poison' }), update(61, { chatId: OWNER, text: 'https://example.com/fine' })];
    const run = () => pollTelegram({ db, token: TOKEN, fetch: fakeTelegram([batch()]).fetch, log: (m) => logs.push(m), addFinds: add });
    await expect(run()).rejects.toThrow('db down');
    await expect(run()).rejects.toThrow('db down');
    expect(await getSetting(db, TELEGRAM_OFFSET_KEY)).toBeNull();
    const r = await run();
    expect(r).toMatchObject({ received: 2, added: 1 });
    expect(await getSetting(db, TELEGRAM_OFFSET_KEY)).toBe(62);
    expect(logs.filter((l) => l.startsWith('telegram: skipped an update after 3 failed attempts'))).toHaveLength(1);
    expect((await db.select().from(finds)).map((f) => f.url)).toEqual(['https://example.com/fine']);
  });

  it('sendTelegram posts plain text to the fixed host and reports failure without the token', async () => {
    const tg = fakeTelegram([]);
    expect(await sendTelegram({ token: TOKEN, fetch: tg.fetch, log: () => {} }, OWNER, 'Captured: x')).toBe(true);
    expect(tg.calls[0]!.url.startsWith('https://api.telegram.org/bot')).toBe(true);
    expect(tg.calls[0]!.body).toEqual({ chat_id: OWNER, text: 'Captured: x' });
    const logs: string[] = [];
    const bad = fakeTelegram([], { fail: 'sendMessage' });
    expect(await sendTelegram({ token: TOKEN, fetch: bad.fetch, log: (m) => logs.push(m) }, OWNER, 'x')).toBe(false);
    expect(logs.join('\n')).not.toContain(TOKEN);
  });
});
