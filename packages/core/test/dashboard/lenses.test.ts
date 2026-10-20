import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { LENSES_MAX, listActiveLenses } from '../../src/dashboard/lenses';
import { getMarket } from '../../src/dashboard/markets';
import { QUEUE_MARKET_ID } from '../../src/dashboard/runs';
import { lenses } from '../../src/db/schema';
import { testDb } from '../helpers/db';

describe('listActiveLenses', () => {
  it('returns active lenses (id + name only), sorted by name, bounded', async () => {
    const db = await testDb();
    await db.update(lenses).set({ active: false }).where(eq(lenses.id, 'aggregator'));
    const rows = await listActiveLenses(db);
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.length).toBeLessThanOrEqual(LENSES_MAX);
    expect(rows.find((l) => l.id === 'aggregator')).toBeUndefined();
    expect(rows.find((l) => l.id === 'silent-failure')).toEqual({ id: 'silent-failure', name: 'Silent failure monitor' });
    expect(Object.keys(rows[0]!).sort()).toEqual(['id', 'name']);
    expect(rows.map((r) => r.name)).toEqual([...rows.map((r) => r.name)].sort((a, b) => a.localeCompare(b)));
  });
});

describe('getMarket', () => {
  it('returns the queue market with its sectors, or null for an unknown id', async () => {
    const db = await testDb();
    const m = await getMarket(db, QUEUE_MARKET_ID);
    expect(m).toMatchObject({ id: 'ca-us', name: 'Canada + US' });
    expect(m!.sectors).toContain('HVAC');
    expect(Object.keys(m!).sort()).toEqual(['id', 'name', 'sectors']);
    expect(await getMarket(db, 'nowhere')).toBeNull();
  });
});
