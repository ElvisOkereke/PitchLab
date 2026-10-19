import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { gateVerdicts, ideas, signals } from '../../src/db/schema';
import { StructuredOutputError } from '../../src/llm/router';
import { countEvidence, countEvidenceForSignals, gate } from '../../src/pipeline/gate';
import { defaultRunConfig, type StageDeps } from '../../src/pipeline/types';
import { getIdea, insertIdea, insertRun, testDb } from '../helpers/db';
import { fakeRouter } from '../helpers/fake-router';

const deps = (db: unknown, router: unknown) => ({ db, router, log: () => {} }) as unknown as StageDeps;

const CHECKS = ['generic', 'regulation', 'control', 'autonomy', 'reachability'] as const;
const verdicts = (omit?: string) => ({
  verdicts: CHECKS.filter((c) => c !== omit).map((check) => ({ check, pass: true, reasoning: `${check} ok`, sourceUrls: [] as string[] })),
});
const research = { text: 'Acme does this for $50/mo', sources: [{ url: 'https://acme.example/pricing', title: 'Acme' }] };

async function twoHostIdea(db: Awaited<ReturnType<typeof testDb>>, runId: string, origin: 'generated' | 'owner') {
  const urls = ['https://www.a.com/x', 'https://a.com/y', 'https://b.org/z'];
  const sigs = await db.insert(signals).values(urls.map((url, i) => ({
    marketId: 'ca-us', source: 'web', url, title: 't', quote: `q${i}`, quoteHash: `h${origin}${i}`, voice: 'operator' as const,
  }))).returning({ id: signals.id });
  return insertIdea(db, runId, { origin, signalIds: sigs.map((s) => s.id) });
}

describe('gate', () => {
  it('kills a generated idea with too few independent sources', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', minSignals: 3 }));
    const idea = await twoHostIdea(db, run.id, 'generated');
    const router = fakeRouter({ research: { competitors: [research] }, structured: { gate: [verdicts()] } });
    const out = await gate(deps(db, router), run, { ideaIds: [idea.id] });
    expect(out).toEqual({ passed: [], advisory: [] });
    expect((await getIdea(db, idea.id)).status).toBe('gated_out');
    const rows = await db.select().from(gateVerdicts).where(eq(gateVerdicts.ideaId, idea.id));
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.model === 'gpt-6-sol')).toHaveLength(5);
    const ev = rows.find((r) => r.check === 'evidence')!;
    expect(ev.pass).toBe(false);
    expect(ev.model).toBe('rule');
    expect(ev.reasoning).toBe('2 independent sources: a.com, b.org');
  });

  it('keeps an owner idea advanced and flags it as advisory', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'idea', minSignals: 3 }));
    const idea = await twoHostIdea(db, run.id, 'owner');
    await db.update(ideas).set({ status: 'advanced' }).where(eq(ideas.id, idea.id));
    const router = fakeRouter({ research: { competitors: [research] }, structured: { gate: [verdicts()] } });
    const out = await gate(deps(db, router), run, { ideaIds: [idea.id] });
    expect(out.passed).toEqual([idea.id]);
    expect(out.advisory).toEqual([{ ideaId: idea.id, failedChecks: ['evidence'] }]);
    expect((await getIdea(db, idea.id)).status).toBe('advanced');
  });

  it('resets a previously gated-out idea to advanced when a re-run passes every check', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', minSignals: 1 }));
    const idea = await twoHostIdea(db, run.id, 'generated');
    await db.update(ideas).set({ status: 'gated_out' }).where(eq(ideas.id, idea.id));
    const router = fakeRouter({ research: { competitors: [research] }, structured: { gate: [verdicts()] } });
    const out = await gate(deps(db, router), run, { ideaIds: [idea.id] });
    expect(out.passed).toEqual([idea.id]);
    expect((await getIdea(db, idea.id)).status).toBe('advanced');
  });

  it('caps idea fields and collapses newlines before they reach the prompts', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', minSignals: 1 }));
    const idea = await insertIdea(db, run.id, { title: 'Line one\nLine two', problem: `${'p'.repeat(2000)}TAIL` });
    const router = fakeRouter({ research: { competitors: [research] }, structured: { gate: [verdicts()] } });
    await gate(deps(db, router), run, { ideaIds: [idea.id] });
    for (const { prompt } of router.calls) {
      expect(prompt).toContain('Title: Line one Line two\n');
      expect(prompt).toContain('p'.repeat(2000));
      expect(prompt).not.toContain('TAIL');
    }
  });

  it('tells the competitor researcher never to cite banned domains', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', minSignals: 1 }));
    const idea = await twoHostIdea(db, run.id, 'generated');
    const router = fakeRouter({ research: { competitors: [research] }, structured: { gate: [verdicts()] } });
    await gate(deps(db, router), run, { ideaIds: [idea.id] });
    const prompt = router.calls.find((c) => c.kind === 'research')!.prompt;
    expect(prompt).toContain('capterra.com');
    expect(prompt).toContain('g2.com');
  });

  it('propagates StructuredOutputError when the judge omits a check', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await insertIdea(db, run.id);
    const router = fakeRouter({ research: { competitors: [research] }, structured: { gate: [verdicts('autonomy')] } });
    await expect(gate(deps(db, router), run, { ideaIds: [idea.id] })).rejects.toBeInstanceOf(StructuredOutputError);
  });

  it('is idempotent: running twice leaves exactly 6 verdict rows', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', minSignals: 1 }));
    const idea = await twoHostIdea(db, run.id, 'generated');
    const router = fakeRouter({ research: { competitors: [research, research] }, structured: { gate: [verdicts(), verdicts()] } });
    await gate(deps(db, router), run, { ideaIds: [idea.id] });
    await gate(deps(db, router), run, { ideaIds: [idea.id] });
    const rows = await db.select().from(gateVerdicts).where(eq(gateVerdicts.ideaId, idea.id));
    expect(rows).toHaveLength(6);
  });

  it('excludes IP and dotless hosts from independent sources', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', minSignals: 1 }));
    const urls = ['http://1.2.3.4/x', 'http://localhost/y', 'http://[::1]/z', 'https://www.example.com/b'];
    const sigs = await db.insert(signals).values(urls.map((url, i) => ({
      marketId: 'ca-us', source: 'web', url, title: 't', quote: `q${i}`, quoteHash: `hip${i}`, voice: 'operator' as const,
    }))).returning({ id: signals.id });
    const idea = await insertIdea(db, run.id, { signalIds: sigs.map((s) => s.id) });
    const router = fakeRouter({ research: { competitors: [research] }, structured: { gate: [verdicts()] } });
    await gate(deps(db, router), run, { ideaIds: [idea.id] });
    const ev = (await db.select().from(gateVerdicts).where(eq(gateVerdicts.ideaId, idea.id))).find((r) => r.check === 'evidence')!;
    expect(ev.reasoning).toBe('1 independent sources: example.com');
  });

  it('counts independent sources by registrable domain and excludes bad urls', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', minSignals: 1 }));
    const urls = ['https://news.example.com/a', 'https://www.example.com/b', 'not a url', 'ftp://x.com/f'];
    const sigs = await db.insert(signals).values(urls.map((url, i) => ({
      marketId: 'ca-us', source: 'web', url, title: 't', quote: `q${i}`, quoteHash: `hd${i}`, voice: 'neutral' as const,
    }))).returning({ id: signals.id });
    const idea = await insertIdea(db, run.id, { signalIds: sigs.map((s) => s.id) });
    const router = fakeRouter({ research: { competitors: [research] }, structured: { gate: [verdicts()] } });
    await gate(deps(db, router), run, { ideaIds: [idea.id] });
    const ev = (await db.select().from(gateVerdicts).where(eq(gateVerdicts.ideaId, idea.id))).find((r) => r.check === 'evidence')!;
    expect(ev.reasoning).toBe('1 independent sources: example.com');
  });

  it('makes no LLM calls for empty input', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const router = fakeRouter({});
    expect(await gate(deps(db, router), run, { ideaIds: [] })).toEqual({ passed: [], advisory: [] });
    expect(router.calls).toHaveLength(0);
  });

  it('loads gate.v2, whose generic check judges the claimed functional gap and incumbents', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', minSignals: 1 }));
    const idea = await insertIdea(db, run.id, { knownIncumbents: ['Cass', 'nVision'], functionalGap: 'Neither audits accessorial fees' });
    const router = fakeRouter({ research: { competitors: [research] }, structured: { gate: [verdicts()] } });
    await gate(deps(db, router), run, { ideaIds: [idea.id] });
    const rows = await db.select().from(gateVerdicts).where(eq(gateVerdicts.ideaId, idea.id));
    expect(rows.filter((r) => r.model !== 'rule').every((r) => r.promptVersion === 'gate.v2')).toBe(true);
    const judge = router.calls.find((c) => c.stage === 'gate')!.prompt;
    expect(judge).toContain(
      'The idea claims the functional gap and incumbents shown in its description. Mark `generic` as failed when the competitor research ' +
        'shows an incumbent already provides that function, or when the claimed gap is only about who buys the product or how it is sold ' +
        '(a positioning, packaging or channel difference). Pass `generic` only when the research shows a real functional gap or no incumbent serving this function.',
    );
    expect(judge).toContain('If the idea claims no functional gap, judge `generic` on the competitor research alone.');
    expect(judge).toContain(
      'The "Known incumbents" and "Functional gap" lines in the idea are the idea\'s own unverified claims: check them against the ' +
        'competitor research and never accept them as fact.',
    );
    for (const { prompt } of router.calls) {
      expect(prompt).toContain(
        "Known incumbents (the idea's own unverified claim): Cass; nVision\nFunctional gap (the idea's own unverified claim): Neither audits accessorial fees",
      );
    }
  });

  it('judges an owner idea without a claimed gap as before (no incumbent or gap lines)', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'idea', minSignals: 1 }));
    const idea = await twoHostIdea(db, run.id, 'owner');
    const router = fakeRouter({ research: { competitors: [research] }, structured: { gate: [verdicts()] } });
    const out = await gate(deps(db, router), run, { ideaIds: [idea.id] });
    expect(out).toEqual({ passed: [idea.id], advisory: [] });
    for (const { prompt } of router.calls) {
      expect(prompt).not.toContain('Known incumbents:');
      expect(prompt).not.toContain('Functional gap:');
    }
  });

  describe('evidence by voice: only operator and neutral signals count (vendor and untagged fail closed)', () => {
    async function evidenceOf(sigs: { url: string; voice: 'operator' | 'neutral' | 'vendor' | null }[], minSignals = 3) {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', minSignals }));
      const rows = await db.insert(signals).values(sigs.map((s, i) => ({
        marketId: 'ca-us', source: 'web', url: s.url, title: 't', quote: `q${i}`, quoteHash: `hv${i}`, voice: s.voice,
      }))).returning({ id: signals.id });
      const idea = await insertIdea(db, run.id, { signalIds: rows.map((s) => s.id) });
      const router = fakeRouter({ research: { competitors: [research] }, structured: { gate: [verdicts()] } });
      await gate(deps(db, router), run, { ideaIds: [idea.id] });
      return (await db.select().from(gateVerdicts).where(eq(gateVerdicts.ideaId, idea.id))).find((r) => r.check === 'evidence')!;
    }

    it('5 vendor-only signals count as 0 units', async () => {
      const ev = await evidenceOf(['a', 'b', 'c', 'd', 'e'].map((d) => ({ url: `https://${d}.com/blog`, voice: 'vendor' as const })));
      expect(ev.pass).toBe(false);
      expect(ev.reasoning).toBe('0 independent sources; excluded 5 vendor');
      expect(ev.sources).toEqual([]);
    });

    it('3 untagged (legacy) signals count as 0 units', async () => {
      const ev = await evidenceOf(['a', 'b', 'c'].map((d) => ({ url: `https://${d}.com/1`, voice: null })));
      expect(ev.pass).toBe(false);
      expect(ev.reasoning).toBe('0 independent sources; excluded 3 untagged');
    });

    it('counts operator and neutral signals', async () => {
      const ev = await evidenceOf([
        { url: 'https://a.com/1', voice: 'operator' }, { url: 'https://b.com/1', voice: 'neutral' }, { url: 'https://c.com/1', voice: 'operator' },
      ]);
      expect(ev.pass).toBe(true);
      expect(ev.reasoning).toBe('3 independent sources: a.com, b.com, c.com');
      expect(ev.promptVersion).toBe('evidence-rule.v2');
    });

    it('lists the excluded vendor and untagged sources in the reasoning and keeps them out of the verdict sources', async () => {
      const ev = await evidenceOf([
        { url: 'https://a.com/1', voice: 'operator' },
        { url: 'https://vendor-one.com/case-study', voice: 'vendor' },
        { url: 'https://b.com/1', voice: 'neutral' },
        { url: 'https://vendor-two.com/pricing', voice: 'vendor' },
        { url: 'https://c.com/1', voice: 'operator' },
        { url: 'https://old.com/1', voice: null },
      ]);
      expect(ev.pass).toBe(true);
      expect(ev.reasoning).toBe('3 independent sources: a.com, b.com, c.com; excluded 2 vendor, 1 untagged');
      expect(ev.sources).toEqual(['https://a.com/1', 'https://b.com/1', 'https://c.com/1']);
    });

    it('a vendor page on the same domain as an operator post does not add or remove a unit', async () => {
      const ev = await evidenceOf([{ url: 'https://a.com/forum/1', voice: 'operator' }, { url: 'https://a.com/shop', voice: 'vendor' }], 1);
      expect(ev.reasoning).toBe('1 independent sources: a.com; excluded 1 vendor');
    });

    it('countEvidenceForSignals keeps operator and neutral only and delegates to countEvidence', () => {
      const rows = [
        { url: 'https://a.com/1', voice: 'operator' as const }, { url: 'https://v.com/1', voice: 'vendor' as const },
        { url: 'https://b.com/1', voice: 'neutral' as const }, { url: 'https://u.com/1', voice: null },
      ];
      expect(countEvidenceForSignals(rows)).toEqual({
        ...countEvidence(['https://a.com/1', 'https://b.com/1']), counted: ['https://a.com/1', 'https://b.com/1'], excludedVendor: 1, excludedUntagged: 1,
      });
    });
  });

  describe('hybrid evidence counting', () => {
    const HN = (n: number | string, frag = '') => `https://news.ycombinator.com/item?id=${n}${frag}`;
    async function evidence(urls: string[], minSignals = 3) {
      const db = await testDb();
      const run = await insertRun(db, defaultRunConfig({ seedType: 'open', minSignals }));
      const sigs = await db.insert(signals).values(urls.map((url, i) => ({
        marketId: 'ca-us', source: 'web', url, title: 't', quote: `q${i}`, quoteHash: `hh${i}`, voice: 'operator' as const,
      }))).returning({ id: signals.id });
      const idea = await insertIdea(db, run.id, { signalIds: sigs.map((s) => s.id) });
      const router = fakeRouter({ research: { competitors: [research] }, structured: { gate: [verdicts()] } });
      await gate(deps(db, router), run, { ideaIds: [idea.id] });
      return (await db.select().from(gateVerdicts).where(eq(gateVerdicts.ideaId, idea.id))).find((r) => r.check === 'evidence')!;
    }

    it('caps a community platform at 2 threads', async () => {
      const ev = await evidence([1, 2, 3, 4, 5].map((n) => HN(n)));
      expect(ev.pass).toBe(false);
      expect(ev.reasoning).toBe('2 independent sources: ycombinator.com ×2 threads');
    });
    it('counts 2 HN threads + 1 GitHub issue as 3 units', async () => {
      const ev = await evidence([HN(1), HN(2), 'https://github.com/o/r/issues/9']);
      expect(ev.pass).toBe(true);
      expect(ev.reasoning).toBe('3 independent sources: ycombinator.com ×2 threads, github.com');
    });
    it('treats fragments as the same thread but keeps the query string', async () => {
      const ev = await evidence([HN(1, '#a'), HN(1, '#b'), HN(1)]);
      expect(ev.reasoning).toBe('1 independent sources: ycombinator.com');
    });
    it('normalises scheme and trailing slash in thread keys', async () => {
      const ev = await evidence(['https://github.com/o/r/issues/9', 'http://github.com/o/r/issues/9/', 'https://github.com/o/r/issues/9#c1']);
      expect(ev.reasoning).toBe('1 independent sources: github.com');
    });
    it('counts 3 distinct non-community domains as 3', async () => {
      const ev = await evidence(['https://a.com/1', 'https://b.com/1', 'https://c.com/1']);
      expect(ev.pass).toBe(true);
      expect(ev.reasoning).toBe('3 independent sources: a.com, b.com, c.com');
    });
    it('counts a non-community domain once even with many pages', async () => {
      const ev = await evidence(['https://a.com/1', 'https://a.com/2', 'https://a.com/3']);
      expect(ev.reasoning).toBe('1 independent sources: a.com');
    });
    it('excludes banned urls', async () => {
      const ev = await evidence(['https://www.reddit.com/r/x/1', 'https://a.com/1'], 1);
      expect(ev.reasoning).toBe('1 independent sources: a.com');
    });
  });
});
