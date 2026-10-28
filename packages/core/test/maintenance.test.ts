import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { Db } from '../src/db/client';
import { claims, knowledgeItems, knowledgeSources, pageFetches, settings, signals } from '../src/db/schema';
import { upsertKnowledgeItem } from '../src/library/store';
import { runMaintenance, runMaintenanceQuietly } from '../src/maintenance';
import { insertCase, insertIdea, insertRun, testDb, unit } from './helpers/db';
import { defaultRunConfig } from '../src/pipeline/types';

const DAY = 86_400_000;
const NOW = new Date('2026-10-28T12:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const PLACEHOLDER = '[expired YouTube data]';

let n = 0;
async function item(db: Db, sourceType: string, url: string, expiresAt: Date | null, extra?: { url: string; sourceType: string }) {
  n++;
  const r = await upsertKnowledgeItem(db, {
    kind: 'problem', title: `T${n}`, summary: `S${n}`, quote: `q${n}`, audience: 'business', countries: ['US'], industries: ['x'],
    voice: 'neutral', facts: { persona: 'p' },
    source: { url, domain: 'a.example', sourceType, quote: `q${n}`, quoteVerified: true },
  }, unit(n), {});
  await db.update(knowledgeSources).set({ expiresAt }).where(eq(knowledgeSources.url, url));
  if (extra) {
    await db.insert(knowledgeSources).values({ itemId: r.itemId, url: extra.url, domain: 'b.example', sourceType: extra.sourceType });
  }
  return r.itemId;
}

const sig = (db: Db, source: string, url: string, createdAt: Date, hash = 'h' + url) =>
  db.insert(signals).values({ marketId: 'ca-us', source, url, title: 'real title', quote: 'real quote text here', quoteHash: hash, embedding: unit(3), createdAt }).returning();

describe('runMaintenance', () => {
  it('prunes page_fetches older than 90 days only', async () => {
    const db = await testDb();
    await db.insert(pageFetches).values([
      { urlDomain: 'a.example', outcome: 'ok', via: 'direct', at: ago(91) },
      { urlDomain: 'b.example', outcome: 'ok', via: 'direct', at: ago(89) },
    ]);
    const r = await runMaintenance(db, NOW);
    expect(r.prunedFetches).toBe(1);
    expect((await db.select().from(pageFetches)).map((x) => x.urlDomain)).toEqual(['b.example']);
  });

  it('prunes youtube.quota settings rows older than 7 days, keeps recent ones and other settings', async () => {
    const db = await testDb();
    await db.execute(sql`insert into settings (key, value) values
      ('youtube.quota.2026-10-10', '{"searchCalls":1,"units":1}'::jsonb),
      ('youtube.quota.2026-10-20', '{"searchCalls":1,"units":1}'::jsonb),
      ('youtube.quota.2026-10-21', '{"searchCalls":1,"units":1}'::jsonb),
      ('youtube.quota.2026-10-28', '{"searchCalls":1,"units":1}'::jsonb),
      ('youtube.quota.garbage', '{}'::jsonb),
      ('youtube.quotax.2026-01-01', '{}'::jsonb),
      ('other.2026-01-01', '{}'::jsonb)`);
    const r = await runMaintenance(db, NOW);
    expect(r.prunedQuotaRows).toBe(2);
    expect(r.errors).toEqual([]);
    const keys = (await db.select().from(settings)).map((x) => x.key).sort();
    expect(keys).toEqual(['other.2026-01-01', 'youtube.quota.2026-10-21', 'youtube.quota.2026-10-28', 'youtube.quota.garbage', 'youtube.quotax.2026-01-01']);
  });

  it('deletes expired sources, then entries left with no sources', async () => {
    const db = await testDb();
    const gone = await item(db, 'youtube', 'https://www.youtube.com/watch?v=aaaaaaaaaaa', ago(1));
    const kept = await item(db, 'hn', 'https://news.example/1', null, { url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', sourceType: 'youtube' });
    await db.update(knowledgeSources).set({ expiresAt: ago(1) }).where(eq(knowledgeSources.url, 'https://www.youtube.com/watch?v=bbbbbbbbbbb'));
    const future = await item(db, 'youtube', 'https://www.youtube.com/watch?v=ccccccccccc', new Date(NOW.getTime() + DAY));
    const r = await runMaintenance(db, NOW);
    expect(r).toMatchObject({ expiredSources: 2, deletedItems: 1 });
    const ids = (await db.select({ id: knowledgeItems.id }).from(knowledgeItems)).map((x) => x.id);
    expect(ids).not.toContain(gone);
    expect(ids).toEqual(expect.arrayContaining([kept, future]));
    expect(await db.select().from(knowledgeSources)).toHaveLength(2);
  });

  it('redacts YouTube signals older than 30 days, keeps (url, quote_hash) unique, leaves others', async () => {
    const db = await testDb();
    const [a] = await sig(db, 'youtube', 'https://www.youtube.com/watch?v=aaaaaaaaaaa', ago(31), 'same');
    const [b] = await sig(db, 'youtube', 'https://www.youtube.com/watch?v=aaaaaaaaaaa', ago(40), 'same2');
    const [fresh] = await sig(db, 'youtube', 'https://www.youtube.com/watch?v=fresh', ago(5));
    const [other] = await sig(db, 'web', 'https://other.example/x', ago(200));
    const r = await runMaintenance(db, NOW);
    expect(r.redactedSignals).toBe(2);
    const get = async (id: string) => (await db.select().from(signals).where(eq(signals.id, id)))[0]!;
    const ra = await get(a!.id);
    expect(ra).toMatchObject({ quote: PLACEHOLDER, title: PLACEHOLDER, embedding: null });
    expect(ra.quoteHash).toBe(createHash('sha256').update(PLACEHOLDER + a!.id).digest('hex'));
    expect((await get(b!.id)).quoteHash).not.toBe(ra.quoteHash);
    expect((await get(fresh!.id)).quote).toBe('real quote text here');
    const o = await get(other!.id);
    expect(o).toMatchObject({ quote: 'real quote text here', title: 'real title' });
    expect(o.embedding).not.toBeNull();
  });

  it('removes YouTube claim quotes for cases older than 30 days only', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', ideaCount: 1, advanceCount: 1 }));
    const oldCase = await insertCase(db, (await insertIdea(db, run.id)).id, { createdAt: ago(31) });
    const newCase = await insertCase(db, (await insertIdea(db, run.id)).id, { createdAt: ago(2), slug: 'new-case' });
    const mk = (caseId: string, sourceUrl: string, quote: string | null) => ({ caseId, section: 's', text: 't', sourceUrl, quote });
    await db.insert(claims).values([
      mk(oldCase.id, 'https://www.youtube.com/watch?v=aaaaaaaaaaa', 'a youtube quote that is long enough'),
      mk(oldCase.id, 'https://youtu.be/aaaaaaaaaaa', 'another youtube quote that is long'),
      mk(oldCase.id, 'https://youtube.com/watch?v=aaaaaaaaaaa', null),
      mk(oldCase.id, 'https://news.example/a', 'a news quote that is long enough'),
      mk(oldCase.id, 'https://m.youtube.com/watch?v=aaaaaaaaaaa', 'mobile youtube quote long enough here'),
      mk(oldCase.id, 'https://notyoutube.com/a', 'lookalike host quote long enough'),
      mk(newCase.id, 'https://www.youtube.com/watch?v=bbbbbbbbbbb', 'fresh case youtube quote long enough'),
    ]);
    const r = await runMaintenance(db, NOW);
    expect(r.redactedClaims).toBe(3);
    const all = await db.select().from(claims);
    const byUrl = (u: string, c: string) => all.find((x) => x.sourceUrl === u && x.caseId === c)!;
    expect(byUrl('https://www.youtube.com/watch?v=aaaaaaaaaaa', oldCase.id)).toMatchObject({ quote: null, reviewNote: 'YouTube quote removed after 30 days' });
    expect(byUrl('https://youtu.be/aaaaaaaaaaa', oldCase.id).quote).toBeNull();
    expect(byUrl('https://news.example/a', oldCase.id)).toMatchObject({ quote: 'a news quote that is long enough', reviewNote: null });
    expect(byUrl('https://notyoutube.com/a', oldCase.id).quote).not.toBeNull();
    expect(byUrl('https://www.youtube.com/watch?v=bbbbbbbbbbb', newCase.id).quote).not.toBeNull();
  });

  it('deletes a YouTube-only entry that a signal was promoted from, redacting the signal, without throwing', async () => {
    const db = await testDb();
    const id = await item(db, 'youtube', 'https://www.youtube.com/watch?v=aaaaaaaaaaa', ago(1));
    const [s] = await db.insert(signals).values({
      marketId: 'ca-us', source: 'youtube', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', title: 't', quote: 'quote text', quoteHash: 'p1',
      knowledgeItemId: id, createdAt: ago(31),
    }).returning();
    const r = await runMaintenance(db, NOW);
    expect(r).toMatchObject({ deletedItems: 1, redactedSignals: 1, errors: [] });
    const row = (await db.select().from(signals).where(eq(signals.id, s!.id)))[0]!;
    expect(row).toMatchObject({ knowledgeItemId: null, quote: PLACEHOLDER });
    expect(await db.select().from(knowledgeItems)).toHaveLength(0);
  });

  it('a failing step does not block the others', async () => {
    const db = await testDb();
    await sig(db, 'youtube', 'https://www.youtube.com/watch?v=aaaaaaaaaaa', ago(31));
    const real = db.transaction.bind(db);
    let calls = 0;
    (db as unknown as { transaction: unknown }).transaction = (fn: never) => (++calls === 2 ? Promise.reject(new Error('step 2 down')) : real(fn));
    const r = await runMaintenance(db, NOW);
    expect(r.errors).toEqual(['expire sources: step 2 down']);
    expect(r.redactedSignals).toBe(1);
  });

  it('is idempotent', async () => {
    const db = await testDb();
    await db.insert(pageFetches).values({ urlDomain: 'a.example', outcome: 'ok', via: 'direct', at: ago(100) });
    await item(db, 'youtube', 'https://www.youtube.com/watch?v=aaaaaaaaaaa', ago(1));
    await sig(db, 'youtube', 'https://www.youtube.com/watch?v=aaaaaaaaaaa', ago(31));
    expect(await runMaintenance(db, NOW)).toEqual({ prunedFetches: 1, prunedQuotaRows: 0, expiredSources: 1, deletedItems: 1, redactedSignals: 1, redactedClaims: 0, errors: [] });
    expect(await runMaintenance(db, NOW)).toEqual({ prunedFetches: 0, prunedQuotaRows: 0, expiredSources: 0, deletedItems: 0, redactedSignals: 0, redactedClaims: 0, errors: [] });
  });
});

describe('runMaintenanceQuietly (used by openDb)', () => {
  it('logs one count line, nothing when idle, and never throws', async () => {
    const db = await testDb();
    const lines: string[] = [];
    await runMaintenanceQuietly(db, (l) => lines.push(l));
    expect(lines).toEqual([]);
    await db.insert(pageFetches).values({ urlDomain: 'a.example', outcome: 'ok', via: 'direct', at: new Date(Date.now() - 100 * DAY) });
    await runMaintenanceQuietly(db, (l) => lines.push(l));
    expect(lines).toEqual(['Maintenance: 1 old records cleaned up.']);
    await expect(runMaintenanceQuietly({ transaction: () => { throw new Error('boom'); } } as never, (l) => lines.push(l))).resolves.toBeUndefined();
    expect(lines[1]).toMatch(/step failed: .*boom/);
  });
});
