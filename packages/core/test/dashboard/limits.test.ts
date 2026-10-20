import { describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client';
import { prospects, runs } from '../../src/db/schema';
import { RUNS_PAGE_MAX, listRuns } from '../../src/dashboard/runs';
import { PROSPECTS_PAGE_MAX, getValidateView } from '../../src/dashboard/validate-view';
import { defaultRunConfig } from '../../src/pipeline/types';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';

async function manyRuns(db: Db, n: number) {
  await db.insert(runs).values(Array.from({ length: n }, () => ({ config: defaultRunConfig({ seedType: 'open' }), status: 'succeeded' as const })));
}

describe('bounded queries', () => {
  it('caps page sizes', async () => {
    const db = await testDb();
    await manyRuns(db, 60);
    expect(RUNS_PAGE_MAX).toBe(50);
    expect((await listRuns(db, { page: -3, pageSize: 10_000 })).rows.length).toBeLessThanOrEqual(50);
    expect((await listRuns(db, { page: 1, pageSize: 10_000 })).rows).toHaveLength(50);
    expect((await listRuns(db, { page: 1, pageSize: 0 })).rows).toHaveLength(1);
    expect((await listRuns(db, { page: 1, pageSize: Number.NaN })).rows.length).toBeLessThanOrEqual(50);
  });

  it('a negative or non-numeric page becomes 1', async () => {
    const db = await testDb();
    await manyRuns(db, 3);
    const first = (await listRuns(db, { page: 1, pageSize: 2 })).rows.map((r) => r.id);
    for (const page of [-3, 0, Number.NaN, 'abc' as unknown as number, 1.7]) {
      expect((await listRuns(db, { page, pageSize: 2 })).rows.map((r) => r.id)).toEqual(first);
    }
    expect((await listRuns(db, { page: 2, pageSize: 2 })).rows).toHaveLength(1);
  });

  it('prospects are at most 100 per page', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const { id: caseId } = await insertCase(db, (await insertIdea(db, run.id)).id);
    await db.insert(prospects).values(Array.from({ length: 105 }, (_, i) => ({
      caseId, name: `P${String(i).padStart(3, '0')}`, website: `https://p${i}.test`, domain: `p${i}.test`, location: 'x', fitReason: 'f', source: 'manual' as const,
    })));
    expect(PROSPECTS_PAGE_MAX).toBe(100);
    const p1 = await getValidateView(db, caseId, { page: -1 });
    expect(p1.prospects.rows).toHaveLength(100);
    expect(p1.prospects.total).toBe(105);
    expect((await getValidateView(db, caseId, { page: 2 })).prospects.rows).toHaveLength(5);
  });
});
