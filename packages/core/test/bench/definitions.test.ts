import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { BENCHMARKS, CURRENT_BENCHMARK, METRIC_DEFS } from '../../src/bench/definitions';
import { CA_US, LENSES } from '../../src/db/seed';
import { testDb } from '../helpers/db';
import { benchmarkPasses, runs } from '../../src/db/schema';

describe('bench definitions', () => {
  it('bench-v1 is frozen', () => {
    expect(
      BENCHMARKS['bench-v1'],
      'bench-v1 is immutable; add bench-v2 instead',
    ).toEqual({
      seeds: [
        { seedType: 'open' },
        { seedType: 'sector', sectors: ['dental clinics', 'restaurants/multi-location food'] },
        { seedType: 'sector', sectors: ['property management', 'ecommerce brands (Shopify)'] },
        { seedType: 'lens', lensIds: ['platform-shockwave', 'public-data-decision'] },
      ],
      ideaCount: 12,
      advanceCount: 3,
      costNote: 'about $12–28 in model calls (4 runs at about $3–7 each)',
    });
    expect(CURRENT_BENCHMARK).toBe('bench-v1');
  });

  it('every sector and lens id exists in the seed data', () => {
    const lensIds = new Set(LENSES.map((l) => l.id));
    for (const s of BENCHMARKS['bench-v1'].seeds) {
      if (s.seedType === 'sector') for (const x of s.sectors) expect(CA_US.sectors).toContain(x);
      if (s.seedType === 'lens') for (const x of s.lensIds) expect(lensIds.has(x)).toBe(true);
    }
  });

  it('METRIC_DEFS has 13 unique ids in order', () => {
    expect(METRIC_DEFS.map((m) => m.id)).toEqual([
      'repetition', 'nearDuplicates', 'buyerVariety', 'consumerShare', 'modelVariety', 'realNeed',
      'demandEvidence', 'customerReturn', 'margin', 'wastedEntrants', 'easyStartHardCopy', 'ownerVerdict', 'costPerCase',
    ]);
    expect(new Set(METRIC_DEFS.map((m) => m.id)).size).toBe(13);
    const phased = Object.fromEntries(METRIC_DEFS.filter((m) => m.phase).map((m) => [m.id, m.phase]));
    expect(phased).toEqual({ consumerShare: 3, modelVariety: 3, demandEvidence: 2, easyStartHardCopy: 3 });
  });
});

describe('benchmark schema', () => {
  it('migrates with runs.benchmark_pass_id and benchmark_passes', async () => {
    const db = await testDb();
    const [p] = await db.insert(benchmarkPasses).values({ version: 'bench-v1', label: 'bench-v1 #1', kind: 'pass', status: 'running', runIds: [] }).returning();
    const [r] = await db.insert(runs).values({ config: {} as never, status: 'queued', benchmarkPassId: p.id }).returning();
    expect(r.benchmarkPassId).toBe(p.id);
    const [p2] = await db.insert(benchmarkPasses).values({ version: 'bench-v1', label: 'rc', kind: 'recompute', status: 'complete', runIds: [r.id], sourcePassId: p.id }).returning();
    expect(p2.sourcePassId).toBe(p.id);
    const res = await db.execute(sql`select 1 from information_schema.columns where table_name='runs' and column_name='benchmark_pass_id'`);
    expect((res as unknown as { rows: unknown[] }).rows).toHaveLength(1);
  });
});
