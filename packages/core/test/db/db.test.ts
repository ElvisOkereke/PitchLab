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

  it('rejects duplicate signal url+quote', async () => {
    const db = await testDb();
    const s = { marketId: 'ca-us', source: 'hn', url: 'https://x', title: 't', quote: 'q', quoteHash: 'h' };
    await db.insert(signals).values(s);
    await expect(db.insert(signals).values(s)).rejects.toThrow();
  });
});
