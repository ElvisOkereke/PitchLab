import { describe, it, expect } from 'vitest';
import { sql, cosineDistance } from 'drizzle-orm';
import { testDb } from '../helpers/db';
import { seedDefaults } from '../../src/db/seed';
import { cases, claims, lenses, markets, runs, ideas, signals } from '../../src/db/schema';

describe('db', () => {
  it('migrates, seeds idempotently, and supports vector similarity', async () => {
    const db = await testDb();
    await seedDefaults(db);
    expect(await db.select().from(lenses)).toHaveLength(8);
    expect((await db.select().from(markets))[0].currency).toBe('USD');
    const [run] = await db.insert(runs).values({ config: {} as never, status: 'queued' }).returning();
    const v = Array(1536).fill(0);
    v[0] = 1;
    await db.insert(ideas).values({ runId: run.id, origin: 'generated', title: 't', oneLiner: 'o', buyer: 'b', problem: 'p', solution: 's', signalIds: [], embedding: v, status: 'candidate' });
    const rows = await db.select({ sim: sql<number>`1 - (${cosineDistance(ideas.embedding, v)})` }).from(ideas);
    expect(rows[0].sim).toBeCloseTo(1);
  });

  it('stores the needs_review claim status with a review note', async () => {
    const db = await testDb();
    const [run] = await db.insert(runs).values({ config: {} as never, status: 'queued' }).returning();
    const [idea] = await db.insert(ideas).values({ runId: run.id, origin: 'generated', title: 't', oneLiner: 'o', buyer: 'b', problem: 'p', solution: 's', signalIds: [], status: 'candidate' }).returning();
    const [kase] = await db.insert(cases).values({ ideaId: idea.id, slug: 's', title: 'T', sections: {} as never, gateAdvisory: false, model: 'm', promptVersion: 'p' }).returning();
    const [row] = await db.insert(claims).values({
      caseId: kase.id, section: 'competitor', text: 'Acme', sourceUrl: 'https://acme.example', verified: 'needs_review', reviewNote: 'checker unsure (confidence 0.45)',
    }).returning();
    expect(row).toMatchObject({ verified: 'needs_review', reviewNote: 'checker unsure (confidence 0.45)' });
    const [plain] = await db.insert(claims).values({ caseId: kase.id, section: 'evidence', text: 'x', sourceUrl: 'https://x.example' }).returning();
    expect(plain.reviewNote).toBeNull();
  });

  it('stores signal voice and idea functional gap / known incumbents, all nullable (migration 0003)', async () => {
    const db = await testDb();
    const base = { marketId: 'ca-us', source: 'web', title: 't', quote: 'q' };
    const [tagged] = await db.insert(signals).values({ ...base, url: 'https://v.example/1', quoteHash: 'v1', voice: 'vendor' }).returning();
    const [legacy] = await db.insert(signals).values({ ...base, url: 'https://v.example/2', quoteHash: 'v2' }).returning();
    expect(tagged.voice).toBe('vendor');
    expect(legacy.voice).toBeNull();
    const [run] = await db.insert(runs).values({ config: {} as never, status: 'queued' }).returning();
    const idea = { runId: run.id, origin: 'generated' as const, title: 't', oneLiner: 'o', buyer: 'b', problem: 'p', solution: 's', signalIds: [], status: 'candidate' as const };
    const [claimed] = await db.insert(ideas).values({ ...idea, functionalGap: 'no one reconciles X', knownIncumbents: ['Acme', 'Globex'] }).returning();
    const [plain] = await db.insert(ideas).values(idea).returning();
    expect(claimed).toMatchObject({ functionalGap: 'no one reconciles X', knownIncumbents: ['Acme', 'Globex'] });
    expect(plain).toMatchObject({ functionalGap: null, knownIncumbents: null });
  });

  it('rejects duplicate signal url+quote', async () => {
    const db = await testDb();
    const s = { marketId: 'ca-us', source: 'hn', url: 'https://x', title: 't', quote: 'q', quoteHash: 'h' };
    await db.insert(signals).values(s);
    await expect(db.insert(signals).values(s)).rejects.toThrow();
  });
});
