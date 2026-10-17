import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { claims } from '../../src/db/schema';
import { verify } from '../../src/pipeline/verify';
import { defaultRunConfig, type StageDeps } from '../../src/pipeline/types';
import type { PageResult } from '../../src/tools/fetch-page';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';
import { fakeRouter } from '../helpers/fake-router';

const page = (text: string, ok = true): PageResult => ({ ok, status: ok ? 200 : 404, finalUrl: 'https://page.example/', title: 't', text, ...(ok ? {} : { reason: 'http_error' as const }) });

async function setup() {
  const db = await testDb();
  const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
  const idea = await insertIdea(db, run.id);
  const kase = await insertCase(db, idea.id);
  return { db, run, kase };
}

const mk = (db: Awaited<ReturnType<typeof testDb>>, caseId: string, rows: { text: string; sourceUrl: string; quote: string | null }[]) =>
  db.insert(claims).values(rows.map((r) => ({ caseId, section: 'evidence', ...r }))).returning();

describe('verify', () => {
  it('classifies verified / unsupported / unreachable', async () => {
    const { db, run, kase } = await setup();
    const [a, b, c] = await mk(db, kase.id, [
      { text: 'A', sourceUrl: 'https://a.com', quote: 'Small teams spend $40/hour on this manual task' },
      { text: 'B', sourceUrl: 'https://b.com', quote: 'a quote that is absent' },
      { text: 'C', sourceUrl: 'https://c.com', quote: 'whatever' },
    ]);
    const fetchPage = vi.fn(async (url: string) =>
      url.includes('c.com') ? page('', false) : url.includes('a.com') ? page('Intro. SMALL teams spend  $40 / hour, on this manual task!! Outro') : page(`Unrelated text. ${'Lorem ipsum dolor sit amet. '.repeat(10)}`));
    const router = fakeRouter({ structured: { verify: [{ supported: false, confidence: 0.9 }] } });
    const deps = { db, router, fetchPage, log: () => {} } as unknown as StageDeps;
    const out = await verify(deps, run, { caseIds: [kase.id] });
    expect(out).toEqual({ caseIds: [kase.id] });
    expect(router.calls.filter((x) => x.stage === 'verify')).toHaveLength(1);
    const rows = new Map((await db.select().from(claims).where(eq(claims.caseId, kase.id))).map((r) => [r.id, r]));
    expect(rows.get(a!.id)).toMatchObject({ verified: 'verified', confidence: 1 });
    expect(rows.get(b!.id)).toMatchObject({ verified: 'unsupported', confidence: 0.9 });
    expect(rows.get(c!.id)!.verified).toBe('unreachable');
    for (const r of rows.values()) expect(r.checkedAt).not.toBeNull();
  });

  it('fetches each URL once', async () => {
    const { db, run, kase } = await setup();
    await mk(db, kase.id, [
      { text: 'A', sourceUrl: 'https://a.com', quote: 'alpha beta gamma delta epsilon zeta eta theta' },
      { text: 'B', sourceUrl: 'https://a.com', quote: 'beta gamma delta epsilon zeta eta theta iota' },
    ]);
    const fetchPage = vi.fn(async () => page('alpha beta gamma delta epsilon zeta eta theta iota'));
    const deps = { db, router: fakeRouter({}), fetchPage, log: () => {} } as unknown as StageDeps;
    await verify(deps, run, { caseIds: [kase.id] });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('judges a claim with no quote via the LLM, clamps confidence, and shows the best window', async () => {
    const { db, run, kase } = await setup();
    const [a] = await mk(db, kase.id, [{ text: 'zebra migration doubles', sourceUrl: 'https://a.com', quote: null }]);
    const filler = 'lorem ipsum '.repeat(1000);
    const fetchPage = vi.fn(async () => page(`${filler} zebra migration doubles ${filler}`));
    const router = fakeRouter({ structured: { verify: [{ supported: true, confidence: 7 }] } });
    const deps = { db, router, fetchPage, log: () => {} } as unknown as StageDeps;
    await verify(deps, run, { caseIds: [kase.id] });
    expect(router.calls[0]!.prompt).toContain('zebra migration doubles');
    const [row] = await db.select().from(claims).where(eq(claims.id, a!.id));
    expect(row).toMatchObject({ verified: 'verified', confidence: 1 });
  });

  it('skips claims without a source URL and makes no calls for empty input', async () => {
    const { db, run, kase } = await setup();
    const [a] = await mk(db, kase.id, [{ text: 'A', sourceUrl: '', quote: 'x' }]);
    const fetchPage = vi.fn(async () => page('x'));
    const deps = { db, router: fakeRouter({}), fetchPage, log: () => {} } as unknown as StageDeps;
    await verify(deps, run, { caseIds: [kase.id] });
    await verify(deps, run, { caseIds: [] });
    expect(fetchPage).not.toHaveBeenCalled();
    const [row] = await db.select().from(claims).where(eq(claims.id, a!.id));
    expect(row!.verified).toBe('unverified');
  });

  it('marks a banned-domain claim unsupported without fetching or judging', async () => {
    const { db, run, kase } = await setup();
    const [a] = await mk(db, kase.id, [{ text: 'Customers hate it', sourceUrl: 'https://uk.trustpilot.com/review/acme.com', quote: 'one two three four five six' }]);
    const fetchPage = vi.fn(async () => page('one two three four five six'));
    const router = fakeRouter({});
    await verify({ db, router, fetchPage, log: () => {} } as unknown as StageDeps, run, { caseIds: [kase.id] });
    expect(fetchPage).not.toHaveBeenCalled();
    expect(router.calls).toHaveLength(0);
    const [row] = await db.select().from(claims).where(eq(claims.id, a!.id));
    expect(row!.verified).toBe('unsupported');
    expect(row!.checkedAt).not.toBeNull();
  });

  it('marks a claim unsupported without judging when the page redirects into a banned domain', async () => {
    const { db, run, kase } = await setup();
    const [a] = await mk(db, kase.id, [{ text: 'Owners complain', sourceUrl: 'https://short.example/x', quote: 'short' }]);
    const fetchPage = vi.fn(async (): Promise<PageResult> => ({
      ok: true, status: 200, finalUrl: 'https://www.reddit.com/r/smallbusiness/comments/1', title: 't', text: 'short',
    }));
    const router = fakeRouter({});
    await verify({ db, router, fetchPage, log: () => {} } as unknown as StageDeps, run, { caseIds: [kase.id] });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(router.calls).toHaveLength(0);
    const [row] = await db.select().from(claims).where(eq(claims.id, a!.id));
    expect(row).toMatchObject({ verified: 'unsupported', confidence: null });
  });

  it('marks a non-http claim url unsupported without fetching', async () => {
    const { db, run, kase } = await setup();
    const [a] = await mk(db, kase.id, [{ text: 'X', sourceUrl: 'javascript:alert(1)', quote: 'x' }]);
    const fetchPage = vi.fn(async () => page('x'));
    await verify({ db, router: fakeRouter({}), fetchPage, log: () => {} } as unknown as StageDeps, run, { caseIds: [kase.id] });
    expect(fetchPage).not.toHaveBeenCalled();
    const [row] = await db.select().from(claims).where(eq(claims.id, a!.id));
    expect(row!.verified).toBe('unsupported');
  });

  async function judged(quote: string, pageText: string, verdict: { supported: boolean; confidence: number }) {
    const { db, run, kase } = await setup();
    const [a] = await mk(db, kase.id, [{ text: 'claim text', sourceUrl: 'https://a.com', quote }]);
    const router = fakeRouter({ structured: { verify: [verdict] } });
    // Padded past MIN_READABLE_CHARS so the judge path is exercised.
    const padded = `${pageText} ${'lorem ipsum dolor sit amet '.repeat(10)}`;
    const deps = { db, router, fetchPage: async () => page(padded), log: () => {} } as unknown as StageDeps;
    await verify(deps, run, { caseIds: [kase.id] });
    const [row] = await db.select().from(claims).where(eq(claims.id, a!.id));
    return { row: row!, calls: router.calls.length };
  }

  it('does not fast-path a short quote', async () => {
    const r = await judged('ai', 'we use ai daily', { supported: true, confidence: 0.9 });
    expect(r.calls).toBe(1);
  });

  it('does not fast-path a quote matching inside a word', async () => {
    const r = await judged('ai', 'we maintain things', { supported: false, confidence: 0.9 });
    expect(r.calls).toBe(1);
    expect(r.row.verified).toBe('unsupported');
  });

  it('fast-paths a six-word quote present in the page without the judge', async () => {
    const r = await judged('one two three four five six seven', 'x one two three four five six seven y', { supported: false, confidence: 1 });
    expect(r.calls).toBe(0);
    expect(r.row).toMatchObject({ verified: 'verified', confidence: 1 });
  });

  it('requires judge confidence >= 0.6', async () => {
    const low = await judged('short', 'page', { supported: true, confidence: 0.5 });
    expect(low.row).toMatchObject({ verified: 'unsupported', confidence: 0.5 });
    const ok = await judged('short', 'page', { supported: true, confidence: 0.6 });
    expect(ok.row.verified).toBe('verified');
  });

  it('marks a fetched page with almost no readable text unreachable without the judge (client-side rendered)', async () => {
    const { db, run, kase } = await setup();
    const [a, b] = await mk(db, kase.id, [
      { text: 'CallRail: Starting at $45/month', sourceUrl: 'https://empty.example', quote: null },
      { text: 'Most practices have no call tracking', sourceUrl: 'https://shell.example', quote: 'Most practices have no call tracking in place at all' },
    ]);
    const fetchPage = vi.fn(async (url: string) => page(url.includes('empty') ? '' : 'Loading... Please enable JavaScript to view this site.'));
    const router = fakeRouter({});
    await verify({ db, router, fetchPage, log: () => {} } as unknown as StageDeps, run, { caseIds: [kase.id] });
    expect(router.calls).toHaveLength(0);
    const rows = new Map((await db.select().from(claims).where(eq(claims.caseId, kase.id))).map((r) => [r.id, r]));
    expect(rows.get(a!.id)).toMatchObject({ verified: 'unreachable', confidence: null });
    expect(rows.get(b!.id)).toMatchObject({ verified: 'unreachable', confidence: null });
  });
});
