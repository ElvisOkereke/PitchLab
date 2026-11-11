import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { knowledgeItems, llmCalls } from '../../src/db/schema';
import { DOSSIERS_DAILY_USD_KEY, dossierQueue, runDossierJob } from '../../src/library/dossier-job';
import { upsertKnowledgeItem } from '../../src/library/store';
import type { CallCtx, ModelRouter } from '../../src/llm/types';
import { getSetting, setSetting } from '../../src/validation/settings';
import { insertCase, insertIdea, insertRun, testDb, unit } from '../helpers/db';

type Db = Awaited<ReturnType<typeof testDb>>;
const NOW = new Date('2026-11-10T15:00:00Z');
const LINE = 'Plans start at 49 dollars per seat per month for small teams.';
let n = 0;
async function startup(db: Db, o: { name?: string; businessModel?: string; dossierAt?: string; kind?: 'startup' | 'problem' } = {}) {
  n++;
  const name = o.name ?? `Company${n}`;
  const facts = o.kind === 'problem'
    ? { persona: 'p' }
    : { name, whatItDoes: 'does things', businessModel: o.businessModel ?? 'subscription', outcome: 'active', ...(o.dossierAt ? { dossierAt: o.dossierAt, dossierStatus: 'done' } : {}) };
  const r = await upsertKnowledgeItem(db, {
    kind: o.kind ?? 'startup', title: name, summary: `${name} summary`, audience: 'business', countries: [], industries: [], facts,
    source: { url: `https://src${n}.example.com/post`, domain: `src${n}.example.com`, sourceType: 'web', quoteVerified: false },
  }, unit(n), {});
  return r.itemId;
}

describe('dossierQueue', () => {
  it('orders cited, then priority, then unknown business model, then the rest; skips fresh dossiers and non-startups', async () => {
    const db = await testDb();
    const rest = await startup(db);
    const unknown = await startup(db, { businessModel: 'unknown' });
    const priority = await startup(db);
    const cited = await startup(db);
    const fresh = await startup(db, { dossierAt: '2026-10-01T00:00:00Z' });
    const stale = await startup(db, { dossierAt: '2026-01-01T00:00:00Z' });
    await startup(db, { kind: 'problem' });
    const run = await insertRun(db, {} as never);
    const idea = await insertIdea(db, run.id, { libraryItemIds: [cited] });
    await insertCase(db, idea.id);
    await setSetting(db, 'dossiers.priority', [priority]);
    const q = await dossierQueue(db, 10, NOW);
    expect(q.slice(0, 3)).toEqual([cited, priority, unknown]);
    expect(q).toContain(rest);
    expect(q).toContain(stale);
    expect(q).not.toContain(fresh);
    expect(q).toHaveLength(5);
    expect(await dossierQueue(db, 2, NOW)).toEqual([cited, priority]);
  });

  it('counts a kept (owner-rated up) idea as citing', async () => {
    const db = await testDb();
    await startup(db);
    const kept = await startup(db);
    const run = await insertRun(db, {} as never);
    await insertIdea(db, run.id, { libraryItemIds: [kept], ownerRating: 1 });
    expect((await dossierQueue(db, 5, NOW))[0]).toBe(kept);
  });
});

function setup(db: Db, o: { cost?: number; text?: string; fail?: (url: string) => boolean } = {}) {
  const requested: string[] = [];
  const calls: CallCtx[] = [];
  const router = {
    modelFor: () => 'm',
    async text() { throw new Error('unused'); },
    async embed() { throw new Error('unused'); },
    async research(_s: unknown, _r: unknown, ctx: CallCtx) { calls.push(ctx); return { text: '', sources: [] }; },
    async structured(_s: unknown, req: { schema: { parse(v: unknown): unknown } }, ctx: CallCtx) {
      calls.push(ctx);
      await db.insert(llmCalls).values({ runId: null, stage: 'library_extract', provider: 'p', model: 'm', inputTokens: 0, outputTokens: 0, searchRequests: 0, costUsd: String(o.cost ?? 0.5), latencyMs: 0, promptVersion: ctx.promptVersion, ok: true, createdAt: NOW });
      return req.schema.parse({ pricingUnit: { value: 'per seat', quote: LINE }, people: [] });
    },
  } as unknown as ModelRouter;
  const collectPage = async (url: string) => {
    requested.push(url);
    if (o.fail?.(url)) return { failed: 'http_404' as const };
    return { text: o.text ?? `Company page. ${LINE} Company is great.`, title: 't', finalUrl: url, via: 'direct' as const };
  };
  return { router, collectPage, requested, calls };
}

const run = (db: Db, s: ReturnType<typeof setup>, extra: object = {}) =>
  runDossierJob({ db, router: s.router, collectPage: s.collectPage, log: () => {}, now: () => NOW, limit: 10, ...extra });

describe('runDossierJob', () => {
  it('stores done facts and keeps the old ones; unmatched stores only the status', async () => {
    const db = await testDb();
    const a = await startup(db, { name: 'Alpha' });
    const b = await startup(db, { name: 'Beta' });
    const r = await run(db, setup(db, { text: `Alpha is here. ${LINE}` }));
    expect(r).toMatchObject({ done: 1, unmatched: 1, failed: 0 });
    const [ia] = await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, a));
    const [ib] = await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, b));
    expect(ia!.facts).toMatchObject({ name: 'Alpha', whatItDoes: 'does things', pricingUnit: 'per seat', dossierStatus: 'done', dossierAt: NOW.toISOString() });
    expect(ib!.facts).toEqual({ name: 'Beta', whatItDoes: 'does things', businessModel: 'subscription', outcome: 'active', dossierStatus: 'unmatched', dossierAt: NOW.toISOString() });
  });

  it('tags every model call with the dossier prompt version', async () => {
    const db = await testDb();
    await startup(db, { name: 'Zeta' });
    const s = setup(db, { text: `Zeta is here. ${LINE}` });
    await run(db, s);
    expect(s.calls.length).toBeGreaterThan(0);
    expect(s.calls.every((c) => c.promptVersion === 'dossier.v1')).toBe(true);
  });

  it('stops at the daily cap', async () => {
    const db = await testDb();
    for (let i = 0; i < 5; i++) await startup(db, { name: `Gamma${i}` });
    await setSetting(db, DOSSIERS_DAILY_USD_KEY, 1);
    const s = setup(db, { cost: 0.6, text: `Gamma0 Gamma1 Gamma2 Gamma3 Gamma4 here. ${LINE}` });
    const r = await run(db, s);
    expect(r.done).toBe(2);
    expect(r.spentUsd).toBeCloseTo(1.2);
    const again = await run(db, s);
    expect(again.done + again.unmatched + again.failed).toBe(0);
  });

  it('stops at --max-usd and records the last run', async () => {
    const db = await testDb();
    for (let i = 0; i < 4; i++) await startup(db, { name: `Delta${i}` });
    const s = setup(db, { cost: 0.5, text: `Delta0 Delta1 Delta2 Delta3. ${LINE}` });
    const r = await run(db, s, { maxUsd: 0.5 });
    expect(r.done).toBe(1);
    expect(await getSetting(db, 'dossiers.lastStats')).toMatchObject({ done: 1 });
  });

  it('yields when the worker has queued work', async () => {
    const db = await testDb();
    await startup(db, { name: 'Eps' });
    const r = await run(db, setup(db), { shouldYield: () => true });
    expect(r.done + r.unmatched + r.failed).toBe(0);
  });
});

describe('failure back-off', () => {
  it('30 permanently failing items do not block a healthy one across two runs; the back-off window is respected', async () => {
    const db = await testDb();
    const hosts = new Set<string>();
    const bad: string[] = [];
    for (let i = 0; i < 30; i++) {
      bad.push(await startup(db, { name: `Broken${i}` }));
      hosts.add(`src${n}.example.com`);
    }
    const good = await startup(db, { name: 'Healthy' });
    const s = setup(db, { text: `Healthy is here. ${LINE}`, fail: (u) => hosts.has(new URL(u).host) });
    const at = (days: number) => () => new Date(NOW.getTime() + days * 86_400_000);
    const go = (days: number, limit = 25) => runDossierJob({ db, router: s.router, collectPage: s.collectPage, log: () => {}, now: at(days), limit });
    const r1 = await go(0);
    expect(r1.failed).toBe(25);
    const r2 = await go(0.1);
    expect(r2.done).toBe(1);
    expect(r2.failed).toBe(5);
    const [g] = await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, good));
    expect(g!.facts).toMatchObject({ dossierStatus: 'done' });
    // inside the 7-day window nothing failing is queued again; after it, one failure makes the wait 14 days
    expect(await dossierQueue(db, 50, at(6)())).toEqual([]);
    expect((await dossierQueue(db, 50, at(8)())).length).toBe(30);
    await go(8, 50);
    expect((await dossierQueue(db, 50, at(8 + 13)())).length).toBe(0);
    expect((await dossierQueue(db, 50, at(8 + 15)())).length).toBe(30);
    // the third failure sets dossierAt (normal 180-day refresh from then on)
    await go(24, 50);
    const [b] = await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, bad[0]!));
    expect(b!.facts).toMatchObject({ dossierStatus: 'failed', dossierFailures: 3 });
    expect((b!.facts as { dossierAt?: string }).dossierAt).toBeTruthy();
    expect(await dossierQueue(db, 50, at(24 + 100)())).toEqual([]);
    expect((await dossierQueue(db, 50, at(24 + 200)())).length).toBe(31);
  });
});
