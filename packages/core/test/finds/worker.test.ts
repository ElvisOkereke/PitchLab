import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client';
import { finds, knowledgeItems, knowledgeSources } from '../../src/db/schema';
import { addFinds } from '../../src/finds/store';
import { STALE_CAPTURE_MS, hasQueuedFinds, runFindsJob, type FindCaptureResult, type FindsDeps } from '../../src/finds/worker';
import type { ModelRouter } from '../../src/llm/types';
import { testDb, unit } from '../helpers/db';

const TRANSCRIPT = 'I charge dentists two hundred dollars a month to answer their missed calls with an AI receptionist and they love it.';
const CAPTION = 'How I make 10k a month with one tiny service @bigcreator #ai';

const okCapture = (over: Partial<Extract<FindCaptureResult, { ok: true }>> = {}): FindCaptureResult => ({
  ok: true, platform: 'tiktok', title: 'Tiny AI service', caption: CAPTION, transcript: TRANSCRIPT, screenText: 'MISSED CALLS = LOST MONEY',
  stats: { views: 120000, likes: 5400 }, warnings: [], ...over,
});

type Extraction = { title: string; summary: string; quote: string | null; facts: Record<string, unknown> };
const extraction = (over: Partial<Extraction> = {}): Extraction => ({
  title: 'AI receptionist for dentists, sold by @bigcreator',
  summary: 'A solo operator sells missed-call answering to dental clinics on a monthly plan. Contact me at a@b.com.',
  quote: 'I charge dentists two hundred dollars a month to answer their missed calls',
  facts: { what: 'AI answers missed calls for dentists', whoPays: 'dental clinics', howItEarns: '$200/month subscription', whyItWorks: 'missed calls are lost patients', claims: ['makes 10k a month'], creatorType: 'solo operator' },
  ...over,
});

function router(o: { out?: Extraction; fail?: boolean } = {}) {
  const prompts: string[] = [];
  const versions: string[] = [];
  const r: ModelRouter = {
    modelFor: () => 'm',
    async text() { throw new Error('unused'); },
    async research() { throw new Error('unused'); },
    async structured(_stage, req, ctx) {
      prompts.push(req.prompt);
      versions.push(ctx.promptVersion);
      if (o.fail) throw new Error('model down');
      return req.schema.parse({ audience: 'business', countries: ['us'], industries: ['Dental'], ...(o.out ?? extraction()) });
    },
    async embed(texts) { return texts.map((_, i) => unit(i)); },
  };
  return { r, prompts, versions };
}

async function job(db: Db, capture: FindsDeps['capture'], o: Partial<FindsDeps> = {}, rt = router()) {
  const logs: string[] = [];
  const res = await runFindsJob({ db, router: rt.r, log: (m) => logs.push(m), capture, ...o });
  return { res, logs, rt };
}

const findRow = async (db: Db) => (await db.select().from(finds))[0]!;

describe('runFindsJob', () => {
  it('captures, extracts one find entry, links it and replies on Telegram', async () => {
    const db = await testDb();
    await addFinds(db, [{ url: 'https://www.tiktok.com/@bigcreator/video/1', note: 'dentists!', source: 'telegram' }]);
    const statuses: string[] = [];
    const capture = vi.fn(async () => {
      statuses.push((await findRow(db)).status);
      return okCapture();
    });
    const notify = vi.fn(async () => {});
    const { res, rt } = await job(db, capture, { notify });
    expect(res).toEqual({ captured: 1, failed: 0 });
    expect(statuses).toEqual(['capturing']);
    const f = await findRow(db);
    expect(f).toMatchObject({ status: 'done', title: 'Tiny AI service', error: null, platform: 'tiktok' });
    expect(f.capturedAt).toBeInstanceOf(Date);
    expect(f.stats).toMatchObject({ views: 120000, likes: 5400 });
    expect(f.caption).not.toContain('bigcreator');
    const [item] = await db.select().from(knowledgeItems);
    expect(f.knowledgeItemId).toBe(item!.id);
    expect(item).toMatchObject({ kind: 'find', quoteVerified: true });
    expect(item!.facts).toMatchObject({ what: 'AI answers missed calls for dentists', platform: 'tiktok', views: 120000, likes: 5400, claims: ['makes 10k a month'] });
    // Handles and emails are not stored in the entry text.
    expect(`${item!.title} ${item!.summary} ${JSON.stringify(item!.facts)}`).not.toMatch(/bigcreator|a@b\.com/);
    const [src] = await db.select().from(knowledgeSources);
    expect(src).toMatchObject({ url: 'https://www.tiktok.com/@bigcreator/video/1', sourceType: 'tiktok', quoteVerified: true });
    // The model sees the texts wrapped as untrusted, and the note.
    expect(rt.prompts[0]).toContain('<transcript>');
    expect(rt.prompts[0]).toContain('dentists!');
    expect(rt.versions[0]).toBe('finds:find-extract.v1');
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/^Captured: Tiny AI service/));
  });

  it('keeps a quote that is not in the captured text unverified', async () => {
    const db = await testDb();
    await addFinds(db, [{ url: 'https://www.instagram.com/reel/q', source: 'paste' }]);
    const notify = vi.fn(async () => {});
    await job(db, async () => okCapture(), { notify }, router({ out: extraction({ quote: 'I make a million dollars every single week from this one simple trick' }) }));
    const [item] = await db.select().from(knowledgeItems);
    expect(item!.quoteVerified).toBe(false);
    const [src] = await db.select().from(knowledgeSources);
    expect(src!.quoteVerified).toBe(false);
    expect(notify).not.toHaveBeenCalled(); // pasted, not from Telegram
  });

  it('a failed capture with page text still makes an entry, with a warning', async () => {
    const db = await testDb();
    await addFinds(db, [{ url: 'https://blog.example.com/post', source: 'paste' }]);
    const pageText = `Article. ${TRANSCRIPT} More words.`;
    await job(db, async () => ({ ok: false, platform: 'other', error: 'Not a supported video platform; read as a page instead.', fallback: { caption: 'An article', pageText } }));
    const f = await findRow(db);
    expect(f.status).toBe('done');
    expect(f.warnings.join(' ')).toMatch(/page/i);
    const [item] = await db.select().from(knowledgeItems);
    expect(item!.quoteVerified).toBe(true);
  });

  it('a failed capture with nothing usable keeps a readable error, and the job carries on', async () => {
    const db = await testDb();
    await addFinds(db, [{ url: 'https://www.instagram.com/p/private', source: 'telegram' }]);
    await addFinds(db, [{ url: 'https://www.tiktok.com/@x/video/2', source: 'paste' }]);
    const notify = vi.fn(async () => {});
    const capture = vi.fn(async (url: string) =>
      url.includes('private') ? { ok: false as const, platform: 'instagram' as const, error: 'yt-dlp: login required (token=abcdef0123456789abcdef0123)' } : okCapture());
    const { res } = await job(db, capture, { notify, limit: 5 });
    expect(res).toEqual({ captured: 1, failed: 1 });
    const rows = Object.fromEntries((await db.select().from(finds)).map((f) => [f.url, f]));
    const bad = rows['https://www.instagram.com/p/private']!;
    expect(bad).toMatchObject({ status: 'failed', knowledgeItemId: null });
    expect(bad.error).toContain('login required');
    expect(bad.error).not.toContain('abcdef0123456789abcdef0123');
    expect(rows['https://www.tiktok.com/@x/video/2']!.status).toBe('done');
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/^Could not capture/));
  });

  it('a capture that throws, or an extraction that fails, marks the find failed', async () => {
    const db = await testDb();
    await addFinds(db, [{ url: 'https://example.com/throw', source: 'paste' }]);
    await job(db, async () => { throw new Error('spawn exploded'); });
    expect(await findRow(db)).toMatchObject({ status: 'failed', error: expect.stringContaining('spawn exploded') });
    await db.update(finds).set({ status: 'queued', error: null });
    await job(db, async () => okCapture(), {}, router({ fail: true }));
    expect(await findRow(db)).toMatchObject({ status: 'failed', error: expect.stringMatching(/extract/i) });
    expect(await db.select().from(knowledgeItems)).toHaveLength(0);
  });

  it('puts a capture stuck for over 15 minutes back in the queue, and leaves a fresh one', async () => {
    const db = await testDb();
    await addFinds(db, [{ url: 'https://example.com/stale', source: 'paste' }, { url: 'https://example.com/fresh', source: 'paste' }]);
    const now = new Date('2026-11-08T12:00:00Z');
    await db.update(finds).set({ status: 'capturing', startedAt: new Date(now.getTime() - STALE_CAPTURE_MS - 1000) }).where(eq(finds.url, 'https://example.com/stale'));
    await db.update(finds).set({ status: 'capturing', startedAt: new Date(now.getTime() - 60_000) }).where(eq(finds.url, 'https://example.com/fresh'));
    const capture = vi.fn(async () => okCapture());
    const { res } = await job(db, capture, { now: () => now, limit: 5 });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith('https://example.com/stale');
    expect(res.captured).toBe(1);
    const rows = Object.fromEntries((await db.select().from(finds)).map((f) => [f.url, f.status]));
    expect(rows).toEqual({ 'https://example.com/stale': 'done', 'https://example.com/fresh': 'capturing' });
  });

  it('hasQueuedFinds sees queued and stale captures only', async () => {
    const db = await testDb();
    const now = new Date('2026-11-08T12:00:00Z');
    expect(await hasQueuedFinds(db, now)).toBe(false);
    await addFinds(db, [{ url: 'https://example.com/h', source: 'paste' }]);
    expect(await hasQueuedFinds(db, now)).toBe(true);
    await db.update(finds).set({ status: 'capturing', startedAt: new Date(now.getTime() - 60_000) });
    expect(await hasQueuedFinds(db, now)).toBe(false);
    await db.update(finds).set({ startedAt: new Date(now.getTime() - STALE_CAPTURE_MS - 1) });
    expect(await hasQueuedFinds(db, now)).toBe(true);
    await db.update(finds).set({ status: 'done' });
    expect(await hasQueuedFinds(db, now)).toBe(false);
  });

  it('takes at most `limit` finds, oldest first, and does nothing when the queue is empty', async () => {
    const db = await testDb();
    expect((await job(db, async () => okCapture())).res).toEqual({ captured: 0, failed: 0 });
    await addFinds(db, [{ url: 'https://example.com/1', source: 'paste' }]);
    await addFinds(db, [{ url: 'https://example.com/2', source: 'paste' }]);
    // Distinct creation times (two inserts can share a timestamp).
    await db.update(finds).set({ createdAt: new Date('2026-11-08T10:00:00Z') }).where(eq(finds.url, 'https://example.com/1'));
    await db.update(finds).set({ createdAt: new Date('2026-11-08T11:00:00Z') }).where(eq(finds.url, 'https://example.com/2'));
    const capture = vi.fn(async () => okCapture());
    await job(db, capture, { limit: 1 });
    expect((capture.mock.calls as unknown as [string][]).map((c) => c[0])).toEqual(['https://example.com/1']);
  });
});
