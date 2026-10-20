import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { landingPages, outreachDrafts, outreachEvents, prospects, suppressions, validationPacks } from '../../src/db/schema';
import type { CaseSections } from '../../src/case/schema';
import { defaultRunConfig } from '../../src/pipeline/types';
import { runValidation, type ValidationDeps } from '../../src/validation/run';
import { markOutreach } from '../../src/validation/outreach';
import type { LandingCopy } from '../../src/validation/schema';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';
import { fakeRouter, type FakeScript } from '../helpers/fake-router';

type Db = Awaited<ReturnType<typeof testDb>>;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const pack = () => ({
  mvpSpec: {
    summary: 'Detention packet builder',
    features: [
      { name: 'Upload', why: 'docs', manualAtFirst: false },
      { name: 'Packet', why: 'deliverable', manualAtFirst: true },
      { name: 'Email', why: 'deliver', manualAtFirst: true },
    ],
    architectureSketch: 'One app.', buildEstimate: { lowDays: 5, highDays: 12, assumptions: ['one engineer'] },
    fakeOrManualFirst: ['by hand'], risks: ['budget'], packaging: '$99/month',
  },
  pilotPlan: {
    idealPilotCustomer: 'A broker', firstStep: 'Agree the scope.', steps: ['a', 'b', 'c'],
    measures: [{ metric: 'm1', successThreshold: 't1' }, { metric: 'm2', successThreshold: 't2' }], timelineWeeks: 4, permissionsAndRisks: ['none'],
  },
  interviewKit: {
    targetRoles: ['Ops'], whereToFind: ['TIA'], opening: 'Hi',
    questions: Array.from({ length: 8 }, (_, i) => ({ question: `Q${i}?`, whyAsk: 'w', listenFor: 'l' })), redFlags: ['x'],
  },
  checklist: { gates: [{ id: 'sent', description: 'Send 2 emails', metricKey: 'emails_sent', threshold: 2 }] },
});

const landing = (): LandingCopy => ({
  headline: 'Win back detention', subhead: 's', whoItsFor: 'w', problem: 'p',
  howItWorks: [{ title: 'a', text: 'a' }, { title: 'b', text: 'b' }, { title: 'c', text: 'c' }],
  offer: 'o', faq: [{ q: 'q1', a: 'a1' }, { q: 'q2', a: 'a2' }, { q: 'q3', a: 'a3' }], ctaLabel: 'Join', metaDescription: 'm',
});

const research = () => ({
  text: 'Acme Freight (acme-freight.com) in Toronto and Northline Logistics (northline-logistics.ca) in Calgary.',
  sources: [{ url: 'https://acme-freight.com/' }, { url: 'https://northline-logistics.ca/' }],
});
const extract = () => ({
  prospects: [
    { name: 'Acme Freight', website: 'https://acme-freight.com/', location: 'Toronto, ON', country: 'CA', sizeNote: null, fitReason: 'broker', sourceUrls: [] },
    { name: 'Northline Logistics', website: 'https://northline-logistics.ca/', location: 'Calgary, AB', country: 'CA', sizeNote: null, fitReason: 'broker', sourceUrls: [] },
  ],
});
const drafts = () => ({
  cold: { subject: 'Detention claims', body: 'Hi, saw you broker loads in Toronto.' },
  followup1: { subject: 'Following up', body: 'Any thoughts?' },
  followup2: { subject: 'Last note', body: 'Closing the loop.' },
});

async function aCase(db: Db) {
  const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
  const idea = await insertIdea(db, run.id, { buyerType: 'freight broker' });
  return insertCase(db, idea.id, {
    slug: 'freight', title: 'Freight detention',
    sections: { summary: { oneLiner: 'Detention packets', buyer: 'brokers', problem: 'rejected claims' } } as unknown as CaseSections,
  });
}

/** Each prospect's homepage publishes one address on its own domain. */
const sitePages = () =>
  vi.fn(async (url: string) => {
    const host = new URL(url).hostname;
    return { ok: true, status: 200, finalUrl: url, title: host, text: '', html: `<p>Write to <a href="mailto:ops@${host}">ops@${host}</a></p>` };
  });

function setup(db: Db, script: FakeScript, fetchPage = sitePages()) {
  const router = fakeRouter(script);
  const logs: string[] = [];
  const outDir = mkdtempSync(join(tmpdir(), 'bcg-validate-'));
  dirs.push(outDir);
  const deps: ValidationDeps = { db, router, fetchPage: fetchPage as never, log: (m) => logs.push(m), outDir };
  return { router, logs, outDir, deps, fetchPage };
}

const counts = async (db: Db) => ({
  packs: (await db.select().from(validationPacks)).length,
  prospects: (await db.select().from(prospects)).length,
  drafts: (await db.select().from(outreachDrafts)).length,
  pages: (await db.select().from(landingPages)).length,
  events: (await db.select().from(outreachEvents)).length,
  suppressions: (await db.select().from(suppressions)).length,
});

describe('runValidation', () => {
  it('runs pack → prospects → emails → drafts → landing → export in order and writes the files', async () => {
    const db = await testDb();
    const kase = await aCase(db);
    const { router, outDir, deps } = setup(db, {
      structured: { pack: [pack()], extract: [extract()], outreach: [drafts(), drafts()], landing: [landing()] },
      research: { prospect: [research()] },
    });
    const r = await runValidation(deps, kase.id, { prospects: 10 });
    expect(r.exitCode).toBe(0);
    expect(r.steps.map((s) => [s.step, s.status])).toEqual([
      ['pack', 'ok'], ['prospects', 'ok'], ['emails', 'ok'], ['drafts', 'ok'], ['landing', 'ok'], ['export', 'ok'],
    ]);
    const stages = router.calls.map((c) => c.stage);
    expect(stages).toEqual(['pack', 'prospect', 'extract', 'outreach', 'outreach', 'landing']);
    expect(await counts(db)).toMatchObject({ packs: 1, prospects: 2, drafts: 6, pages: 1 });
    const rows = await db.select().from(prospects);
    expect(rows.every((p) => p.caslBasis === 'self_published' && p.email?.startsWith('ops@'))).toBe(true);
    for (const f of ['pack.md', 'prospects.csv', 'outreach.csv', 'outreach-drafts.md', join('landing', 'index.html')]) {
      expect(existsSync(join(outDir, 'freight', f)), f).toBe(true);
    }
    expect(r.export?.senderMissing).toEqual(['sender.name', 'sender.address', 'sender.contact']);
  });

  it('is idempotent on re-run: same row counts, no new pack/landing/draft calls, owner statuses and suppressions kept', async () => {
    const db = await testDb();
    const kase = await aCase(db);
    const script: FakeScript = {
      structured: { pack: [pack()], extract: [extract(), extract()], outreach: [drafts(), drafts()], landing: [landing()] },
      research: { prospect: [research(), research()] },
    };
    const { router, deps } = setup(db, script);
    await runValidation(deps, kase.id, {});
    const [acme, north] = await db.select().from(prospects).orderBy(prospects.name);
    await markOutreach(db, acme!.id, 'sent');
    await markOutreach(db, acme!.id, 'positive');
    await markOutreach(db, north!.email!, 'unsubscribe');
    const before = await counts(db);

    const r2 = await runValidation(deps, kase.id, {});
    expect(r2.exitCode).toBe(0);
    expect(await counts(db)).toEqual(before);
    expect(router.calls.map((c) => c.stage)).toEqual(['pack', 'prospect', 'extract', 'outreach', 'outreach', 'landing', 'prospect', 'extract']);
    expect(r2.steps.find((s) => s.step === 'pack')!.status).toBe('skipped');
    expect(r2.steps.find((s) => s.step === 'landing')!.status).toBe('skipped');
    const after = await db.select().from(prospects).orderBy(prospects.name);
    expect(after.map((p) => p.status)).toEqual(['positive', 'unsubscribed']);
    expect(after.map((p) => p.email)).toEqual([acme!.email, north!.email]);
  });

  it('--refresh regenerates the pack and landing page in the same rows', async () => {
    const db = await testDb();
    const kase = await aCase(db);
    const { deps } = setup(db, {
      structured: { pack: [pack(), pack()], landing: [landing(), { ...landing(), headline: 'Fresh' }] },
    });
    await runValidation(deps, kase.id, { skipProspects: true });
    const r = await runValidation(deps, kase.id, { skipProspects: true, refresh: true });
    expect(r.exitCode).toBe(0);
    const pages = await db.select().from(landingPages);
    expect(pages).toHaveLength(1);
    expect((pages[0]!.copy as LandingCopy).headline).toBe('Fresh');
    expect(await db.select().from(validationPacks)).toHaveLength(1);
  });

  it('0 prospects found is a warning, not a failure', async () => {
    const db = await testDb();
    const kase = await aCase(db);
    const { deps, logs } = setup(db, {
      structured: { pack: [pack()], extract: [{ prospects: [] }], landing: [landing()] },
      research: { prospect: [{ text: 'Nothing found.', sources: [] }] },
    });
    const r = await runValidation(deps, kase.id, {});
    expect(r.exitCode).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.steps.find((s) => s.step === 'prospects')).toMatchObject({ status: 'warning' });
    expect(r.steps.find((s) => s.step === 'landing')!.status).toBe('ok');
    expect(r.steps.find((s) => s.step === 'export')!.status).toBe('ok');
    expect(logs.join('\n')).toMatch(/0 prospects/i);
  });

  it('a prospect source failure exits non-zero but still makes the landing page and the export; earlier results stay saved', async () => {
    const db = await testDb();
    const kase = await aCase(db);
    const { deps, outDir } = setup(db, { structured: { pack: [pack()], landing: [landing()] } }); // no research scripted: throws
    const r = await runValidation(deps, kase.id, {});
    expect(r.exitCode).toBe(1);
    expect(r.steps.map((s) => [s.step, s.status])).toEqual([
      ['pack', 'ok'], ['prospects', 'failed'], ['emails', 'skipped'], ['drafts', 'skipped'], ['landing', 'ok'], ['export', 'ok'],
    ]);
    expect(await db.select().from(validationPacks)).toHaveLength(1);
    expect(existsSync(join(outDir, 'freight', 'landing', 'index.html'))).toBe(true);
  });

  it('a landing failure still runs the export, with a non-zero exit code', async () => {
    const db = await testDb();
    const kase = await aCase(db);
    const { deps, outDir } = setup(db, { structured: { pack: [pack()], landing: [{ nonsense: true }] } });
    const r = await runValidation(deps, kase.id, { skipProspects: true });
    expect(r.exitCode).toBe(1);
    expect(r.steps.map((s) => [s.step, s.status])).toEqual([
      ['pack', 'ok'], ['prospects', 'skipped'], ['emails', 'ok'], ['drafts', 'ok'], ['landing', 'failed'], ['export', 'ok'],
    ]);
    expect(existsSync(join(outDir, 'freight', 'pack.md'))).toBe(true);
    expect(existsSync(join(outDir, 'freight', 'landing', 'index.html'))).toBe(false);
  });

  it('a pack failure stops the run with a non-zero exit code', async () => {
    const db = await testDb();
    const kase = await aCase(db);
    const { deps, router } = setup(db, { structured: { pack: [{ nonsense: true }] } });
    const r = await runValidation(deps, kase.id, {});
    expect(r.exitCode).toBe(1);
    expect(r.steps.map((s) => [s.step, s.status])).toEqual([['pack', 'failed']]);
    expect(router.calls.map((c) => c.stage)).toEqual(['pack']);
  });

  it('--skip-prospects still finds emails for existing (e.g. imported) prospects and drafts them; places without a key is skipped', async () => {
    const db = await testDb();
    const kase = await aCase(db);
    await db.insert(prospects).values({
      caseId: kase.id, name: 'Imported Co', website: 'https://imported.com/', domain: 'imported.com', location: '', fitReason: '', source: 'csv',
    });
    const { deps } = setup(db, { structured: { pack: [pack()], outreach: [drafts()], landing: [landing()] } });
    const r = await runValidation(deps, kase.id, { skipProspects: true });
    expect(r.exitCode).toBe(0);
    expect(r.steps.find((s) => s.step === 'prospects')!.status).toBe('skipped');
    const [p] = await db.select().from(prospects).where(eq(prospects.domain, 'imported.com'));
    expect(p!.email).toBe('ops@imported.com');
    expect(await db.select().from(outreachDrafts)).toHaveLength(3);

    const db2 = await testDb();
    const k2 = await aCase(db2);
    const s2 = setup(db2, { structured: { pack: [pack()], landing: [landing()] } });
    const r2 = await runValidation(s2.deps, k2.id, { source: 'places' });
    expect(r2.exitCode).toBe(0);
    expect(r2.steps.find((s) => s.step === 'prospects')!.status).toBe('warning');
    expect(s2.logs.join('\n')).toMatch(/GOOGLE_PLACES_API_KEY/);
  });

  it('passes --pilot-site to the pack prompt and --include-weak to drafts and export', async () => {
    const db = await testDb();
    const kase = await aCase(db);
    await db.insert(prospects).values({
      caseId: kase.id, name: 'Weak Co', website: 'https://weak.com/', domain: 'weak.com', location: '', fitReason: '', source: 'csv',
      email: 'sales@weak.com', caslBasis: 'unknown',
    });
    const permissionPack = { ...pack(), pilotPlan: { ...pack().pilotPlan, firstStep: "Get the site owner's written permission and learn where leads land" } };
    const { deps, router, outDir } = setup(db, { structured: { pack: [permissionPack], outreach: [drafts()], landing: [landing()] } });
    const r = await runValidation(deps, kase.id, { skipProspects: true, includeWeak: true, pilotSite: 'https://pilot.example' });
    expect(r.exitCode).toBe(0);
    expect(router.calls[0]!.prompt).toContain('pilot.example');
    expect(readFileSync(join(outDir, 'freight', 'outreach.csv'), 'utf8')).toContain('sales@weak.com');
  });
});
