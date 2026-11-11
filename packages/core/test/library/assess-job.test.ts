import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { testDb, unit } from '../helpers/db';
import { knowledgeItems, llmCalls } from '../../src/db/schema';
import type { KnowledgeDraft } from '../../src/library/kinds';
import { upsertKnowledgeItem } from '../../src/library/store';
import type { CallCtx, ModelRouter } from '../../src/llm/types';
import { runAssessBackfill } from '../../src/library/assess-job';

type Db = Awaited<ReturnType<typeof testDb>>;
let n = 0;
async function add(db: Db, o: { why?: string } = {}) {
  n++;
  const d: KnowledgeDraft = {
    kind: 'problem', title: `Title ${n}`, summary: `Summary ${n}`, quote: `quote ${n}`, audience: 'business', countries: [], industries: [], voice: 'operator', facts: { persona: 'p' },
    source: { url: `https://s${n}.example.com/p`, domain: `s${n}.example.com`, sourceType: 'web', quote: `quote ${n}`, quoteVerified: true },
  };
  const r = await upsertKnowledgeItem(db, d, unit(n), {});
  if (o.why) await db.update(knowledgeItems).set({ assessment: { directness: 'press', bias: null, strength: 3, why: o.why, corroboration: 0 } }).where(eq(knowledgeItems.id, r.itemId));
  return { id: r.itemId, title: d.title };
}

/** Answers every "Entry N:" in the prompt; each call costs `cost`; `directness` is what the model says. */
function router(db: Db, o: { cost?: number; directness?: string; fail?: boolean; why?: string; bias?: string } = {}) {
  const calls: { ctx: CallCtx; prompt: string }[] = [];
  const r: ModelRouter & { calls: typeof calls } = {
    calls,
    modelFor: () => 'm',
    async text() { throw new Error('unused'); },
    async research() { throw new Error('unused'); },
    async embed() { throw new Error('unused'); },
    async structured(stage, req, ctx) {
      calls.push({ ctx, prompt: req.prompt });
      await db.insert(llmCalls).values({ runId: ctx.runId, stage, provider: 'p', model: 'm', inputTokens: 0, outputTokens: 0, searchRequests: 0, costUsd: String(o.cost ?? 0.01), latencyMs: 0, promptVersion: ctx.promptVersion, ok: true });
      if (o.fail) throw new Error('model down');
      expect(stage).toBe('library_extract');
      const ns = [...req.prompt.matchAll(/Entry (\d+):/g)].map((m) => Number(m[1]));
      return req.schema.parse({ entries: ns.map((k) => ({ n: k, directness: o.directness ?? 'first_hand', bias: o.bias ?? (k % 2 ? 'sells a fix' : null), why: o.why ?? `why ${k}` })) }) as never;
    },
  };
  return r;
}

describe('runAssessBackfill', () => {
  it('assesses entries without a why, in batches of 20, and skips the ones already assessed', async () => {
    const db = await testDb();
    const done = await add(db, { why: 'already' });
    for (let i = 0; i < 25; i++) await add(db);
    // upsert leaves the assessment null when the draft carries none
    const rt = router(db);
    const out = await runAssessBackfill({ db, router: rt, log: () => {}, maxUsd: 25 });
    expect(out.assessed).toBe(25);
    expect(rt.calls).toHaveLength(2);
    expect(rt.calls.every((c) => c.ctx.promptVersion === 'library-assess.v1')).toBe(true);
    expect(out.spentUsd).toBeCloseTo(0.02, 5);
    const [kept] = await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, done.id));
    expect(kept!.assessment).toMatchObject({ why: 'already', directness: 'press' });
    const assessed = (await db.select().from(knowledgeItems)).filter((r) => r.id !== done.id);
    for (const r of assessed) expect(r.assessment).toMatchObject({ directness: 'first_hand', strength: 5 }); // operator +1, verified quote +1
    expect(assessed.some((r) => (r.assessment as { bias: string | null }).bias === null)).toBe(true);
    expect((await runAssessBackfill({ db, router: rt, log: () => {}, maxUsd: 25 })).assessed).toBe(0);
    expect(rt.calls).toHaveLength(2);
  });

  it('stops at maxUsd', async () => {
    const db = await testDb();
    for (let i = 0; i < 65; i++) await add(db);
    const rt = router(db, { cost: 0.6 });
    const out = await runAssessBackfill({ db, router: rt, log: () => {}, maxUsd: 1 });
    expect(rt.calls).toHaveLength(2); // 0.6 is under 1, then 1.2 is over: stop
    expect(out.assessed).toBe(40);
    expect(out.spentUsd).toBeCloseTo(1.2, 5);
  });

  it("turns a directness outside the enum into 'unknown'", async () => {
    const db = await testDb();
    const a = await add(db);
    await runAssessBackfill({ db, router: router(db, { directness: 'totally made up' }), log: () => {}, maxUsd: 25 });
    const [row] = await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, a.id));
    expect(row!.assessment).toMatchObject({ directness: 'unknown' });
  });

  it('scrubs emails, handles and profile links from the model why and bias before storing', async () => {
    const db = await testDb();
    const a = await add(db);
    const rt = router(db, { why: 'Written by jane.doe@example.com, see @janedoe and https://www.linkedin.com/in/janedoe for context.', bias: 'u/someuser sells ads, mail bob@corp.example' });
    await runAssessBackfill({ db, router: rt, log: () => {}, maxUsd: 25 });
    const [row] = await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, a.id));
    const stored = row!.assessment as { why: string; bias: string };
    const all = `${stored.why} ${stored.bias}`;
    for (const leak of ['jane.doe@example.com', 'bob@corp.example', '@janedoe', 'linkedin.com/in/janedoe', 'someuser']) expect(all).not.toContain(leak);
    expect(stored.why).toContain('[email removed]');
    expect(stored.why).toContain('[user]');
  });

  it('wraps entry text as untrusted and gives up after repeated model failures', async () => {
    const db = await testDb();
    for (let i = 0; i < 100; i++) await add(db);
    const rt = router(db, { fail: true });
    const out = await runAssessBackfill({ db, router: rt, log: () => {}, maxUsd: 25 });
    expect(out.assessed).toBe(0);
    expect(rt.calls.length).toBeLessThanOrEqual(3);
    expect(rt.calls[0]!.prompt).toContain('<entry>');
  });
});
