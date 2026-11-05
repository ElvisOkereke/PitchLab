import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { benchmarkPasses } from '../../src/db/schema';
import {
  HOLDOUT_KEY, HOLDOUT_MAX_CHARS, HOLDOUT_MAX_ITEMS, holdoutAdd, holdoutClear, holdoutCompare, holdoutList, holdoutSet, holdoutStoreResult,
  holdoutStoredResult, normaliseHoldout,
} from '../../src/audit/holdout';
import { defaultRunConfig } from '../../src/pipeline/types';
import { getSetting, setSetting } from '../../src/validation/settings';
import { insertIdea, insertRun, testDb, unit } from '../helpers/db';
import { fakeRouter } from '../helpers/fake-router';

describe('holdout list', () => {
  it('adds, trims, lists and clears', async () => {
    const db = await testDb();
    expect(await holdoutList(db)).toEqual([]);
    expect(await holdoutAdd(db, '  an AI bookkeeper  ')).toEqual({ ok: true, items: ['an AI bookkeeper'], added: true });
    expect(await holdoutList(db)).toEqual(['an AI bookkeeper']);
    expect(await getSetting(db, HOLDOUT_KEY)).toEqual(['an AI bookkeeper']);
    await holdoutClear(db);
    expect(await holdoutList(db)).toEqual([]);
  });

  it('keeps a repeat once (ignoring case) and says it was not added', async () => {
    const db = await testDb();
    await holdoutAdd(db, 'Idea A');
    expect(await holdoutAdd(db, ' idea a ')).toEqual({ ok: true, items: ['Idea A'], added: false });
  });

  it('refuses blank, over-long and an eleventh item', async () => {
    const db = await testDb();
    expect(await holdoutAdd(db, '   ')).toEqual({ ok: false, reason: 'empty' });
    expect(await holdoutAdd(db, 'x'.repeat(HOLDOUT_MAX_CHARS + 1))).toEqual({ ok: false, reason: 'too_long' });
    expect((await holdoutAdd(db, 'x'.repeat(HOLDOUT_MAX_CHARS))).ok).toBe(true);
    for (let i = 1; i < HOLDOUT_MAX_ITEMS; i++) expect((await holdoutAdd(db, `item ${i}`)).ok).toBe(true);
    expect(await holdoutAdd(db, 'one too many')).toEqual({ ok: false, reason: 'full' });
    expect(await holdoutList(db)).toHaveLength(HOLDOUT_MAX_ITEMS);
  });

  it('holdoutSet replaces the list, dedupes and refuses oversize input without saving', async () => {
    const db = await testDb();
    expect(await holdoutSet(db, [' a ', 'A', '', 'b'])).toEqual({ ok: true, items: ['a', 'b'] });
    expect(await holdoutSet(db, Array.from({ length: 11 }, (_, i) => `i${i}`))).toEqual({ ok: false, reason: 'full' });
    expect(await holdoutList(db)).toEqual(['a', 'b']);
    expect(normaliseHoldout(['x'.repeat(1001)])).toEqual({ ok: false, reason: 'too_long' });
  });

  it('reads a malformed stored value as safe, capped items', async () => {
    const db = await testDb();
    await setSetting(db, HOLDOUT_KEY, 'nope');
    expect(await holdoutList(db)).toEqual([]);
    await setSetting(db, HOLDOUT_KEY, [1, null, ' ok ', 'x'.repeat(2000), ...Array.from({ length: 20 }, (_, i) => `i${i}`)]);
    const list = await holdoutList(db);
    expect(list).toHaveLength(HOLDOUT_MAX_ITEMS);
    expect(list[0]).toBe('ok');
    expect(list[1]).toHaveLength(HOLDOUT_MAX_CHARS);
  });
});

const near = (i: number, j: number, w = 0.2) => {
  const v = unit(i);
  v[j] = w;
  return v;
};

async function passWithIdeas(db: Awaited<ReturnType<typeof testDb>>, specs: { title: string; embedding: number[] | null }[]) {
  const r = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
  for (const s of specs) await insertIdea(db, r.id, { title: s.title, embedding: s.embedding });
  const [p] = await db.insert(benchmarkPasses).values({ version: 'bench-v2', label: 'bench-v2 #1', kind: 'pass', status: 'complete', runIds: [r.id] }).returning();
  return p!.id;
}

describe('holdoutCompare', () => {
  it('reports the best idea and cosine similarity per item, and the median, with one embed call', async () => {
    const db = await testDb();
    const passId = await passWithIdeas(db, [{ title: 'Alpha', embedding: unit(0) }, { title: 'Beta', embedding: unit(1) }]);
    await holdoutSet(db, ['first', 'second', 'third']);
    const vecs = [unit(0), near(1, 0, 1), unit(5)];
    const router = fakeRouter({ embed: () => vecs });
    const res = await holdoutCompare({ db, router }, passId);
    expect(router.calls.filter((c) => c.kind === 'embed')).toHaveLength(1);
    expect(res.items[0]).toEqual({ text: 'first', bestIdeaTitle: 'Alpha', similarity: 1 });
    expect(res.items[1]!.bestIdeaTitle).toBe('Beta');
    expect(res.items[1]!.similarity).toBeCloseTo(1 / Math.SQRT2, 6);
    expect(res.items[2]).toMatchObject({ text: 'third', similarity: 0 });
    expect(['Alpha', 'Beta']).toContain(res.items[2]!.bestIdeaTitle);
    expect(res.median).toBeCloseTo(1 / Math.SQRT2, 6);
  });

  it('the median of an even count is the mean of the middle two', async () => {
    const db = await testDb();
    const passId = await passWithIdeas(db, [{ title: 'Alpha', embedding: unit(0) }]);
    await holdoutSet(db, ['a', 'b']);
    const res = await holdoutCompare({ db, router: fakeRouter({ embed: () => [unit(0), unit(3)] }) }, passId);
    expect(res.median).toBe(0.5);
  });

  it('embeds ideas that have no stored embedding in the same single call', async () => {
    const db = await testDb();
    const passId = await passWithIdeas(db, [{ title: 'Stored', embedding: unit(0) }, { title: 'Bare', embedding: null }]);
    await holdoutSet(db, ['x']);
    const router = fakeRouter({ embed: (t) => (t.length === 2 ? [unit(7), unit(7)] : []) });
    const res = await holdoutCompare({ db, router }, passId);
    expect(router.calls).toHaveLength(1);
    expect(res.items[0]).toMatchObject({ bestIdeaTitle: 'Bare', similarity: 1 });
  });

  it('makes no call and returns nothing with no examples, no ideas or an unknown pass', async () => {
    const db = await testDb();
    const router = fakeRouter({ embed: () => [] });
    const passId = await passWithIdeas(db, [{ title: 'A', embedding: unit(0) }]);
    expect(await holdoutCompare({ db, router }, passId)).toEqual({ items: [], median: null });
    await holdoutSet(db, ['x']);
    const empty = await passWithIdeas(db, []);
    expect(await holdoutCompare({ db, router }, empty)).toEqual({ items: [], median: null });
    expect(await holdoutCompare({ db, router }, '00000000-0000-4000-8000-000000000000')).toEqual({ items: [], median: null });
    expect(router.calls).toHaveLength(0);
  });

  it('stores and reads back the last comparison per pass', async () => {
    const db = await testDb();
    const passId = '00000000-0000-4000-8000-000000000009';
    expect(await holdoutStoredResult(db, passId)).toBeNull();
    await holdoutStoreResult(db, passId, { items: [{ text: 't', bestIdeaTitle: 'B', similarity: 0.5 }], median: 0.5 });
    const got = await holdoutStoredResult(db, passId);
    expect(got).toMatchObject({ items: [{ text: 't', bestIdeaTitle: 'B', similarity: 0.5 }], median: 0.5 });
    expect(typeof got!.computedAt).toBe('string');
    await setSetting(db, `audit.holdoutResults.${passId}`, { bad: true });
    expect(await holdoutStoredResult(db, passId)).toBeNull();
  });
});

describe('holdout isolation guard', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : [p];
    });

  it('no pipeline, prompt or reviewer file mentions the holdout setting or module', () => {
    const broad = [...files(join(root, 'src/pipeline')), ...files(join(root, 'prompts'))];
    expect(broad.length).toBeGreaterThan(10);
    for (const f of broad) expect(readFileSync(f, 'utf8'), f).not.toMatch(/holdout/i);
    // The reviewer may mention in a comment that it never sees them, but must not use the setting or the module.
    const review = readFileSync(join(root, 'src/audit/review.ts'), 'utf8');
    expect(review).not.toMatch(/audit\.holdout|from '[^']*holdout'|holdout(List|Compare|Set|Add)/i);
  });
});
