import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { finds } from '../../src/db/schema';
import { addFinds, deleteFind, findPlatform, listFinds, normalizeFindUrl, retryFind } from '../../src/finds/store';
import { testDb } from '../helpers/db';

describe('normalizeFindUrl', () => {
  it('strips tracking parameters, the fragment and a trailing slash, and lowercases the host', () => {
    expect(normalizeFindUrl('https://WWW.Instagram.com/reel/AbC123/?igsh=xyz&utm_source=ig_web#frag')).toBe('https://www.instagram.com/reel/AbC123');
    expect(normalizeFindUrl('https://www.tiktok.com/@maker/video/123?is_from_webapp=1&sender_device=pc&_t=8abc&_r=1')).toBe('https://www.tiktok.com/@maker/video/123');
    expect(normalizeFindUrl('https://youtube.com/shorts/xyz?si=abcdef&feature=share')).toBe('https://youtube.com/shorts/xyz');
    expect(normalizeFindUrl('https://example.com/a?b=2&a=1&fbclid=1&gclid=2')).toBe('https://example.com/a?a=1&b=2');
    expect(normalizeFindUrl('https://www.youtube.com/watch?v=abc&t=10')).toBe('https://www.youtube.com/watch?t=10&v=abc');
  });

  it('refuses non-http(s) links, credentials in the link and junk', () => {
    expect(normalizeFindUrl('ftp://example.com/x')).toBeNull();
    expect(normalizeFindUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeFindUrl('https://user:pw@example.com/')).toBeNull();
    expect(normalizeFindUrl('not a link')).toBeNull();
    expect(normalizeFindUrl(`https://example.com/${'a'.repeat(3000)}`)).toBeNull();
  });

  it('names the platform from the host', () => {
    expect(findPlatform('https://www.instagram.com/reel/x')).toBe('instagram');
    expect(findPlatform('https://vm.tiktok.com/x')).toBe('tiktok');
    expect(findPlatform('https://youtu.be/x')).toBe('youtube');
    expect(findPlatform('https://x.com/a/status/1')).toBe('x');
    expect(findPlatform('https://www.threads.net/@a/post/1')).toBe('threads');
    expect(findPlatform('https://blog.example.com/post')).toBe('other');
  });
});

describe('finds store', () => {
  it('adds finds once per normalised url; the same link again counts as a duplicate', async () => {
    const db = await testDb();
    const r1 = await addFinds(db, [
      { url: 'https://www.instagram.com/reel/AbC123/?igsh=1', note: 'cool  idea', source: 'telegram' },
      { url: 'https://www.instagram.com/reel/AbC123', source: 'paste' },
      { url: 'nope', source: 'paste' },
    ]);
    expect(r1).toMatchObject({ added: 1, duplicates: 1, invalid: 1 });
    expect(r1.results.map((x) => x.outcome)).toEqual(['added', 'duplicate', 'invalid']);
    const r2 = await addFinds(db, [{ url: 'https://www.instagram.com/reel/AbC123?utm_campaign=x', source: 'paste' }]);
    expect(r2).toMatchObject({ added: 0, duplicates: 1 });
    const rows = await db.select().from(finds);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ url: 'https://www.instagram.com/reel/AbC123', platform: 'instagram', status: 'queued', source: 'telegram', note: 'cool idea' });
  });

  it('lists newest first, retries only failed finds and deletes', async () => {
    const db = await testDb();
    await addFinds(db, [{ url: 'https://example.com/1', source: 'paste' }]);
    await addFinds(db, [{ url: 'https://example.com/2', source: 'paste' }]);
    // Distinct creation times (two inserts can share a timestamp).
    await db.update(finds).set({ createdAt: new Date('2026-11-08T10:00:00Z') }).where(eq(finds.url, 'https://example.com/1'));
    await db.update(finds).set({ createdAt: new Date('2026-11-08T11:00:00Z') }).where(eq(finds.url, 'https://example.com/2'));
    const list = await listFinds(db);
    expect(list.map((f) => f.url)).toEqual(['https://example.com/2', 'https://example.com/1']);
    const [a, b] = list;
    expect(await retryFind(db, a!.id)).toBe(false); // queued, nothing to retry
    await db.update(finds).set({ status: 'failed', error: 'boom' }).where(eq(finds.id, a!.id));
    expect(await retryFind(db, a!.id)).toBe(true);
    const [again] = await db.select().from(finds).where(eq(finds.id, a!.id));
    expect(again).toMatchObject({ status: 'queued', error: null });
    expect(await deleteFind(db, b!.id)).toBe(true);
    expect(await deleteFind(db, b!.id)).toBe(false);
    expect(await listFinds(db)).toHaveLength(1);
    expect(await retryFind(db, 'not-a-uuid')).toBe(false);
  });

  it('caps the note and strips invisible characters', async () => {
    const db = await testDb();
    await addFinds(db, [{ url: 'https://example.com/n', note: `a​b ${'x'.repeat(2000)}`, source: 'paste' }]);
    const [row] = await db.select().from(finds);
    expect(row!.note!.startsWith('ab ')).toBe(true);
    expect(row!.note!.length).toBeLessThanOrEqual(500);
  });
});
