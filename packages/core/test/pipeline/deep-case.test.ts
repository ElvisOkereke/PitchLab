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
    expect(row.promptVersion).toBe('case-write.v2');
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

  it('stores one claim per evidence claim plus one per sourced number input', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await ideaWithSignal(db, run.id);
    const d = draft();
    await deepCase(deps(db, recordingRouter([d])), run, { passed: [idea.id], advisory: [] });

    const row = await caseFor(db, idea.id);
    const rows = await db.select().from(claims).where(eq(claims.caseId, row.id));
    expect(rows).toHaveLength(d.evidence.claims.length + 3);
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
    d.evidence.signals = [{ quote: 'Invented quote nobody said', url: 'https://made-up.example/x', sourceName: 'Nowhere' }];

    await deepCase(deps(db, recordingRouter([d])), run, { passed: [idea.id], advisory: [] });

    const row = await caseFor(db, idea.id);
    expect(row.sections.evidence.signals).toEqual([
      { quote: sig!.quote, url: sig!.url, sourceName: 'news.example' },
    ]);
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
    expect(Object.keys(json.properties)).toEqual(['title', 'summary', 'evidence', 'numbers', 'competitors', 'pitch']);
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
