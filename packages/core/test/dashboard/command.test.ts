import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { CaseSections } from '../../src/case/schema';
import { dataCalls, llmCalls, outreachEvents, prospects, runs, scores } from '../../src/db/schema';
import { needsYou, spendSince, torontoDayStart, torontoWeekStart } from '../../src/dashboard/command';
import { moveStage } from '../../src/dashboard/stage';
import { defaultRunConfig } from '../../src/pipeline/types';
import { EXAMPLE_SLUG, ensureExample } from '../../src/example/example';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';

describe('Toronto days', () => {
  it('torontoDayStart handles the DST change', () => {
    expect(torontoDayStart(new Date('2026-11-01T12:00:00Z')).toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(torontoDayStart(new Date('2026-11-02T12:00:00Z')).toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(torontoWeekStart(new Date('2026-10-21T12:00:00Z')).toISOString()).toBe('2026-10-19T04:00:00.000Z');
  });

  it('uses the Toronto calendar day, not the UTC one, and Monday weeks', () => {
    // 02:00 UTC on Oct 20 is still Oct 19 in Toronto.
    expect(torontoDayStart(new Date('2026-10-20T02:00:00Z')).toISOString()).toBe('2026-10-19T04:00:00.000Z');
    // A Monday maps to itself; a Sunday to the Monday before; a week spanning the DST change.
    expect(torontoWeekStart(new Date('2026-10-19T04:00:00Z')).toISOString()).toBe('2026-10-19T04:00:00.000Z');
    expect(torontoWeekStart(new Date('2026-10-26T03:59:59Z')).toISOString()).toBe('2026-10-19T04:00:00.000Z');
    expect(torontoWeekStart(new Date('2026-11-04T12:00:00Z')).toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(torontoWeekStart(new Date('2026-11-01T12:00:00Z')).toISOString()).toBe('2026-10-26T04:00:00.000Z');
    // Spring forward (2027-03-14).
    expect(torontoDayStart(new Date('2027-03-14T12:00:00Z')).toISOString()).toBe('2027-03-14T05:00:00.000Z');
    expect(torontoDayStart(new Date('2027-03-15T12:00:00Z')).toISOString()).toBe('2027-03-15T04:00:00.000Z');
  });
});

describe('command center data', () => {
  it('spendSince sums LLM and data costs from the given instant', async () => {
    const db = await testDb();
    const call = (costUsd: string, createdAt: Date) => ({
      stage: 'case', provider: 'anthropic', model: 'm', inputTokens: 1, outputTokens: 1, searchRequests: 0, costUsd, latencyMs: 1,
      promptVersion: 'p', ok: true, createdAt,
    });
    await db.insert(llmCalls).values([call('1.25', new Date('2026-10-19T10:00:00Z')), call('0.5', new Date('2026-10-19T11:00:00Z')), call('9', new Date('2026-10-18T10:00:00Z'))]);
    await db.insert(dataCalls).values([
      { provider: 'places', endpoint: 'x', costUsd: '0.032', ok: true, createdAt: new Date('2026-10-19T12:00:00Z') },
      { provider: 'places', endpoint: 'x', costUsd: '5', ok: true, createdAt: new Date('2026-10-01T12:00:00Z') },
    ]);
    expect(await spendSince(db, new Date('2026-10-19T04:00:00Z'))).toEqual({ llmUsd: 1.75, dataUsd: 0.032, llmCalls: 2 });
    expect(await spendSince(db, new Date('2030-01-01T00:00:00Z'))).toEqual({ llmUsd: 0, dataUsd: 0, llmCalls: 0 });
  });

  it('needsYou lists unscored cases, advisory cases, stale sent prospects and recent failed runs', async () => {
    const db = await testDb();
    const now = new Date('2026-10-19T12:00:00Z');
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const flags = (gateFlags: string[]) => ({ summary: { oneLiner: 'o', gateFlags } }) as unknown as CaseSections;

    const unscored = await insertCase(db, (await insertIdea(db, run.id)).id, { slug: 'unscored', title: 'Unscored' });
    const scored = await insertCase(db, (await insertIdea(db, run.id)).id, { slug: 'scored', title: 'Scored' });
    await db.insert(scores).values({ caseId: scored.id, criterion: 'gut', value: 3, note: '', by: 'owner' });
    const killed = await insertCase(db, (await insertIdea(db, run.id)).id, { slug: 'killed', title: 'Killed', stage: 'killed' });
    void killed;
    const advisory = await insertCase(db, (await insertIdea(db, run.id)).id, { slug: 'advisory', title: 'Advisory', sections: flags(['evidence']), gateAdvisory: true });
    await db.insert(scores).values({ caseId: advisory.id, criterion: 'gut', value: 3, note: '', by: 'owner' });
    const decided = await insertCase(db, (await insertIdea(db, run.id)).id, { slug: 'decided', title: 'Decided', sections: flags(['control']), gateAdvisory: true });
    await db.insert(scores).values({ caseId: decided.id, criterion: 'gut', value: 3, note: '', by: 'owner' });
    await moveStage(db, { caseId: decided.id, from: 'new', to: 'validating' });

    const p = (name: string, domain: string, status: 'sent' | 'replied') =>
      ({ caseId: scored.id, name, website: `https://${domain}`, domain, location: 'x', fitReason: 'f', source: 'manual' as const, status });
    const [stale, fresh, replied] = await db.insert(prospects).values([p('Stale Co', 'stale.test', 'sent'), p('Fresh Co', 'fresh.test', 'sent'), p('Replied Co', 'replied.test', 'replied')]).returning();
    await db.insert(outreachEvents).values([
      { prospectId: stale!.id, type: 'sent', at: new Date('2026-10-10T12:00:00Z') },
      { prospectId: fresh!.id, type: 'sent', at: new Date('2026-10-18T12:00:00Z') },
      { prospectId: replied!.id, type: 'sent', at: new Date('2026-10-01T12:00:00Z') },
    ]);

    const recent = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    await db.update(runs).set({ status: 'failed', error: 'boom', currentStage: 'case', finishedAt: new Date('2026-10-18T00:00:00Z') }).where(eq(runs.id, recent.id));
    const old = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    await db.update(runs).set({ status: 'failed', error: 'old', finishedAt: new Date('2026-10-01T00:00:00Z') }).where(eq(runs.id, old.id));

    const items = await needsYou(db, now);
    const summary = items.map((i) => [i.kind, i.href]);
    expect(summary).toEqual(expect.arrayContaining([
      ['score', '/cases/unscored?tab=score'],
      ['advisory', '/cases/advisory'],
      ['reply', '/cases/scored?tab=validate'],
      ['failed_run', '/runs'],
    ]));
    expect(items).toHaveLength(4);
    expect(items.find((i) => i.kind === 'reply')!.label).toContain('Stale Co');
    expect(items.find((i) => i.kind === 'failed_run')!.label).toContain('boom');
    expect(items.every((i) => i.at instanceof Date)).toBe(true);
    const times = items.map((i) => i.at.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('cuts a huge legacy run error to 16 KB before scrubbing it (D2-R3)', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    await db.update(runs).set({ status: 'failed', error: 'e '.repeat(100_000), finishedAt: new Date('2026-10-19T00:00:00Z') }).where(eq(runs.id, run.id));
    const { listRuns } = await import('../../src/dashboard/runs');
    expect((await listRuns(db, { page: 1, pageSize: 5 })).rows[0]!.error!.length).toBeLessThanOrEqual(16_384);
    expect((await needsYou(db, new Date('2026-10-19T12:00:00Z')))[0]!.label.length).toBeLessThan(200);
  });

  it('scrubs credentials from legacy stored run errors in labels and run rows (D2-R1)', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const leaked = 'boom: Authorization: Bearer xoxb-1234-5678-abcdef token=hunter2 https://u:p@db.test/x?sig=a1b2c3d4e5f6g7h8i9j0k1l2';
    await db.update(runs).set({ status: 'failed', error: leaked, finishedAt: new Date('2026-10-19T00:00:00Z') }).where(eq(runs.id, run.id));
    const items = await needsYou(db, new Date('2026-10-19T12:00:00Z'));
    const label = items.find((i) => i.kind === 'failed_run')!.label;
    const { listRuns } = await import('../../src/dashboard/runs');
    const row = (await listRuns(db, { page: 1, pageSize: 5 })).rows.find((r) => r.id === run.id)!;
    for (const text of [label, row.error!]) {
      expect(text).toContain('boom');
      expect(text).not.toMatch(/xoxb|hunter2|u:p@|sig=|a1b2c3/);
    }
  });
});

describe('example case in command center', () => {
  it('needsYou skips the example; spendSince is unchanged', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    await insertCase(db, (await insertIdea(db, run.id)).id, { slug: 'real', title: 'Real' });
    const since = new Date('2000-01-01T00:00:00Z');
    const spend = await spendSince(db, since);
    await ensureExample(db);
    expect(await spendSince(db, since)).toEqual(spend);
    const items = await needsYou(db, new Date());
    expect(items.some((i) => i.href.includes('/real'))).toBe(true);
    expect(items.some((i) => i.href.includes(EXAMPLE_SLUG))).toBe(false);
  });
});
