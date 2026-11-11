import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { fewShotPairs, syncJudgePairs } from '../../src/audit/judge-pairs';
import type { Db } from '../../src/db/client';
import { ideas, judgePairs } from '../../src/db/schema';
import { TRAIN_SHARE } from '../../src/pipeline/engine/kinds';
import { defaultRunConfig } from '../../src/pipeline/types';
import { fakeRouter } from '../helpers/fake-router';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';

type Stage = 'new' | 'validating' | 'pilot' | 'live' | 'killed';
const hash = (a: string, b: string) => createHash('sha256').update([a, b].sort().join(':')).digest('hex');
const splitOf = (h: string) => (parseInt(h.slice(0, 2), 16) / 255 < TRAIN_SHARE ? 'train' : 'test');

async function decided(db: Db, runId: string, title: string, stage: Stage, o: Partial<typeof ideas.$inferInsert> = {}) {
  const i = await insertIdea(db, runId, { title, ...o });
  await insertCase(db, i.id, { stage, slug: `c-${title}` });
  return i;
}

async function fixture() {
  const db = await testDb();
  const r = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
  const kept = [await decided(db, r.id, 'k1', 'validating'), await decided(db, r.id, 'k2', 'pilot'), await decided(db, r.id, 'k3', 'live')];
  const killed = [await decided(db, r.id, 'x1', 'killed'), await decided(db, r.id, 'x2', 'killed'), await decided(db, r.id, 'x3', 'killed'), await decided(db, r.id, 'x4', 'killed')];
  await decided(db, r.id, 'fresh', 'new');
  return { db, r, kept, killed };
}

describe('syncJudgePairs', () => {
  it('adds every kept versus killed pair with a hash-based split', async () => {
    const { db, kept, killed } = await fixture();
    expect(await syncJudgePairs(db)).toEqual({ added: 12 });
    const rows = await db.select().from(judgePairs);
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      expect(row.pairHash).toBe(hash(row.keptIdeaId, row.killedIdeaId));
      expect(row.split).toBe(splitOf(row.pairHash));
      expect(kept.map((k) => k.id)).toContain(row.keptIdeaId);
      expect(killed.map((k) => k.id)).toContain(row.killedIdeaId);
    }
  });

  it('is stable: a rerun changes nothing, new pairs add only themselves, old splits stay', async () => {
    const { db, r } = await fixture();
    await syncJudgePairs(db);
    const before = await db.select().from(judgePairs);
    expect(await syncJudgePairs(db)).toEqual({ added: 0 });
    await decided(db, r.id, 'k4', 'live');
    expect(await syncJudgePairs(db)).toEqual({ added: 4 });
    const after = await db.select().from(judgePairs);
    expect(after).toHaveLength(16);
    for (const b of before) expect(after.find((a) => a.id === b.id)).toMatchObject({ pairHash: b.pairHash, split: b.split });
    for (const a of after) expect(a.split).toBe(splitOf(a.pairHash));
  });

  it('adds owner-rated pairs (liked against disliked) and skips ideas on both sides', async () => {
    const db = await testDb();
    const r = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const liked = await insertIdea(db, r.id, { title: 'liked', ownerRating: 1 });
    const disliked = await insertIdea(db, r.id, { title: 'disliked', ownerRating: -1 });
    await insertIdea(db, r.id, { title: 'neutral', ownerRating: 0 });
    await insertIdea(db, r.id, { title: 'unrated' });
    const both = await decided(db, r.id, 'both', 'live', { ownerRating: -1 });
    await syncJudgePairs(db);
    const rows = await db.select().from(judgePairs);
    expect(rows.map((x) => `${x.keptIdeaId}|${x.killedIdeaId}`)).toEqual([`${liked.id}|${disliked.id}`]);
    expect(both.id).toBeDefined();
  });
});

describe('fewShotPairs', () => {
  const reasonScript = (n: number) => Array.from({ length: n }, (_, i) => `reason ${i}`);

  it('never returns a test pair', async () => {
    const { db } = await fixture();
    await syncJudgePairs(db);
    const rows = await db.select().from(judgePairs);
    expect(new Set(rows.map((x) => x.split))).toEqual(new Set(['train', 'test']));
    const trainIds = new Set(rows.filter((x) => x.split === 'train').flatMap((x) => [x.keptIdeaId, x.killedIdeaId]));
    const testPairs = rows.filter((x) => x.split === 'test');
    const router = fakeRouter({ text: { review: reasonScript(20) } });
    const got = await fewShotPairs(db, 20, router);
    expect(got.length).toBe(rows.filter((x) => x.split === 'train').length);
    expect(got.length).toBeGreaterThan(0);
    const titles = new Set(got.flatMap((g) => [g.kept.title, g.killed.title]));
    const titlesOf = async (id: string) => (await db.select({ t: ideas.title }).from(ideas).where(eq(ideas.id, id)))[0]!.t;
    // A test-only pair (both ideas absent from every train pair) must not leak; and no returned pair is a test pair.
    for (const p of testPairs) {
      const k = await titlesOf(p.keptIdeaId);
      const x = await titlesOf(p.killedIdeaId);
      expect(got.some((g) => g.kept.title === k && g.killed.title === x)).toBe(false);
    }
    expect(titles.size).toBeGreaterThan(0);
    expect(trainIds.size).toBeGreaterThan(0);
  });

  it('caps at n and defaults to FEWSHOT_PAIRS_MAX', async () => {
    const { db } = await fixture();
    await syncJudgePairs(db);
    const router = fakeRouter({ text: { review: reasonScript(20) } });
    expect((await fewShotPairs(db, 2, router)).length).toBeLessThanOrEqual(2);
    expect((await fewShotPairs(db, undefined, router)).length).toBeLessThanOrEqual(6);
  });

  it('fills a missing reason once through judge-reason and stores it', async () => {
    const { db } = await fixture();
    await syncJudgePairs(db);
    const router = fakeRouter({ text: { review: reasonScript(30) } });
    const first = await fewShotPairs(db, 6, router);
    const calls = router.calls.length;
    expect(calls).toBe(first.length);
    expect(router.calls[0]!.stage).toBe('review');
    expect(first.every((p) => p.reason.startsWith('reason '))).toBe(true);
    const stored = (await db.select().from(judgePairs)).filter((x) => x.reason);
    expect(stored.length).toBe(first.length);
    const second = await fewShotPairs(db, 6, router);
    expect(router.calls.length).toBe(calls);
    expect(second.map((p) => p.reason).sort()).toEqual(first.map((p) => p.reason).sort());
  });

  it('works without a router: stored reasons or a plain fallback, no model call', async () => {
    const { db } = await fixture();
    await syncJudgePairs(db);
    const got = await fewShotPairs(db, 6);
    expect(got.length).toBeGreaterThan(0);
    expect(got.every((p) => p.reason.length > 0)).toBe(true);
    expect(got[0]!.kept).toMatchObject({ title: expect.any(String), buyer: 'b', problem: 'p' });
  });
});
