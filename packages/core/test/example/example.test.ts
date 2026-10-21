import { describe, expect, it, vi } from 'vitest';
import { count, eq } from 'drizzle-orm';
import { createTestDb } from '../../src/db/test-db';
import {
  cases, dataCalls, ideas, llmCalls, outreachEvents, prospects, runs, scores, suppressions,
} from '../../src/db/schema';
import { CaseSectionsSchema } from '../../src/case/schema';
import { LandingCopySchema, PackSectionsSchema } from '../../src/validation/schema';
import {
  EXAMPLE_HIDDEN_KEY, EXAMPLE_REFUSAL, EXAMPLE_SLUG, ensureExample, ensureExampleQuietly, exampleState, hideExample, isReservedExampleEmail,
  listRealRuns, realCaseSlugs, resetExample,
} from '../../src/example/example';
import { exampleFixture } from '../../src/example/fixture';
import { defaultRunConfig } from '../../src/pipeline/types';
import { insertCase, insertIdea, insertRun } from '../helpers/db';

const n = async (db: Awaited<ReturnType<typeof createTestDb>>, t: typeof cases | typeof runs) =>
  (await db.select({ n: count() }).from(t).where(eq(t.isExample, true)))[0]!.n;

describe('example case', () => {
  it('ensureExample inserts once', async () => {
    const db = await createTestDb();
    expect(await ensureExample(db)).toBe('inserted');
    expect(await ensureExample(db)).toBe('present');
    const rows = await db.select().from(cases).where(eq(cases.isExample, true));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slug).toBe(EXAMPLE_SLUG);
    expect(EXAMPLE_SLUG.startsWith('example-')).toBe(true);
    expect(rows[0]!.gateAdvisory).toBe(true);
  });

  it('hidden stays hidden', async () => {
    const db = await createTestDb();
    await ensureExample(db);
    await hideExample(db);
    expect(await ensureExample(db)).toBe('hidden');
    expect(await n(db, runs)).toBe(0);
    expect(await n(db, cases)).toBe(0);
    const ideaRows = await db.select().from(ideas);
    expect(ideaRows).toHaveLength(0);
    expect(await exampleState(db)).toEqual({ hidden: true, slug: null });
    expect(EXAMPLE_HIDDEN_KEY).toBe('example.hidden');
  });

  it('reset restores one copy', async () => {
    const db = await createTestDb();
    await ensureExample(db);
    const [c] = await db.select().from(cases).where(eq(cases.isExample, true));
    const [p] = await db.select().from(prospects).where(eq(prospects.caseId, c!.id));
    await db.insert(scores).values({ caseId: c!.id, criterion: 'gut', value: 3, note: 'x', by: 'owner' });
    await db.insert(outreachEvents).values({ prospectId: p!.id, type: 'note', note: 'x' });
    await resetExample(db);
    await resetExample(db);
    expect(await n(db, cases)).toBe(1);
    expect(await n(db, runs)).toBe(1);
    expect(await db.select().from(ideas)).toHaveLength(1);
    expect((await db.select({ n: count() }).from(scores).where(eq(scores.by, 'owner')))[0]!.n).toBe(0);
    expect((await db.select({ n: count() }).from(outreachEvents))[0]!.n).toBe(0);
    expect(await exampleState(db)).toEqual({ hidden: false, slug: EXAMPLE_SLUG });
  });

  it('reset after hide brings it back', async () => {
    const db = await createTestDb();
    await hideExample(db);
    await resetExample(db);
    expect(await ensureExample(db)).toBe('present');
  });

  it('fixture parses', () => {
    const f = exampleFixture();
    CaseSectionsSchema.parse(f.sections);
    PackSectionsSchema.parse(f.pack.sections);
    LandingCopySchema.parse(f.landing.copy);
  });

  it('has the required mix of rows', async () => {
    const f = exampleFixture();
    expect(f.claims.length).toBeGreaterThanOrEqual(8);
    expect(new Set(f.claims.map((c) => c.verified))).toEqual(new Set(['verified', 'unverified', 'needs_review']));
    expect(new Set(f.scores.map((s) => s.criterion))).toEqual(new Set(['pain', 'roi', 'evidence', 'speed', 'autonomy', 'novelty', 'reach']));
    expect(f.scores.every((s) => s.by === 'ai')).toBe(true);
    expect(f.prospects).toHaveLength(4);
    expect(new Set(f.prospects.map((p) => p.caslBasis))).toEqual(new Set(['self_published', 'third_party', 'unknown']));
    expect(f.prospects.some((p) => !p.email)).toBe(true);
    const withEmail = f.prospects.filter((p) => p.email);
    expect(f.drafts.length).toBe(withEmail.length * 3);
  });

  it('reserved domains only', () => {
    const json = JSON.stringify(exampleFixture());
    const ok = (host: string) => /(^|\.)(example\.com|example\.org|example\.net|example)$/i.test(host);
    const urls = json.match(/https?:\/\/[^"\s]+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(ok(new URL(u).hostname), u).toBe(true);
    const emails = json.match(/[^"\s@]+@[^"\s]+/g) ?? [];
    expect(emails.length).toBeGreaterThan(0);
    for (const e of emails) expect(ok(e.split('@')[1]!.replace(/[^a-z0-9.-]+$/i, '')), e).toBe(true);
  });

  it('no spend rows', async () => {
    const db = await createTestDb();
    await ensureExample(db);
    expect((await db.select({ n: count() }).from(llmCalls))[0]!.n).toBe(0);
    expect((await db.select({ n: count() }).from(dataCalls))[0]!.n).toBe(0);
  });

  it('test DBs have no example', async () => {
    const db = await createTestDb();
    expect(await n(db, cases)).toBe(0);
  });

  it('deleting the example removes only reserved-domain suppressions, never a real unsubscribe (I2)', async () => {
    const db = await createTestDb();
    await ensureExample(db);
    const [row] = await db.select({ email: prospects.email }).from(prospects).where(eq(prospects.domain, 'northwind-plumbing.example.com'));
    expect(row!.email).toBeTruthy();
    await db.insert(suppressions).values([{ email: row!.email!.toLowerCase(), reason: 'unsubscribed' }, { email: 'real@acme.com', reason: 'unsubscribed' }] as never);
    await hideExample(db);
    const left = (await db.select({ email: suppressions.email }).from(suppressions)).map((r) => r.email);
    expect(left).toEqual(['real@acme.com']);
  });

  it('isReservedExampleEmail', () => {
    for (const e of ['a@example.com', 'a@x.example.org', 'A@Foo.EXAMPLE.net', 'a@shop.example']) expect(isReservedExampleEmail(e), e).toBe(true);
    for (const e of ['a@acme.com', 'a@notexample.com', 'a@example.com.evil.io', 'nope']) expect(isReservedExampleEmail(e), e).toBe(false);
  });

  it('ensureExample is safe when the example slug already exists as a non-flagged row (race)', async () => {
    const db = await createTestDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await insertIdea(db, run.id, { title: 'Other' });
    await insertCase(db, idea.id, { slug: EXAMPLE_SLUG });
    expect(await ensureExample(db)).toBe('present');
    expect((await db.select({ n: count() }).from(runs))[0]!.n).toBe(1);
    expect((await db.select({ n: count() }).from(ideas))[0]!.n).toBe(1);
  });

  it('ensureExampleQuietly warns once without details and does not throw (I3)', async () => {
    const warn = vi.fn();
    const broken = { transaction: async () => { throw Object.assign(new Error('postgres://u:secret@host/db failed'), { code: '23505' }); } };
    await ensureExampleQuietly(broken as never, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).not.toMatch(/secret|postgres:/);
  });

  it('listRealRuns and realCaseSlugs skip the example (M2)', async () => {
    const db = await createTestDb();
    await ensureExample(db);
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await insertIdea(db, run.id, { title: 'Real' });
    await insertCase(db, idea.id, { slug: 'real-case' });
    expect((await listRealRuns(db, 20)).map((r) => r.id)).toEqual([run.id]);
    expect(await realCaseSlugs(db)).toEqual(['real-case']);
    expect(EXAMPLE_REFUSAL).toMatch(/built-in example case/);
  });
});
