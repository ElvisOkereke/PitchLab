import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { claims, pageFetches } from '../../src/db/schema';
import { COMPETITOR_REVIEW_NOTE, MIN_JUDGE_CONFIDENCE, REVIEW_CONFIDENCE_FLOOR, verify } from '../../src/pipeline/verify';
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

  async function judged(quote: string | null, pageText: string, verdict: { supported: boolean; confidence: number }, section = 'evidence') {
    const { db, run, kase } = await setup();
    const [a] = await db.insert(claims).values({ caseId: kase.id, section, text: 'claim text', sourceUrl: 'https://a.com', quote }).returning();
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

  it('requires judge confidence >= 0.6 to verify', async () => {
    const ok = await judged('short', 'page', { supported: true, confidence: 0.6 });
    expect(ok.row).toMatchObject({ verified: 'verified', reviewNote: null });
    const no = await judged('short', 'page', { supported: false, confidence: 0.6 });
    expect(no.row).toMatchObject({ verified: 'unsupported', reviewNote: null });
  });

  it('sends an unsure judgement (confidence in [0.3, 0.6)) to the owner as needs_review, whichever way it leans', async () => {
    expect(REVIEW_CONFIDENCE_FLOOR).toBe(0.3);
    expect(MIN_JUDGE_CONFIDENCE).toBe(0.6);
    const yes = await judged('short', 'page', { supported: true, confidence: 0.45 });
    expect(yes.row).toMatchObject({ verified: 'needs_review', confidence: 0.45, reviewNote: 'checker unsure (confidence 0.45)' });
    const no = await judged('short', 'page', { supported: false, confidence: 0.3 });
    expect(no.row).toMatchObject({ verified: 'needs_review', reviewNote: 'checker unsure (confidence 0.30)' });
    const edge = await judged('short', 'page', { supported: true, confidence: 0.59 });
    expect(edge.row.verified).toBe('needs_review');
  });

  it('marks a very low-confidence judgement (< 0.3) unsupported', async () => {
    const low = await judged('short', 'page', { supported: true, confidence: 0.29 });
    expect(low.row).toMatchObject({ verified: 'unsupported', confidence: 0.29, reviewNote: null });
  });

  describe('unconfirmable competitor claims go to the owner, not shown as failures', () => {
    it('turns a confident unsupported competitor verdict into needs_review with a note', async () => {
      expect(COMPETITOR_REVIEW_NOTE).toBe('the checker could not find this on the linked page — check it yourself');
      const r = await judged(null, 'page', { supported: false, confidence: 0.9 }, 'competitor');
      expect(r.row).toMatchObject({ verified: 'needs_review', confidence: 0.9, reviewNote: COMPETITOR_REVIEW_NOTE });
    });

    it('turns a very low-confidence competitor-pricing verdict into needs_review with the note', async () => {
      const r = await judged(null, 'page', { supported: true, confidence: 0.1 }, 'competitor-pricing');
      expect(r.row).toMatchObject({ verified: 'needs_review', confidence: 0.1, reviewNote: COMPETITOR_REVIEW_NOTE });
      const pricing = await judged(null, 'page', { supported: false, confidence: 0.95 }, 'competitor-pricing');
      expect(pricing.row).toMatchObject({ verified: 'needs_review', reviewNote: COMPETITOR_REVIEW_NOTE });
    });

    it('keeps unsupported for signal and evidence claims', async () => {
      for (const section of ['signal', 'evidence', 'numbers']) {
        const r = await judged(null, 'page', { supported: false, confidence: 0.9 }, section);
        expect(r.row).toMatchObject({ verified: 'unsupported', reviewNote: null });
      }
      const low = await judged(null, 'page', { supported: true, confidence: 0.1 }, 'signal');
      expect(low.row.verified).toBe('unsupported');
    });

    it('leaves the unsure band and verified competitor claims unchanged', async () => {
      const unsure = await judged(null, 'page', { supported: false, confidence: 0.45 }, 'competitor');
      expect(unsure.row).toMatchObject({ verified: 'needs_review', reviewNote: 'checker unsure (confidence 0.45)' });
      const ok = await judged(null, 'page', { supported: true, confidence: 0.9 }, 'competitor');
      expect(ok.row).toMatchObject({ verified: 'verified', reviewNote: null });
      const okPricing = await judged(null, 'page', { supported: true, confidence: 0.6 }, 'competitor-pricing');
      expect(okPricing.row).toMatchObject({ verified: 'verified', reviewNote: null });
    });

    it('still marks a competitor claim on a banned domain unsupported without judging', async () => {
      const { db, run, kase } = await setup();
      const [a] = await db.insert(claims).values({ caseId: kase.id, section: 'competitor', text: 'Acme', sourceUrl: 'https://www.reddit.com/r/x', quote: null }).returning();
      const router = fakeRouter({});
      await verify({ db, router, fetchPage: vi.fn(), log: () => {} } as unknown as StageDeps, run, { caseIds: [kase.id] });
      const [row] = await db.select().from(claims).where(eq(claims.id, a!.id));
      expect(row!.verified).toBe('unsupported');
      expect(router.calls).toHaveLength(0);
    });
  });

  it('gives an unreachable claim a note telling the owner to open the page', async () => {
    const { db, run, kase } = await setup();
    const [a, b] = await mk(db, kase.id, [
      { text: 'A', sourceUrl: 'https://down.example', quote: 'whatever' },
      { text: 'B', sourceUrl: 'https://empty.example', quote: null },
    ]);
    const fetchPage = vi.fn(async (url: string) => (url.includes('down') ? page('', false) : page('')));
    await verify({ db, router: fakeRouter({}), fetchPage, log: () => {} } as unknown as StageDeps, run, { caseIds: [kase.id] });
    const rows = new Map((await db.select().from(claims).where(eq(claims.caseId, kase.id))).map((r) => [r.id, r]));
    for (const id of [a!.id, b!.id]) {
      expect(rows.get(id)).toMatchObject({ verified: 'unreachable', reviewNote: 'page could not be loaded by the checker — open it yourself' });
    }
  });

  describe('GitHub issues via the API', () => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const ISSUE = 'https://github.com/acme/forms/issues/12';
    const QUOTE = 'Contact form submissions silently vanish after the update';

    const LONG_BODY = `We run forty client sites. ${QUOTE}. ${'Steps to reproduce: update the plugin, submit the form, wait. '.repeat(4)}`;

    it('verifies a quote in the issue body through the fast path, unauthenticated, without the page fetch or the judge', async () => {
      const { db, run, kase } = await setup();
      const [a] = await mk(db, kase.id, [{ text: 'A', sourceUrl: ISSUE, quote: QUOTE }, { text: 'A2', sourceUrl: ISSUE, quote: QUOTE }]);
      const githubFetch = vi.fn(async (url: string, _init?: RequestInit) =>
        url.includes('/comments') ? json([{ body: 'Same here.' }]) : json({ title: 'Forms broke on 6.4', body: LONG_BODY }));
      const fetchPage = vi.fn(async () => page('page chrome only'));
      const router = fakeRouter({});
      // A token present in deps must never be sent: the repo comes from untrusted case content.
      const deps = { db, router, fetchPage, githubToken: 'tok', log: () => {} } as unknown as StageDeps;
      await verify(deps, run, { caseIds: [kase.id] }, { githubFetch: githubFetch as unknown as typeof fetch });
      expect(fetchPage).not.toHaveBeenCalled();
      expect(router.calls).toHaveLength(0);
      expect(githubFetch).toHaveBeenCalledTimes(2); // issue + comments, once per url
      for (const [, init] of githubFetch.mock.calls) {
        expect(Object.keys(init!.headers as Record<string, string>).map((k) => k.toLowerCase())).not.toContain('authorization');
      }
      const [row] = await db.select().from(claims).where(eq(claims.id, a!.id));
      expect(row).toMatchObject({ verified: 'verified', confidence: 1 });
    });

    it('does not fast-path a quote found only in a comment: the judge decides, with the comments as context', async () => {
      const { db, run, kase } = await setup();
      const [a] = await mk(db, kase.id, [{ text: 'A', sourceUrl: ISSUE, quote: QUOTE }]);
      const body = 'Forms stopped after the update. '.repeat(8);
      const githubFetch = vi.fn(async (url: string, _init?: RequestInit) =>
        url.includes('/comments') ? json([{ body: `Same here. ${QUOTE}!` }]) : json({ title: 'Forms broke on 6.4', body }));
      const router = fakeRouter({ structured: { verify: [{ supported: true, confidence: 0.8 }] } });
      await verify({ db, router, fetchPage: vi.fn(), log: () => {} } as unknown as StageDeps, run, { caseIds: [kase.id] }, { githubFetch: githubFetch as unknown as typeof fetch });
      expect(router.calls).toHaveLength(1);
      expect(router.calls[0]!.prompt).toContain('Same here.');
      const [row] = await db.select().from(claims).where(eq(claims.id, a!.id));
      expect(row).toMatchObject({ verified: 'verified', confidence: 0.8 });
    });

    it('sends an issue with too little text to the owner without the judge', async () => {
      const { db, run, kase } = await setup();
      const [a] = await mk(db, kase.id, [{ text: 'Forms break after updates', sourceUrl: ISSUE, quote: 'Forms broke on 6.4' }]);
      const githubFetch = vi.fn(async (url: string, _init?: RequestInit) =>
        url.includes('/comments') ? json([{ body: '+1' }]) : json({ title: 'Forms broke on 6.4', body: 'Short.' }));
      const router = fakeRouter({});
      await verify({ db, router, fetchPage: vi.fn(), log: () => {} } as unknown as StageDeps, run, { caseIds: [kase.id] }, { githubFetch: githubFetch as unknown as typeof fetch });
      expect(router.calls).toHaveLength(0);
      const [row] = await db.select().from(claims).where(eq(claims.id, a!.id));
      expect(row).toMatchObject({ verified: 'needs_review', confidence: null, reviewNote: 'GitHub issue has too little text to check — open it yourself' });
    });

    it('falls back to the page fetch when the API refuses (403)', async () => {
      const { db, run, kase } = await setup();
      const [a] = await mk(db, kase.id, [{ text: 'A', sourceUrl: ISSUE, quote: QUOTE }]);
      const githubFetch = vi.fn(async () => json({ message: 'API rate limit exceeded' }, 403));
      const fetchPage = vi.fn(async () => page(`x ${QUOTE} y`));
      await verify({ db, router: fakeRouter({}), fetchPage, log: () => {} } as unknown as StageDeps, run, { caseIds: [kase.id] }, { githubFetch: githubFetch as unknown as typeof fetch });
      expect(githubFetch).toHaveBeenCalledTimes(1);
      expect(fetchPage).toHaveBeenCalledWith(ISSUE);
      const [row] = await db.select().from(claims).where(eq(claims.id, a!.id));
      expect(row).toMatchObject({ verified: 'verified', confidence: 1 });
    });

    it('leaves a non-GitHub url on the page path', async () => {
      const { db, run, kase } = await setup();
      await mk(db, kase.id, [{ text: 'A', sourceUrl: 'https://github.com/acme/forms', quote: QUOTE }, { text: 'B', sourceUrl: 'https://a.com/issues/1', quote: QUOTE }]);
      const githubFetch = vi.fn(async () => json({}));
      const fetchPage = vi.fn(async () => page(`x ${QUOTE} y`));
      await verify({ db, router: fakeRouter({}), fetchPage, log: () => {} } as unknown as StageDeps, run, { caseIds: [kase.id] }, { githubFetch: githubFetch as unknown as typeof fetch });
      expect(githubFetch).not.toHaveBeenCalled();
      expect(fetchPage).toHaveBeenCalledTimes(2);
    });
  });

  it('tells the judge what a competitor or competitor-pricing claim must show (verify-claim.v2)', async () => {
    const { db, run, kase } = await setup();
    await db.insert(claims).values([
      { caseId: kase.id, section: 'competitor', text: 'Acme Monitor', sourceUrl: 'https://acme.example', quote: null },
      { caseId: kase.id, section: 'competitor-pricing', text: 'Acme Monitor pricing: $49/mo', sourceUrl: 'https://acme.example', quote: null },
    ]);
    const router = fakeRouter({ structured: { verify: [{ supported: true, confidence: 0.9 }, { supported: true, confidence: 0.9 }] } });
    const text = `Acme Monitor watches your stack. Plans from $49/mo. ${'lorem ipsum dolor sit amet '.repeat(10)}`;
    await verify({ db, router, fetchPage: async () => page(text), log: () => {} } as unknown as StageDeps, run, { caseIds: [kase.id] });
    const prompts = router.calls.filter((c) => c.stage === 'verify').map((c) => c.prompt);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('Claim type: competitor\n');
    expect(prompts[1]).toContain('Claim type: competitor-pricing\n');
    expect(prompts[0]).toContain('is about the named product or company');
    expect(prompts[1]).toContain('shows that pricing');
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

  it('logs a fetch diagnostic per page and changes nothing else', async () => {
    const { db, run, kase } = await setup();
    await mk(db, kase.id, [
      { text: 'A', sourceUrl: 'https://a.com', quote: 'Small teams spend $40/hour on this manual task' },
      { text: 'C', sourceUrl: 'https://c.com', quote: 'whatever' },
    ]);
    const fetchPage = vi.fn(async (url: string) => (url.includes('c.com') ? page('', false) : page('Small teams spend $40/hour on this manual task')));
    const deps = { db, router: fakeRouter({}), fetchPage, log: () => {} } as unknown as StageDeps;
    await verify(deps, run, { caseIds: [kase.id] });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    for (const c of fetchPage.mock.calls) expect(c).toHaveLength(1);
    const rows = await db.select().from(pageFetches);
    expect(rows.map((r) => `${r.urlDomain}:${r.via}:${r.outcome}:${r.runId === run.id}`).sort()).toEqual(['a.com:direct:ok:true', 'c.com:direct:http_404:true']);
  });
});
