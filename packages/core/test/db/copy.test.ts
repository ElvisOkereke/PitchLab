import { getTableName, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { CaseSections } from '../../src/case/schema';
import type { Db } from '../../src/db/client';
import { allTables, assertSameMigrations, copyDatabase, tableCopyOrder } from '../../src/db/copy';
import {
  claims, gateVerdicts, ideas, landingPages, lenses, outreachDrafts, outreachEvents, prospects, runStages, scores, settings,
  signals, stageEvents, suppressions, validationPacks,
} from '../../src/db/schema';
import { moveStage } from '../../src/dashboard/stage';
import { defaultRunConfig } from '../../src/pipeline/types';
import { parseCopyArgs } from '../../scripts/pglite-to-postgres';
import { insertCase, insertIdea, insertRun, testDb, unit } from '../helpers/db';

/** A source DB with rows in most tables (ids, vectors, jsonb, arrays, timestamps). */
async function seededSource(): Promise<Db> {
  const db = await testDb();
  const run = await insertRun(db, defaultRunConfig({ seedType: 'sector', sectors: ['HVAC'] }));
  await db.insert(runStages).values({ runId: run.id, stage: 'harvest', status: 'done', output: { signalIds: ['x'] } });
  await db.insert(signals).values({
    runId: run.id, marketId: 'ca-us', source: 'hn', url: 'https://news.test/1', title: 't', quote: 'q', quoteHash: 'h', embedding: unit(3), voice: 'operator',
  });
  const idea = await insertIdea(db, run.id, { embedding: unit(0), knownIncumbents: ['A', 'B'], status: 'advanced', lensId: 'aggregator' });
  const other = await insertIdea(db, run.id, { status: 'gated_out' });
  await db.insert(gateVerdicts).values({ ideaId: other.id, check: 'generic', pass: false, reasoning: 'r', model: 'm', promptVersion: 'p' });
  const kase = await insertCase(db, idea.id, {
    slug: 'copied-case', sections: { summary: { oneLiner: 'ü “quoted” <b>' }, numbers: { results: { buyer: { roiMultiple: 1.5 } } } } as unknown as CaseSections,
  });
  await db.insert(claims).values({ caseId: kase.id, section: 'evidence', text: 'c', sourceUrl: 'https://x.test', verified: 'needs_review', confidence: 0.4 });
  await db.insert(scores).values({ caseId: kase.id, criterion: 'gut', value: 4, note: 'n', by: 'owner' });
  await moveStage(db, { caseId: kase.id, from: 'new', to: 'validating' });
  await db.insert(validationPacks).values({ caseId: kase.id, sections: { checklist: { gates: [] } }, model: 'm', promptVersion: 'p' });
  const [p] = await db.insert(prospects).values({
    caseId: kase.id, name: 'P', website: 'https://p.test', domain: 'p.test', location: 'x', fitReason: 'f', source: 'manual', email: 'a@p.test', caslBasis: 'self_published',
  }).returning();
  await db.insert(outreachDrafts).values({ prospectId: p!.id, kind: 'cold', subject: 's', body: 'b', model: 'm', promptVersion: 'p' });
  await db.insert(outreachEvents).values({ prospectId: p!.id, type: 'sent', note: 'n' });
  await db.insert(suppressions).values({ email: 'gone@p.test', reason: 'unsubscribe' });
  await db.insert(landingPages).values({ caseId: kase.id, slug: 's', html: '<p>x</p>', copy: { headline: 'H' } });
  await db.insert(settings).values({ key: 'sender.name', value: 'Al' });
  return db;
}

const countOf = async (db: Db, t: PgTable) => (await db.select({ n: sql<number>`count(*)::int` }).from(t))[0]!.n;

describe('copy order', () => {
  it('orders parents before children', () => {
    const order = tableCopyOrder(allTables).map(getTableName);
    expect(order.indexOf('runs')).toBeLessThan(order.indexOf('ideas'));
    expect(order.indexOf('cases')).toBeLessThan(order.indexOf('stage_events'));
    expect(order.indexOf('prospects')).toBeLessThan(order.indexOf('outreach_events'));
    expect(order.indexOf('markets')).toBeLessThan(order.indexOf('signals'));
    expect(order.indexOf('landing_pages')).toBeLessThan(order.indexOf('landing_events'));
    expect(new Set(order).size).toBe(allTables.length);
  });

  it('allTables lists every table of the schema', () => {
    const names = allTables.map(getTableName);
    for (const n of ['markets', 'lenses', 'runs', 'run_stages', 'signals', 'ideas', 'gate_verdicts', 'cases', 'claims', 'scores', 'llm_calls',
      'data_calls', 'validation_packs', 'prospects', 'outreach_drafts', 'outreach_events', 'suppressions', 'landing_pages', 'landing_events',
      'settings', 'stage_events']) expect(names).toContain(n);
  });
});

describe('copyDatabase', () => {
  it('copies every table with ids, vectors and jsonb intact, and is idempotent', async () => {
    const src = await seededSource();
    const dst = await testDb();
    const r1 = await copyDatabase(src, dst, { batchSize: 2 });
    expect(r1.map((t) => t.table).sort()).toEqual(allTables.map(getTableName).sort());
    expect(r1.filter((t) => !t.ok)).toEqual([]);
    expect(r1.find((t) => t.table === 'ideas')).toMatchObject({ source: 2, inserted: 2, target: 2, ok: true });
    expect(r1.find((t) => t.table === 'lenses')).toMatchObject({ inserted: 0, ok: true }); // both sides seeded

    const [srcIdea] = await src.select().from(ideas).where(sql`${ideas.embedding} is not null`);
    const [dstIdea] = await dst.select().from(ideas).where(sql`${ideas.id} = ${srcIdea!.id}`);
    expect(dstIdea!.embedding![0]).toBe(1);
    expect(dstIdea).toEqual(srcIdea);
    expect(await dst.select().from(stageEvents)).toEqual(await src.select().from(stageEvents));
    expect(await dst.select().from(signals)).toEqual(await src.select().from(signals));
    for (const t of allTables) expect(await countOf(dst, t), getTableName(t)).toBe(await countOf(src, t));

    const r2 = await copyDatabase(src, dst);
    expect(r2.reduce((n, t) => n + t.inserted, 0)).toBe(0);
    expect(r2.every((t) => t.ok)).toBe(true);
  });

  it('reports a mismatch when the target already holds extra rows', async () => {
    const src = await testDb();
    const dst = await testDb();
    await dst.insert(lenses).values({ id: 'extra', name: 'x', pattern: 'p', promptHint: 'h' });
    const r = await copyDatabase(src, dst);
    expect(r.find((t) => t.table === 'lenses')).toMatchObject({ source: 8, inserted: 0, target: 9, ok: false });
    expect(r.filter((t) => !t.ok).map((t) => t.table)).toEqual(['lenses']);
  });

  it('never writes to the source', async () => {
    const src = await seededSource();
    const before = await Promise.all(allTables.map((t) => countOf(src, t)));
    await copyDatabase(src, await testDb());
    expect(await Promise.all(allTables.map((t) => countOf(src, t)))).toEqual(before);
  });
});

describe('assertSameMigrations', () => {
  it('passes for two migrated databases', async () => {
    await expect(assertSameMigrations(await testDb(), await testDb())).resolves.toBeUndefined();
  });

  it('assertSameMigrations throws when the source is behind', async () => {
    const src = await testDb();
    await src.execute(sql`delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)`);
    await expect(assertSameMigrations(src, await testDb())).rejects.toThrow(/behind/);
  });
});

describe('db:copy arguments', () => {
  const base = 'C:\\repo dir';
  it('defaults --from to the local PGlite folder and --to to DATABASE_URL, resolving paths against INIT_CWD', () => {
    const a = parseCopyArgs([], { DATABASE_URL: 'postgres://bcg:pw@127.0.0.1:5433/bcg' }, base);
    expect(a).toMatchObject({ ok: true, to: 'postgres://bcg:pw@127.0.0.1:5433/bcg', dryRun: false });
    expect((a as { from: string }).from).toMatch(/^pglite:\/\/.*repo dir.*\.data.*pglite$/);
    expect(parseCopyArgs(['--from', 'pglite://other/db', '--to', 'postgresql://x@h/db', '--dry-run'], {}, base))
      .toMatchObject({ ok: true, to: 'postgresql://x@h/db', dryRun: true });
  });

  it('refuses a target that is not postgres:// (exit 2) and never echoes the URL', () => {
    for (const to of ['pglite://.data/pglite', 'mysql://u:secretpw@h/db', '']) {
      const r = parseCopyArgs(['--to', to], {}, base);
      expect(r).toMatchObject({ ok: false, exitCode: 2 });
      expect((r as { message: string }).message).not.toContain('secretpw');
    }
    expect(parseCopyArgs([], {}, base)).toMatchObject({ ok: false, exitCode: 2 });
    expect(parseCopyArgs(['--from', 'postgres://x/y', '--to', 'postgres://h/db'], {}, base)).toMatchObject({ ok: false, exitCode: 2 });
    expect(parseCopyArgs(['--from', 'pglite://memory', '--to', 'postgres://h/db'], {}, base)).toMatchObject({ ok: false, exitCode: 2 });
    expect(parseCopyArgs(['--bogus'], { DATABASE_URL: 'postgres://h/db' }, base)).toMatchObject({ ok: false, exitCode: 2 });
  });
});
