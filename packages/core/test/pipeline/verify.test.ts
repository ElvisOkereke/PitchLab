import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { claims } from '../../src/db/schema';
import { verify } from '../../src/pipeline/verify';
import { defaultRunConfig, type StageDeps } from '../../src/pipeline/types';
import type { PageResult } from '../../src/tools/fetch-page';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';
import { fakeRouter } from '../helpers/fake-router';

const page = (text: string, ok = true): PageResult => ({ ok, status: ok ? 200 : 404, finalUrl: 'u', title: 't', text, ...(ok ? {} : { reason: 'http' as never }) });

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
      { text: 'A', sourceUrl: 'https://a.com', quote: 'Teams spend $40/hour on this' },
      { text: 'B', sourceUrl: 'https://b.com', quote: 'a quote that is absent' },
      { text: 'C', sourceUrl: 'https://c.com', quote: 'whatever' },
    ]);
    const fetchPage = vi.fn(async (url: string) =>
      url.includes('c.com') ? page('', false) : url.includes('a.com') ? page('Intro. TEAMS spend  $40 / hour, on this!! Outro') : page('Unrelated text'));
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
      { text: 'A', sourceUrl: 'https://a.com', quote: 'alpha beta' },
      { text: 'B', sourceUrl: 'https://a.com', quote: 'gamma delta' },
    ]);
    const fetchPage = vi.fn(async () => page('alpha beta gamma delta'));
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
});
