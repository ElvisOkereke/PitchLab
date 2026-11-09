import { describe, expect, it, vi } from 'vitest';
import { finds } from '../../src/db/schema';
import type { OpenedCapture } from '../../src/finds/capture';
import { createFindsExecutor, runQueuedFinds } from '../../src/finds/run';
import { addFinds } from '../../src/finds/store';
import type { ModelRouter } from '../../src/llm/types';
import { testDb, unit } from '../helpers/db';

const router: ModelRouter = {
  modelFor: () => 'm',
  async text() { throw new Error('unused'); },
  async research() { throw new Error('unused'); },
  async structured(_s, req) {
    return req.schema.parse({ title: 'T', summary: 'S.', quote: null, audience: 'business', countries: [], industries: [], facts: { what: 'w', whoPays: 'p', howItEarns: 'h', whyItWorks: 'y', claims: [] } });
  },
  async embed(texts) { return texts.map((_, i) => unit(i)); },
};

function opened(o: { toolsPresent?: boolean; capture?: OpenedCapture['capture'] } = {}) {
  const close = vi.fn(async () => {});
  const capture = vi.fn(o.capture ?? (async () => ({ ok: true as const, platform: 'other', title: 't', caption: 'c', transcript: '', screenText: '', stats: {}, warnings: [] })));
  const c: OpenedCapture = { capture, scrubHandles: (t) => t, toolsPresent: o.toolsPresent ?? true, close };
  return { c, close, capture };
}

describe('runQueuedFinds', () => {
  it('leaves finds queued and closes the proxy when the capture tools are not installed', async () => {
    const db = await testDb();
    await addFinds(db, [{ url: 'https://example.com/a', source: 'paste' }]);
    const o = opened({ toolsPresent: false });
    const r = await runQueuedFinds({ db, router, log: () => {}, open: async () => o.c, limit: 5 });
    expect(r).toBe('no_tools');
    expect(o.close).toHaveBeenCalledTimes(1);
    expect(o.capture).not.toHaveBeenCalled();
    expect((await db.select().from(finds))[0]!.status).toBe('queued');
  });

  it('reports unavailable when capture cannot open', async () => {
    const db = await testDb();
    expect(await runQueuedFinds({ db, router, log: () => {}, open: async () => null, limit: 1 })).toBe('unavailable');
  });

  it('captures and closes the proxy; closes it on a throw too', async () => {
    const db = await testDb();
    await addFinds(db, [{ url: 'https://example.com/b', source: 'paste' }]);
    const ok = opened();
    expect(await runQueuedFinds({ db, router, log: () => {}, open: async () => ok.c, limit: 1 })).toEqual({ captured: 1, failed: 0 });
    expect(ok.close).toHaveBeenCalledTimes(1);
    await addFinds(db, [{ url: 'https://example.com/c', source: 'paste' }]);
    const boom = opened();
    const brokenDb = new Proxy(db, { get: (t, k) => (k === 'update' ? () => { throw new Error('db gone'); } : Reflect.get(t, k)) });
    await expect(runQueuedFinds({ db: brokenDb, router, log: () => {}, open: async () => boom.c, limit: 1 })).rejects.toThrow('db gone');
    expect(boom.close).toHaveBeenCalledTimes(1);
  });
});

describe('createFindsExecutor', () => {
  it('does nothing (and opens nothing) with an empty queue', async () => {
    const db = await testDb();
    const open = vi.fn(async () => opened().c);
    const exec = createFindsExecutor({ db, router, log: () => {}, open });
    expect(await exec()).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('warns once per executor when tools are missing or capture is unavailable, and keeps finds queued', async () => {
    const db = await testDb();
    await addFinds(db, [{ url: 'https://example.com/d', source: 'paste' }]);
    const logs: string[] = [];
    const exec = createFindsExecutor({ db, router, log: (m) => logs.push(m), open: async () => opened({ toolsPresent: false }).c });
    expect(await exec()).toBe(false);
    expect(await exec()).toBe(false);
    expect(logs.filter((l) => l.includes('Finds are waiting: run npm run capture:setup'))).toHaveLength(1);
    const logs2: string[] = [];
    const exec2 = createFindsExecutor({ db, router, log: (m) => logs2.push(m), open: async () => null });
    await exec2();
    await exec2();
    expect(logs2.filter((l) => l.includes('could not start'))).toHaveLength(1);
    expect((await db.select().from(finds))[0]!.status).toBe('queued');
  });

  it('returns true when it processed a find', async () => {
    const db = await testDb();
    await addFinds(db, [{ url: 'https://example.com/e', source: 'paste' }]);
    const exec = createFindsExecutor({ db, router, log: () => {}, open: async () => opened().c });
    expect(await exec()).toBe(true);
    expect(await exec()).toBe(false);
  });
});
