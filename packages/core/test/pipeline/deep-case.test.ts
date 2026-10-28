import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CaseDraftSchema, CaseSectionsSchema } from '../../src/case/schema';
import { cases, claims, gateVerdicts, ideas, signals } from '../../src/db/schema';
import { StructuredOutputError } from '../../src/llm/types';
import { deepCase, slugify } from '../../src/pipeline/deep-case';
import { defaultRunConfig, type StageDeps } from '../../src/pipeline/types';
import { insertIdea, insertRun, testDb } from '../helpers/db';
import { fakeRouter } from '../helpers/fake-router';

type Db = Awaited<ReturnType<typeof testDb>>;
type Draft = Record<string, any>;

const FIXTURE = new URL('../helpers/fixtures/case-draft.json', import.meta.url);
const draft = (): Draft => JSON.parse(readFileSync(FIXTURE, 'utf8'));
const research = {
  text: 'Agencies maintain about 40 sites each. "The median agency in our survey maintains 40 client websites on a monthly care plan."',
  sources: [{ url: 'https://agency-benchmarks.example/2026-small-agency-report', title: 'Small agency report' }],
};

/** Fake router that also records the full request objects passed to research/structured. */
function recordingRouter(drafts: Draft[]) {
  const router = fakeRouter({ research: { case: drafts.map(() => research) }, structured: { case: drafts } });
  const requests: { kind: 'research' | 'structured'; req: Record<string, unknown> }[] = [];
  const { research: r, structured: s } = router;
  router.research = (stage, req, ctx) => { requests.push({ kind: 'research', req }); return r(stage, req, ctx); };
  router.structured = (stage, req, ctx) => { requests.push({ kind: 'structured', req }); return s(stage, req, ctx); };
  return Object.assign(router, { requests });
}

const deps = (db: unknown, router: unknown) => ({ db, router, log: () => {} }) as unknown as StageDeps;

async function ideaWithSignal(db: Db, runId: string, origin: 'generated' | 'owner' = 'generated') {
  const [sig] = await db.insert(signals).values({
    marketId: 'ca-us', source: 'hn', url: `https://news.example/item/${Math.random()}`, title: 't',
    quote: 'Our forms die after plugin updates and nobody notices', quoteHash: `h${Math.random()}`,
  }).returning({ id: signals.id });
  return insertIdea(db, runId, {
    origin, title: 'Form checks', oneLiner: 'check forms', buyer: 'agencies', problem: 'silent form failures',
    solution: 'synthetic leads', signalIds: [sig!.id], status: 'advanced',
  });
}

async function caseFor(db: Db, ideaId: string) {
  const [row] = await db.select().from(cases).where(eq(cases.ideaId, ideaId));
  if (!row) throw new Error('no case');
  return row;
}

describe('deepCase', () => {
  it('writes a case whose numbers are computed by code', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open', maxSearchesPerCall: 4 }));
    const idea = await ideaWithSignal(db, run.id);
    const router = recordingRouter([draft()]);

    const out = await deepCase(deps(db, router), run, { passed: [idea.id], advisory: [] });

    const row = await caseFor(db, idea.id);
    expect(out.caseIds).toEqual([row.id]);
    expect(row.sections.numbers.results.buyer.annualPrice).toBe(3840);
    expect(row.sections.numbers.results.market.year1Revenue).toBe(115200);
    expect(row.slug).toBe('lead-flow-verification-for-web-agencies');
    expect(row.title).toBe('Lead-flow verification for web agencies');
    expect(row.stage).toBe('new');
    expect(row.gateAdvisory).toBe(false);
    expect(row.sections.summary.gateFlags).toEqual([]);
    expect(row.model).toBe('claude-opus-5-5');
    expect(row.promptVersion).toBe('case-write.v4');
    expect(row.updatedAt).toBeInstanceOf(Date);
    expect(CaseSectionsSchema.safeParse(row.sections).success).toBe(true);

    const [res, write] = router.requests;
    expect(res!.kind).toBe('research');
    expect(res!.req.maxSearches).toBe(8);
    expect(write!.kind).toBe('structured');
    expect(write!.req.maxTokens).toBe(16000);
    expect(write!.req.schema).toBe(CaseDraftSchema);
  });

  it('gives a second case with the same title a -2 slug', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const a = await ideaWithSignal(db, run.id);
    const b = await ideaWithSignal(db, run.id);
    const router = recordingRouter([draft(), draft()]);

    await deepCase(deps(db, router), run, { passed: [a.id, b.id], advisory: [] });

    expect((await caseFor(db, a.id)).slug).toBe('lead-flow-verification-for-web-agencies');
    expect((await caseFor(db, b.id)).slug).toBe('lead-flow-verification-for-web-agencies-2');
  });

  it('stores one claim per evidence claim, sourced number input, signal used and http(s) competitor', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await ideaWithSignal(db, run.id);
    const [sig] = await db.select().from(signals).where(eq(signals.id, idea.signalIds[0]!));
    const d = draft();
    d.usedSignalUrls = [sig!.url];
    d.competitors.list.push({ name: 'Offline agency', url: 'not a url', pricing: 'unknown', gap: 'manual' });
    await deepCase(deps(db, recordingRouter([d])), run, { passed: [idea.id], advisory: [] });

    const row = await caseFor(db, idea.id);
    expect(row.sections.competitors.list.map((c) => c.name)).not.toContain('Offline agency'); // non-http url: fails closed
    const rows = await db.select().from(claims).where(eq(claims.caseId, row.id));
    expect(rows).toHaveLength(d.evidence.claims.length + 3 + 1 + 2 + 2);
    expect(rows.filter((c) => c.section === 'signal').map(({ text, sourceUrl, quote }) => ({ text, sourceUrl, quote }))).toEqual([
      { text: sig!.quote, sourceUrl: sig!.url, quote: sig!.quote },
    ]);
    expect(rows.filter((c) => c.section === 'competitor').map(({ text, sourceUrl, quote }) => ({ text, sourceUrl, quote }))).toEqual([
      { text: 'Generic uptime monitor', sourceUrl: 'https://uptime-tool.example/pricing', quote: null },
      { text: 'Synthetic browser testing platform', sourceUrl: 'https://synthetic-tests.example/pricing', quote: null },
    ]);
    expect(rows.filter((c) => c.section === 'competitor-pricing').map(({ text, sourceUrl, quote }) => ({ text, sourceUrl, quote }))).toEqual([
      { text: 'Generic uptime monitor pricing: $15/month for 50 monitors', sourceUrl: 'https://uptime-tool.example/pricing', quote: null },
      { text: 'Synthetic browser testing platform pricing: From $99/month', sourceUrl: 'https://synthetic-tests.example/pricing', quote: null },
    ]);
    expect(rows.filter((c) => c.section === 'evidence').map((c) => c.text).sort())
      .toEqual(d.evidence.claims.map((c: { text: string }) => c.text).sort());
    const numbers = rows.filter((c) => c.section === 'numbers');
    expect(numbers.map((c) => c.text).sort()).toEqual([
      'price.unitsPerBuyer: 40',
      'problemCost[0].unitCost (lost leads from broken forms): 400',
      'reachableBuyers: 3000',
    ]);
    const reach = numbers.find((c) => c.text.startsWith('reachableBuyers'))!;
    expect(reach.sourceUrl).toBe(d.numbers.inputs.reachableBuyers.source.url);
    expect(reach.quote).toBe(d.numbers.inputs.reachableBuyers.source.quote);
    expect(rows.every((c) => c.verified === 'unverified')).toBe(true);
  });

  it('stores and verifies at most 15 signals (signalIds order) and 15 competitors per case', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const sigs = await db.insert(signals).values(Array.from({ length: 17 }, (_, i) => ({
      marketId: 'ca-us', source: 'hn', url: `https://news.example/cap/${i}`, title: 't', quote: `quote ${i}`, quoteHash: `cap${i}`,
    }))).returning({ id: signals.id, url: signals.url });
    const ordered = [...sigs].reverse();
    const idea = await insertIdea(db, run.id, { signalIds: ordered.map((s) => s.id), status: 'advanced' });
    const d = draft();
    d.usedSignalUrls = sigs.map((s) => s.url);
    d.competitors.list = Array.from({ length: 17 }, (_, i) => ({ name: `C${i}`, url: `https://c${i}.example/`, pricing: '$1', gap: 'g' }));
    await deepCase(deps(db, recordingRouter([d])), run, { passed: [idea.id], advisory: [] });

    const row = await caseFor(db, idea.id);
    expect(row.sections.evidence.signals).toHaveLength(15);
    expect(row.sections.competitors.list).toHaveLength(15);
    expect(row.sections.evidence.signals.map((s) => s.url)).toEqual(ordered.slice(0, 15).map((s) => s.url));
    const rows = await db.select().from(claims).where(eq(claims.caseId, row.id));
    expect(rows.filter((c) => c.section === 'signal').map((c) => c.sourceUrl).sort())
      .toEqual(ordered.slice(0, 15).map((s) => s.url).sort());
    expect(rows.filter((c) => c.section === 'competitor').map((c) => c.text).sort())
      .toEqual(d.competitors.list.slice(0, 15).map((c: { name: string }) => c.name).sort());
    expect(rows.filter((c) => c.section === 'competitor-pricing').map((c) => c.text).sort())
      .toEqual(d.competitors.list.slice(0, 15).map((c: { name: string }) => `${c.name} pricing: $1`).sort());
  });

  it('checks a competitor\'s product page always, and its pricing only when the case quotes a figure', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await ideaWithSignal(db, run.id);
    const d = draft();
    d.competitors.list = [
      { name: 'Hidden Co', url: 'https://hidden.example/', pricing: 'Not published', gap: 'g' },
      { name: 'Sales Co', url: 'https://sales.example/', pricing: 'Contact sales', gap: 'g' },
      { name: 'Priced Co', url: 'https://priced.example/', pricing: '$49/mo', gap: 'g' },
      { name: 'Seats Co', url: 'https://seats.example/', pricing: 'Contact sales for 10+ seats', gap: 'g' },
      { name: 'Free Co', url: 'https://free.example/', pricing: 'Free', gap: 'g' },
    ];
    await deepCase(deps(db, recordingRouter([d])), run, { passed: [idea.id], advisory: [] });

    const row = await caseFor(db, idea.id);
    const rows = await db.select().from(claims).where(eq(claims.caseId, row.id));
    const pick = (section: string) => rows.filter((c) => c.section === section).map(({ text, sourceUrl }) => ({ text, sourceUrl }));
    expect(pick('competitor')).toEqual([
      { text: 'Hidden Co', sourceUrl: 'https://hidden.example/' },
      { text: 'Sales Co', sourceUrl: 'https://sales.example/' },
      { text: 'Priced Co', sourceUrl: 'https://priced.example/' },
      { text: 'Seats Co', sourceUrl: 'https://seats.example/' },
      { text: 'Free Co', sourceUrl: 'https://free.example/' },
    ]);
    expect(pick('competitor-pricing')).toEqual([
      { text: 'Priced Co pricing: $49/mo', sourceUrl: 'https://priced.example/' },
      { text: 'Free Co pricing: Free', sourceUrl: 'https://free.example/' },
    ]);
  });

  it('stores a case with zero claims when everything is banned or unparseable', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await insertIdea(db, run.id, { signalIds: [], status: 'advanced' });
    const d = draft();
    for (const c of d.evidence.claims) c.sourceUrl = 'https://www.reddit.com/r/x/1';
    d.competitors.list = d.competitors.list.map((c: Record<string, string>) => ({ ...c, url: 'not a url' }));
    const ban = (o: any): void => {
      if (!o || typeof o !== 'object') return;
      if (o.source && typeof o.source.url === 'string') o.source.url = 'https://www.linkedin.com/x';
      Object.values(o).forEach(ban);
    };
    ban(d.numbers.inputs);
    await deepCase(deps(db, recordingRouter([d])), run, { passed: [idea.id], advisory: [] });
    const row = await caseFor(db, idea.id);
    expect(await db.select().from(claims).where(eq(claims.caseId, row.id))).toHaveLength(0);
    expect(row.sections.competitors.list).toHaveLength(0);
  });

  it('drops banned-domain claims and competitors, and turns banned number sources into assumptions', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await ideaWithSignal(db, run.id);
    const d = draft();
    d.evidence.claims[0].sourceUrl = 'https://www.reddit.com/r/webdev/comments/1';
    d.competitors.list[0].url = 'https://www.g2.com/products/uptime/reviews';
    d.numbers.inputs.reachableBuyers.source.url = 'https://www.linkedin.com/company/x';
    await deepCase(deps(db, recordingRouter([d])), run, { passed: [idea.id], advisory: [] });

    const row = await caseFor(db, idea.id);
    expect(row.sections.evidence.claims.map((c) => c.sourceUrl)).toEqual(d.evidence.claims.slice(1).map((c: { sourceUrl: string }) => c.sourceUrl));
    expect(row.sections.competitors.list.map((c) => c.name)).toEqual([d.competitors.list[1].name]);
    expect(row.sections.numbers.inputs.reachableBuyers).toEqual({ value: 3000, assumption: 'source removed: banned domain' });
    const rows = await db.select().from(claims).where(eq(claims.caseId, row.id));
    expect(rows.some((c) => /reddit|g2\.com|linkedin/.test(c.sourceUrl))).toBe(false);
    expect(rows.some((c) => c.text.startsWith('reachableBuyers'))).toBe(false);
  });

  it('drops a competitor and a claim on the never-fetch pilot site like any banned source (P3-R8)', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await ideaWithSignal(db, run.id);
    const d = draft();
    d.evidence.claims[0].sourceUrl = 'https://gamersgetaway.ca/about';
    d.competitors.list[0].url = 'https://www.gamersgetaway.ca/';
    await deepCase(deps(db, recordingRouter([d])), run, { passed: [idea.id], advisory: [] });

    const row = await caseFor(db, idea.id);
    expect(row.sections.competitors.list.map((c) => c.name)).toEqual([d.competitors.list[1].name]);
    expect(row.sections.evidence.claims.some((c) => c.sourceUrl.includes('gamersgetaway'))).toBe(false);
    const rows = await db.select().from(claims).where(eq(claims.caseId, row.id));
    expect(rows.some((c) => c.sourceUrl.includes('gamersgetaway'))).toBe(false);
  });

  it('flags an advisory idea with its failed gate checks', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'idea' }));
    const idea = await ideaWithSignal(db, run.id, 'owner');
    await deepCase(deps(db, recordingRouter([draft()])), run, {
      passed: [idea.id], advisory: [{ ideaId: idea.id, failedChecks: ['evidence'] }],
    });
    const row = await caseFor(db, idea.id);
    expect(row.sections.summary.gateFlags).toEqual(['evidence']);
    expect(row.gateAdvisory).toBe(true);
  });

  it('ignores results and gateFlags supplied by the model; code-computed values win', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await ideaWithSignal(db, run.id);
    const d = draft();
    d.numbers.results = { buyer: { annualPrice: 999999 }, formulas: ['made up'] };
    d.summary.gateFlags = ['fabricated'];

    await deepCase(deps(db, recordingRouter([d])), run, { passed: [idea.id], advisory: [] });

    const row = await caseFor(db, idea.id);
    expect(row.sections.numbers.results.buyer.annualPrice).toBe(3840);
    expect(row.sections.numbers.results.formulas).toContain('Annual price = $8 × 40 × 12 = $3,840');
    expect(row.sections.summary.gateFlags).toEqual([]);
    expect(Object.keys(row.sections.numbers).sort()).toEqual(['inputs', 'results']);
  });

  it('feeds signals, gate sources and market into research, and wraps the research for the writer', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await ideaWithSignal(db, run.id);
    await db.insert(gateVerdicts).values({
      ideaId: idea.id, check: 'generic', pass: true, reasoning: 'Acme only checks uptime',
      sources: ['https://acme.example/pricing'], model: 'gpt-6-sol', promptVersion: 'gate.v1',
    });
    const router = recordingRouter([draft()]);
    await deepCase(deps(db, router), run, { passed: [idea.id], advisory: [] });

    const [res, write] = router.calls;
    expect(res!.prompt).toContain('<idea>');
    expect(res!.prompt).toContain('Our forms die after plugin updates');
    expect(res!.prompt).toContain('https://acme.example/pricing');
    expect(res!.prompt).toContain('CA, US');
    expect(write!.prompt).toContain('<research>');
    expect(write!.prompt).toContain(research.text);
    expect(write!.prompt).toContain(research.sources[0]!.url);
    expect(write!.prompt).toContain('USD');
  });

  it('caps idea fields and shows failed gate checks to the writer', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'idea' }));
    const idea = await ideaWithSignal(db, run.id, 'owner');
    const longProblem = `${'x'.repeat(2000)}TAIL`;
    await db.update(ideas).set({ title: 'Form\nchecks', problem: longProblem }).where(eq(ideas.id, idea.id));
    await db.insert(gateVerdicts).values({
      ideaId: idea.id, check: 'regulation', pass: false, reasoning: 'Needs a licence in Quebec',
      sources: [], model: 'gpt-6-sol', promptVersion: 'gate.v1',
    });
    const router = recordingRouter([draft()]);
    await deepCase(deps(db, router), run, { passed: [idea.id], advisory: [{ ideaId: idea.id, failedChecks: ['regulation'] }] });

    const [res, write] = router.calls;
    expect(res!.prompt).toContain('Title: Form checks\n');
    expect(res!.prompt).toContain('x'.repeat(2000));
    expect(res!.prompt).not.toContain('TAIL');
    expect(write!.prompt).toContain('regulation (fail): Needs a licence in Quebec');
  });

  it('stores evidence signals from the real signal rows, never the model copy', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await ideaWithSignal(db, run.id);
    const [sig] = await db.select().from(signals).where(eq(signals.id, idea.signalIds[0]!));
    const d = draft();
    d.usedSignalUrls = [sig!.url];
    d.evidence.signals = [{ quote: 'Invented quote nobody said', url: 'https://made-up.example/x', sourceName: 'Nowhere' }];

    await deepCase(deps(db, recordingRouter([d])), run, { passed: [idea.id], advisory: [] });

    const row = await caseFor(db, idea.id);
    expect(row.sections.evidence.signals).toEqual([
      { quote: sig!.quote, url: sig!.url, sourceName: 'news.example' },
    ]);
  });

  it('stores each evidence signal\'s voice when the row has one (legacy rows carry no voice key)', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const sigs = await db.insert(signals).values([
      { marketId: 'ca-us', source: 'web', url: 'https://forum.example/t/1', title: 't', quote: 'op quote', quoteHash: 'vo1', voice: 'operator' as const },
      { marketId: 'ca-us', source: 'web', url: 'https://old.example/t/2', title: 't', quote: 'old quote', quoteHash: 'vo2' },
    ]).returning({ id: signals.id, url: signals.url });
    const idea = await insertIdea(db, run.id, { signalIds: sigs.map((s) => s.id), status: 'advanced' });
    const d = draft();
    d.usedSignalUrls = sigs.map((s) => s.url);
    await deepCase(deps(db, recordingRouter([d])), run, { passed: [idea.id], advisory: [] });
    const row = await caseFor(db, idea.id);
    expect(row.sections.evidence.signals).toEqual([
      { quote: 'op quote', url: 'https://forum.example/t/1', sourceName: 'forum.example', voice: 'operator' },
      { quote: 'old quote', url: 'https://old.example/t/2', sourceName: 'old.example' },
    ]);
    expect(CaseSectionsSchema.safeParse(row.sections).success).toBe(true);
  });

  it('stores only the signals the writer says it used, ignoring urls that were not provided', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const sigs = await db.insert(signals).values(['a', 'b', 'c'].map((k) => ({
      marketId: 'ca-us', source: 'hn', url: `https://news.example/used/${k}`, title: 't', quote: `quote ${k}`, quoteHash: `used${k}`,
    }))).returning({ id: signals.id, url: signals.url, quote: signals.quote });
    const [banned] = await db.insert(signals).values({
      marketId: 'ca-us', source: 'web', url: 'https://www.reddit.com/r/x/comments/1', title: 't', quote: 'banned quote', quoteHash: 'usedbanned',
    }).returning({ id: signals.id, url: signals.url });
    const idea = await insertIdea(db, run.id, { signalIds: [...sigs.map((s) => s.id), banned!.id], status: 'advanced' });
    const d = draft();
    d.usedSignalUrls = [sigs[2]!.url, 'https://invented.example/not-provided', banned!.url, sigs[0]!.url];
    const router = recordingRouter([d]);
    await deepCase(deps(db, router), run, { passed: [idea.id], advisory: [] });

    expect(router.calls[1]!.prompt).toContain('usedSignalUrls');
    const row = await caseFor(db, idea.id);
    expect(row.sections.evidence.signals.map((s) => s.url)).toEqual([sigs[0]!.url, sigs[2]!.url]);
    expect(row.sections).not.toHaveProperty('usedSignalUrls');
    const rows = await db.select().from(claims).where(eq(claims.caseId, row.id));
    expect(rows.filter((c) => c.section === 'signal').map((c) => c.sourceUrl).sort()).toEqual([sigs[0]!.url, sigs[2]!.url].sort());
  });

  it('logs how many provided signals the writer did not use, with the first few urls', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const sigs = await db.insert(signals).values(['a', 'b', 'c', 'd', 'e'].map((k) => ({
      marketId: 'ca-us', source: 'hn', url: `https://news.example/unused/${k}`, title: 't', quote: `quote ${k}`, quoteHash: `unused${k}`,
    }))).returning({ id: signals.id, url: signals.url });
    const idea = await insertIdea(db, run.id, { signalIds: sigs.map((s) => s.id), status: 'advanced' });
    const d = draft();
    d.usedSignalUrls = [sigs[1]!.url];
    const logs: string[] = [];
    await deepCase({ db, router: recordingRouter([d]), log: (m: string) => logs.push(m) } as unknown as StageDeps, run, { passed: [idea.id], advisory: [] });
    const line = logs.find((l) => l.includes('not used by the writer'));
    expect(line).toBeDefined();
    expect(line).toContain('4 of 5 provided signals not used by the writer');
    for (const k of ['a', 'c', 'd']) expect(line).toContain(`https://news.example/unused/${k}`);
    expect(line).not.toContain('https://news.example/unused/e');
    expect(line).not.toContain('https://news.example/unused/b');
  });

  it('stores no signals and no signal claims when the writer used none', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await ideaWithSignal(db, run.id);
    const d = draft();
    d.usedSignalUrls = [];
    await deepCase(deps(db, recordingRouter([d])), run, { passed: [idea.id], advisory: [] });
    const row = await caseFor(db, idea.id);
    expect(row.sections.evidence.signals).toEqual([]);
    const rows = await db.select().from(claims).where(eq(claims.caseId, row.id));
    expect(rows.filter((c) => c.section === 'signal')).toHaveLength(0);
  });

  it('every email and follow-up carries all four CASL placeholders', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await ideaWithSignal(db, run.id);
    await deepCase(deps(db, recordingRouter([draft()])), run, { passed: [idea.id], advisory: [] });

    const { pitch } = (await caseFor(db, idea.id)).sections;
    const bodies = [...pitch.emails, ...pitch.followUps].map((e) => e.body);
    expect(bodies).toHaveLength(5);
    for (const body of bodies) {
      for (const p of ['[Your name]', '[Mailing address]', '[Phone or website]', '[Unsubscribe line]']) {
        expect(body).toContain(p);
      }
    }
  });

  it('is idempotent: a re-run reuses the existing case without new LLM calls', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await ideaWithSignal(db, run.id);
    const first = await deepCase(deps(db, recordingRouter([draft()])), run, { passed: [idea.id], advisory: [] });
    const claimCount = (await db.select().from(claims)).length;

    const router = fakeRouter({});
    const second = await deepCase(deps(db, router), run, { passed: [idea.id], advisory: [] });

    expect(second.caseIds).toEqual(first.caseIds);
    expect(router.calls).toHaveLength(0);
    expect(await db.select().from(cases)).toHaveLength(1);
    expect((await db.select().from(claims)).length).toBe(claimCount);
  });

  it('propagates an invalid draft and stores nothing for that idea', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await ideaWithSignal(db, run.id);
    const d = draft();
    d.pitch.emails = d.pitch.emails.slice(0, 2);
    await expect(deepCase(deps(db, recordingRouter([d])), run, { passed: [idea.id], advisory: [] }))
      .rejects.toBeInstanceOf(StructuredOutputError);
    expect(await db.select().from(cases)).toHaveLength(0);
    expect(await db.select().from(claims)).toHaveLength(0);
  });

  it('makes no calls for empty input', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const router = fakeRouter({});
    expect(await deepCase(deps(db, router), run, { passed: [], advisory: [] })).toEqual({ caseIds: [] });
    expect(router.calls).toHaveLength(0);
  });
});

describe('CaseDraftSchema', () => {
  const fails = (mutate: (d: Draft) => void) => {
    const d = draft();
    mutate(d);
    return !CaseDraftSchema.safeParse(d).success;
  };

  it('accepts the fixture', () => {
    expect(CaseDraftSchema.safeParse(draft()).success).toBe(true);
  });

  it('converts to JSON Schema for the structured-output tool (R9)', () => {
    const json = z.toJSONSchema(CaseDraftSchema) as { type: string; properties: Record<string, unknown> };
    expect(json.type).toBe('object');
    expect(Object.keys(json.properties)).toEqual(['title', 'summary', 'evidence', 'usedSignalUrls', 'numbers', 'competitors', 'pitch']);
  });

  it('enforces the minimum structure', () => {
    expect(fails((d) => { d.evidence.claims = d.evidence.claims.slice(0, 2); })).toBe(true);
    expect(fails((d) => { d.competitors.levels = d.competitors.levels.slice(0, 1); })).toBe(true);
    expect(fails((d) => { d.pitch.emails.push(d.pitch.emails[0]); })).toBe(true);
    expect(fails((d) => { d.pitch.followUps = d.pitch.followUps.slice(0, 1); })).toBe(true);
    expect(fails((d) => { d.evidence.claims[0].quote = ''; })).toBe(true);
    expect(fails((d) => { delete d.numbers.inputs.reachableBuyers.source; })).toBe(true);
  });

  it('requires all four CASL placeholders in every email and follow-up body', () => {
    expect(fails((d) => { d.pitch.followUps[0].body = d.pitch.followUps[0].body.replace('[Phone or website]', ''); })).toBe(true);
    expect(fails((d) => { d.pitch.emails[2].body = d.pitch.emails[2].body.replace('[Unsubscribe line]', ''); })).toBe(true);
  });

  it('bounds usedSignalUrls: at most 30 urls of at most 2000 chars', () => {
    expect(fails((d) => { d.usedSignalUrls = Array.from({ length: 30 }, (_, i) => `https://x.example/${i}`); })).toBe(false);
    expect(fails((d) => { d.usedSignalUrls = Array.from({ length: 31 }, (_, i) => `https://x.example/${i}`); })).toBe(true);
    expect(fails((d) => { d.usedSignalUrls = [`https://x.example/${'a'.repeat(2000)}`]; })).toBe(true);
  });

  it('requires the headline price to match the price number input', () => {
    expect(fails((d) => { d.summary.price.amount = 9; })).toBe(true);
  });

  it('strips results, gateFlags and evidence signals', () => {
    const d = draft();
    d.numbers.results = { x: 1 };
    d.summary.gateFlags = ['x'];
    d.evidence.signals = [{ quote: 'q', url: 'u', sourceName: 's' }];
    const parsed = CaseDraftSchema.parse(d) as Draft;
    expect(parsed.numbers).not.toHaveProperty('results');
    expect(parsed.summary).not.toHaveProperty('gateFlags');
    expect(parsed.evidence).not.toHaveProperty('signals');
  });
});

describe('slugify', () => {
  it('kebab-cases and trims', () => {
    expect(slugify('  Lead-flow verification -- for Web Agencies!  ')).toBe('lead-flow-verification-for-web-agencies');
  });

  it('cuts to 60 chars without a trailing hyphen', () => {
    const slug = slugify('Automated reconciliation of freight broker invoices against carrier rate confirmations');
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug).toBe('automated-reconciliation-of-freight-broker-invoices-against');
  });

  it('falls back when the title has no letters or digits', () => {
    expect(slugify('!!!')).toBe('case');
  });
});

describe('deepCase business models', () => {
  it('flags "value below price" when the value multiple is under 1, and keeps the case', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await ideaWithSignal(db, run.id);
    const d = draft();
    d.numbers.inputs.valueToUserPerYear = { value: 100, assumption: 'Assumption: small saving' };
    await deepCase(deps(db, recordingRouter([d])), run, { passed: [idea.id], advisory: [] });
    const row = await caseFor(db, idea.id);
    expect(row.sections.numbers.results.buyer.valueMultiple).toBeLessThan(1);
    expect(row.sections.summary.gateFlags).toEqual(['value below price']);
    expect(row.gateAdvisory).toBe(true);
  });
  it('adds no flag at 1x or above', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await ideaWithSignal(db, run.id);
    const d = draft();
    d.numbers.inputs.valueToUserPerYear = { value: 100000, assumption: 'Assumption: big saving' };
    await deepCase(deps(db, recordingRouter([d])), run, { passed: [idea.id], advisory: [] });
    expect((await caseFor(db, idea.id)).sections.summary.gateFlags).toEqual([]);
  });
  it('tells the writer the business model, value and price hints, and stores idea facts on the summary', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await insertIdea(db, run.id, {
      title: 'Form checks', oneLiner: 'x', buyer: 'agencies', problem: 'p', solution: 's', status: 'advanced',
      audience: 'business', businessModel: 'usage', revenueMechanics: 'per check',
      valueToUser: { kind: 'save', amountPerYear: 5000, basis: 'saved leads' },
      priceHint: { amount: 2, unit: 'per check', basis: 'rival pricing' },
      barriers: { toStart: 2, toStartWhy: 'easy', toCopy: 3, toCopyWhy: 'ok', soloBuildable: true },
    });
    const router = recordingRouter([draft()]);
    await deepCase(deps(db, router), run, { passed: [idea.id], advisory: [] });
    const write = router.calls[1]!.prompt;
    expect(write).toContain('Business model: usage');
    expect(write).toContain('Value to the user');
    expect(write).toContain('Price hint');
    const row = await caseFor(db, idea.id);
    expect(row.promptVersion).toBe('case-write.v4');
    expect(row.sections.summary.businessModel).toBe('usage');
    expect(row.sections.summary.audience).toBe('business');
    expect(row.sections.summary.valueToUser?.amountPerYear).toBe(5000);
    expect(row.sections.summary.barriers?.soloBuildable).toBe(true);
  });
});

describe('deepCase writer model consistency', () => {
  it('draft schema rejects a businessModel that disagrees with the revenue block', () => {
    const d = draft();
    d.numbers.inputs.businessModel = 'usage';
    expect(CaseDraftSchema.safeParse(d).success).toBe(false);
    d.numbers.inputs.revenue = { model: 'usage', unitPrice: { value: 1, assumption: 'a' }, unitsPerBuyerPerYear: { value: 1, assumption: 'a' } };
    expect(CaseDraftSchema.safeParse(d).success).toBe(true);
    d.numbers.inputs.businessModel = 'subscription';
    expect(CaseDraftSchema.safeParse(d).success).toBe(false);
  });
  it('logs when the writer picked a different business model than the idea', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await insertIdea(db, run.id, { title: 't', oneLiner: 'x', buyer: 'b', problem: 'p', solution: 's', status: 'advanced', businessModel: 'usage' });
    const logs: string[] = [];
    await deepCase({ db, router: recordingRouter([draft()]), log: (m: string) => logs.push(m) } as unknown as StageDeps, run, { passed: [idea.id], advisory: [] });
    expect(logs.some((l) => l.includes('business model') && l.includes('usage') && l.includes('subscription'))).toBe(true);
  });
});
