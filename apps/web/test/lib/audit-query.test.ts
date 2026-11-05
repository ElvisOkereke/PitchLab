import { holdoutSet, holdoutStoreResult } from '@bcg/core/audit/holdout';
import type { PassRow } from '@bcg/core/bench/passes';
import { benchmarkPasses } from '@bcg/core/db/schema';
import { describe, expect, it } from 'vitest';
import { loadAuditViews } from '@/lib/audit-query';
import { progressColumns } from '@/lib/progress-columns';
import { createTestDb } from '../helpers/db';

async function emptyPass(db: Awaited<ReturnType<typeof createTestDb>>, status: 'complete' | 'running' = 'complete') {
  const [p] = await db.insert(benchmarkPasses).values({ version: 'bench-v2', label: 'bench-v2 #1', kind: 'pass', status, runIds: [] }).returning();
  return p as unknown as PassRow;
}

describe('loadAuditViews', () => {
  it('gives an old pass with no runs an empty audit (no division by zero, no flags) and no holdout', async () => {
    const db = await createTestDb();
    const p = await emptyPass(db);
    const v = (await loadAuditViews(db, [p]))[p.id]!;
    expect(v.audit).toMatchObject({ signals: { total: 0 }, lenses: [], demandShare: null, nicheShare: null, flags: [] });
    expect(v.holdoutItems).toBe(0);
    expect(v.holdout).toBeNull();
  });

  it('skips passes that are still running', async () => {
    const db = await createTestDb();
    const p = await emptyPass(db, 'running');
    expect(await loadAuditViews(db, [p])).toEqual({});
  });

  it('shows the stored holdout comparison without any model call, and counts the examples', async () => {
    const db = await createTestDb();
    const p = await emptyPass(db);
    await holdoutSet(db, ['a', 'b']);
    expect((await loadAuditViews(db, [p]))[p.id]!.holdout).toBeNull();
    await holdoutStoreResult(db, p.id, { items: [{ text: 'a', bestIdeaTitle: 'T', similarity: 0.4 }], median: 0.4 });
    const v = (await loadAuditViews(db, [p]))[p.id]!;
    expect(v.holdoutItems).toBe(2);
    expect(v.holdout).toMatchObject({ median: 0.4 });
  });
});

describe('progressColumns', () => {
  const row = (id: string, kind: PassRow['kind'], status: PassRow['status'] = 'complete') => ({ id, kind, status }) as PassRow;
  it('is the oldest baseline then up to 5 newest finished passes, oldest first', () => {
    const list = [row('r', 'pass', 'running'), ...Array.from({ length: 7 }, (_, i) => row(`p${i}`, 'pass')), row('b1', 'baseline'), row('b0', 'baseline')];
    expect(progressColumns(list).map((p) => p.id)).toEqual(['b0', 'p4', 'p3', 'p2', 'p1', 'p0']);
  });
});
