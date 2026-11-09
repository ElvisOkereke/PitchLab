import type { Db } from '@bcg/core/db/client';
import { finds, runs } from '@bcg/core/db/schema';
import { addFinds } from '@bcg/core/finds/store';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, snapshotDb } from '../helpers/db';
import { request, resetRequest } from '../helpers/next-mocks';

const state = vi.hoisted(() => ({ db: undefined as unknown as Db }));

vi.mock('@/lib/db', () => ({ getDb: () => state.db }));
vi.mock('@/lib/auth/require-owner', () => ({ requireOwnerAction: async () => {}, requireOwner: async () => {} }));
vi.mock('next/cache', () => import('../helpers/next-mocks').then((m) => m.nextCacheMock));

const { addFindsAction, retryFindAction, deleteFindAction, startRunFromFindsAction } = await import('@/actions/finds');

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

beforeEach(async () => {
  state.db = await createTestDb();
  resetRequest();
});

describe('addFindsAction', () => {
  it('saves one find per line, with an optional note after the first space', async () => {
    const r = await addFindsAction({}, form({ links: 'https://www.tiktok.com/@a/video/1 great hook for plumbers\n\n  https://example.com/post  \n' }));
    expect(r.ok).toBe(true);
    expect(r.notice).toContain('Added 2');
    const rows = await state.db.select().from(finds);
    expect(rows).toHaveLength(2);
    expect(rows.find((x) => x.platform === 'tiktok')).toMatchObject({ note: 'great hook for plumbers', source: 'paste', status: 'queued' });
    expect(request.revalidated).toContain('/library/finds');
  });

  it('reports duplicates without a second row', async () => {
    await addFinds(state.db, [{ url: 'https://example.com/post', source: 'telegram' }]);
    const r = await addFindsAction({}, form({ links: 'https://example.com/post?utm_source=x' }));
    expect(r.ok).toBe(true);
    expect(r.notice).toBe('Added 0, 1 already in your finds.');
    expect(await state.db.select().from(finds)).toHaveLength(1);
  });

  it('refuses a line that is not an http(s) link, names the line, writes nothing', async () => {
    const before = await snapshotDb(state.db);
    for (const bad of ['javascript:alert(1)', 'ftp://example.com/a', 'just words', 'https://ok.example/a\nnot a link']) {
      const r = await addFindsAction({}, form({ links: bad }));
      expect(r.ok).toBeUndefined();
      expect(r.error).toMatch(/^Line \d+ is not an http or https link\.$/);
      expect(r.values?.links).toBe(bad);
    }
    expect(await snapshotDb(state.db)).toEqual(before);
    // Line numbers count blank lines, so they match what the owner sees in the box.
    expect((await addFindsAction({}, form({ links: 'https://ok.example/a\n\n  \nnot a link' }))).error).toBe('Line 4 is not an http or https link.');
  });

  it('refuses an empty paste and more than 50 lines', async () => {
    expect((await addFindsAction({}, form({ links: '  \n ' }))).error).toBe('Paste at least one link.');
    const many = Array.from({ length: 51 }, (_, i) => `https://example.com/p${i}`).join('\n');
    expect((await addFindsAction({}, form({ links: many }))).error).toBe('Paste at most 50 links at a time.');
    expect(await state.db.select().from(finds)).toHaveLength(0);
    const fifty = Array.from({ length: 50 }, (_, i) => `https://example.com/p${i}`).join('\n');
    expect((await addFindsAction({}, form({ links: fifty }))).ok).toBe(true);
    expect(await state.db.select().from(finds)).toHaveLength(50);
  });
});

describe('retryFindAction and deleteFindAction', () => {
  async function seed(status: 'failed' | 'done' | 'capturing') {
    const { results } = await addFinds(state.db, [{ url: 'https://example.com/v', source: 'paste' }]);
    const id = results[0]!.id!;
    await state.db.update(finds).set({ status, error: status === 'failed' ? 'could not read it' : null }).where(eq(finds.id, id));
    return id;
  }

  it('retry puts a failed find back in the queue and clears the error', async () => {
    const id = await seed('failed');
    await retryFindAction(form({ id }));
    expect((await state.db.select().from(finds))[0]).toMatchObject({ status: 'queued', error: null });
    expect(request.revalidated).toContain('/library/finds');
  });

  it('retry leaves a find that is not failed alone', async () => {
    const id = await seed('done');
    await retryFindAction(form({ id }));
    expect((await state.db.select().from(finds))[0]!.status).toBe('done');
  });

  it('delete removes a find, but not one being captured', async () => {
    const id = await seed('failed');
    await deleteFindAction(form({ id }));
    expect(await state.db.select().from(finds)).toHaveLength(0);
    const busy = await seed('capturing');
    await deleteFindAction(form({ id: busy }));
    expect(await state.db.select().from(finds)).toHaveLength(1);
  });

  it('rejects a malformed id', async () => {
    await expect(retryFindAction(form({ id: 'nope' }))).rejects.toThrow('Invalid request.');
    await expect(deleteFindAction(form({ id: '' }))).rejects.toThrow('Invalid request.');
  });
});

describe('startRunFromFindsAction', () => {
  it('queues a finds run over the most recent captured finds', async () => {
    const { results } = await addFinds(state.db, [
      { url: 'https://example.com/a', source: 'paste' }, { url: 'https://example.com/b', source: 'paste' }, { url: 'https://example.com/c', source: 'paste' },
    ]);
    for (const r of results.slice(0, 2)) await state.db.update(finds).set({ status: 'done' }).where(eq(finds.id, r.id!));
    const r = await startRunFromFindsAction({}, new FormData());
    expect(r.ok).toBe(true);
    expect(r.notice).toMatch(/Queued a run from 2 finds/);
    const [run] = await state.db.select().from(runs);
    expect(run!.status).toBe('queued');
    expect(run!.config).toMatchObject({ seedType: 'finds', marketId: 'ca-us' });
    expect([...run!.config.findIds!].sort()).toEqual(results.slice(0, 2).map((x) => x.id!).sort());
    expect(request.revalidated).toEqual(expect.arrayContaining(['/runs', '/command', '/library/finds']));
  });

  it('refuses when no find is captured yet, writing nothing', async () => {
    await addFinds(state.db, [{ url: 'https://example.com/a', source: 'paste' }]);
    const before = await snapshotDb(state.db);
    const r = await startRunFromFindsAction({}, new FormData());
    expect(r).toEqual({ error: 'No captured finds yet. Wait for the worker to capture your links.' });
    expect(await snapshotDb(state.db)).toEqual(before);
  });
});
