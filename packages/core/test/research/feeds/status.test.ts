import { describe, expect, it } from 'vitest';
import { FEEDS_STATS_KEY, readFeedsStatus } from '../../../src/research/feeds/status';
import { setSetting } from '../../../src/validation/settings';
import { testDb } from '../../helpers/db';

describe('readFeedsStatus', () => {
  it('is null before the first run and for a malformed setting', async () => {
    const db = await testDb();
    expect(await readFeedsStatus(db)).toBeNull();
    await setSetting(db, FEEDS_STATS_KEY, 'garbage');
    expect(await readFeedsStatus(db)).toBeNull();
  });

  it('lists sources in a fixed order, ignoring unknown ones and repairing bad numbers', async () => {
    const db = await testDb();
    await setSetting(db, FEEDS_STATS_KEY, {
      at: '2026-11-08T12:00:00.000Z', spentUsd: 0.5,
      bySource: { rss: { items: 3, added: 1, errors: ['x'] }, reddit: { items: 'many', added: 2, errors: [] }, mystery: { items: 1, added: 1, errors: [] } },
    });
    const s = await readFeedsStatus(db);
    expect(s?.sources.map((x) => x.name)).toEqual(['reddit', 'rss']);
    expect(s?.sources[0]).toMatchObject({ label: 'Reddit', items: 0, added: 2 });
  });
});
