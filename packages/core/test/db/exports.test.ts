import { describe, expect, it } from 'vitest';

describe('core package surface', () => {
  it('resolves core subpaths through the package name', async () => {
    const { cases } = await import('@bcg/core/db/schema');
    const { createTestDb } = await import('@bcg/core/db/test-db');
    const db = await createTestDb();
    expect(await db.select().from(cases)).toEqual([]);
  });

  it('exposes the shared Postgres pool config for the web app', async () => {
    const { pgPoolConfig } = await import('@bcg/core/db/pg-config');
    expect(pgPoolConfig('postgres://u:p@127.0.0.1:5433/d', { defaultMax: 5 }).max).toBe(5);
  });

  it('exposes the outreach tracking helpers without the LLM router', async () => {
    const tracking = await import('@bcg/core/validation/tracking');
    const outreach = await import('@bcg/core/validation/outreach');
    expect(tracking.markOutreach).toBe(outreach.markOutreach);
    expect(tracking.outreachCounts).toBe(outreach.outreachCounts);
    expect(tracking.nextStatus).toBe(outreach.nextStatus);
  });
});
