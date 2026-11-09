import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client';
import { finds } from '../../src/db/schema';
import { TELEGRAM_OFFSET_KEY, TELEGRAM_OWNER_KEY, messageParts, pollTelegram, sendTelegram } from '../../src/finds/telegram';
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
  it('locks the owner on the first /start and replies in plain text', async () => {
    const db = await testDb();
    const { r, calls } = await poll(db, [[update(10, { chatId: OWNER, text: '/start' })]]);
    expect(await getSetting(db, TELEGRAM_OWNER_KEY)).toBe(OWNER);
    expect(r).toMatchObject({ received: 1, added: 0, ignored: 0 });
    const rs = replies(calls);
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ chat: OWNER, parse: undefined });
  });

  it('ignores strangers silently and stores nothing, before and after the lock', async () => {
    const db = await testDb();
    // Before any /start: a link from anyone is ignored (no owner yet).
    let out = await poll(db, [[update(1, { chatId: STRANGER, text: 'https://example.com/a' })]]);
    expect(out.r).toMatchObject({ received: 1, added: 0, ignored: 1 });
    expect(replies(out.calls)).toEqual([]);
    await setSetting(db, TELEGRAM_OWNER_KEY, OWNER);
    out = await poll(db, [[update(2, { chatId: STRANGER, text: '/start' }), update(3, { chatId: STRANGER, text: 'https://example.com/b' })]]);
    expect(out.r).toMatchObject({ received: 2, added: 0, ignored: 2 });
    expect(replies(out.calls)).toEqual([]);
    expect(await getSetting(db, TELEGRAM_OWNER_KEY)).toBe(OWNER);
    expect(await db.select().from(finds)).toHaveLength(0);
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
