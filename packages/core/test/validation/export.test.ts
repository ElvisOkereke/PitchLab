import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { landingEvents, landingPages, outreachDrafts, prospects, suppressions, validationPacks } from '../../src/db/schema';
import type { CaseSections } from '../../src/case/schema';
import { defaultRunConfig } from '../../src/pipeline/types';
import { setSetting } from '../../src/validation/settings';
import { computeChecklistStatus } from '../../src/validation/checklist';
import { csvCell, csvRows, exportValidation } from '../../src/validation/export';
import { UNSUBSCRIBE_LINE, markOutreach } from '../../src/validation/outreach';
import { ChecklistSchema, type LandingCopy, type PackDocs } from '../../src/validation/schema';
import { insertCase, insertIdea, insertRun, testDb } from '../helpers/db';

type Db = Awaited<ReturnType<typeof testDb>>;
type ProspectInsert = typeof prospects.$inferInsert;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'bcg-export-'));
  dirs.push(d);
  return d;
};

function pack(over: { summary?: string; gates?: PackDocs['checklist']['gates'] } = {}): PackDocs {
  return {
    mvpSpec: {
      summary: over.summary ?? 'A detention packet builder',
      features: [
        { name: 'Upload', why: 'get docs', manualAtFirst: false },
        { name: 'Packet', why: 'deliverable', manualAtFirst: true },
        { name: 'Email', why: 'deliver', manualAtFirst: true },
      ],
      architectureSketch: 'One app.',
      buildEstimate: { lowDays: 5, highDays: 12, assumptions: ['one engineer'] },
      fakeOrManualFirst: ['assemble by hand'],
      risks: ['no budget'],
      packaging: '$99/month',
    },
    pilotPlan: {
      idealPilotCustomer: 'A mid-size broker', firstStep: 'Agree the scope.', steps: ['a', 'b', 'c'],
      measures: [{ metric: 'm1', successThreshold: 't1' }, { metric: 'm2', successThreshold: 't2' }], timelineWeeks: 4,
      permissionsAndRisks: ['Written permission first'],
    },
    interviewKit: {
      targetRoles: ['Ops manager'], whereToFind: ['TIA'], opening: 'Hi',
      questions: Array.from({ length: 8 }, (_, i) => ({ question: `Q${i}?`, whyAsk: 'w', listenFor: 'l' })), redFlags: ['none'],
    },
    checklist: {
      gates: over.gates ?? [
        { id: 'sent', description: 'Send 3 emails', metricKey: 'emails_sent', threshold: 3 },
        { id: 'positive', description: '1 positive reply', metricKey: 'positive_replies', threshold: 1 },
        { id: 'meetings', description: '1 meeting', metricKey: 'meetings', threshold: 1 },
        { id: 'interviews', description: '2 interviews', metricKey: 'interviews_done', threshold: 2 },
        { id: 'landing', description: '5% conversion', metricKey: 'landing_conversion_pct', threshold: 5 },
      ],
    },
  };
}

const landingCopy: LandingCopy = {
  headline: 'Win back detention', subhead: 's', whoItsFor: 'w', problem: 'p',
  howItWorks: [{ title: 'a', text: 'a' }, { title: 'b', text: 'b' }, { title: 'c', text: 'c' }],
  offer: 'o', faq: [{ q: 'q1', a: 'a1' }, { q: 'q2', a: 'a2' }, { q: 'q3', a: 'a3' }], ctaLabel: 'Join', metaDescription: 'm',
};

async function aCase(db: Db, slug = 'freight', sections?: PackDocs) {
  const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
  const idea = await insertIdea(db, run.id);
  const kase = await insertCase(db, idea.id, { slug, title: 'Freight <b>detention</b>', sections: { summary: {} } as unknown as CaseSections });
  if (sections) await db.insert(validationPacks).values({ caseId: kase.id, sections, model: 'claude-opus-5-5', promptVersion: 'pack-docs.v1' });
  return kase;
}

let n = 0;
async function aProspect(db: Db, caseId: string, over: Partial<ProspectInsert> = {}) {
  n++;
  const [row] = await db.insert(prospects).values({
    caseId, name: `Broker ${n}`, website: `https://broker${n}.com/`, domain: `broker${n}.com`, location: 'Toronto, ON',
    fitReason: 'fits', email: `ops@broker${n}.com`, emailSourceUrl: `https://broker${n}.com/contact`,
    emailCapturedAt: new Date('2026-10-19T12:00:00Z'), caslBasis: 'self_published', source: 'web_research', ...over,
  }).returning();
  return row!;
}

async function addDrafts(db: Db, prospectId: string, body = 'Hello there.\n\n-- \n[SET SENDER NAME]\n[SET SENDER ADDRESS]\n[SET SENDER CONTACT]\n' + UNSUBSCRIBE_LINE) {
  for (const kind of ['cold', 'followup1', 'followup2'] as const) {
    await db.insert(outreachDrafts).values({ prospectId, kind, subject: `${kind} subject`, body, model: 'm', promptVersion: 'outreach.v1' });
  }
}

/** Minimal RFC 4180 reader for assertions. */
function readCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\r' && s[i + 1] === '\n') { row.push(f); rows.push(row); row = []; f = ''; i++; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}

describe('csvCell', () => {
  it('quotes every cell, doubles quotes, keeps newlines inside quotes, and defuses formula starts', () => {
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('a\nb')).toBe('"a\nb"');
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    for (const s of ['+1', '-2', '@SUM(A1)', '\tx', '\rx']) expect(csvCell(s).startsWith(`"'`), JSON.stringify(s)).toBe(true);
    expect(csvCell(null)).toBe('""');
    // P3-R16: invisible characters are stripped first, so they cannot hide a formula start.
    expect(csvCell('​=cmd()')).toBe(`"'=cmd()"`);
    expect(csvCell('a‮b‍c')).toBe('"abc"');
    expect(csvCell('line1\r\nline2')).toBe('"line1\nline2"');
    expect(csvRows([['a', 'b'], ['c', 'd']])).toBe('﻿"a","b"\r\n"c","d"\r\n');
  });
});

describe('ChecklistSchema thresholds (P3-R16)', () => {
  it('must be positive; a landing conversion is at most 100', () => {
    const gate = { id: 'g', description: 'd', metricKey: 'emails_sent' as const, threshold: 5 };
    expect(ChecklistSchema.safeParse({ gates: [gate] }).success).toBe(true);
    expect(ChecklistSchema.safeParse({ gates: [{ ...gate, threshold: 0 }] }).success).toBe(false);
    expect(ChecklistSchema.safeParse({ gates: [{ ...gate, threshold: -3 }] }).success).toBe(false);
    const conv = { ...gate, metricKey: 'landing_conversion_pct' as const };
    expect(ChecklistSchema.safeParse({ gates: [{ ...conv, threshold: 100 }] }).success).toBe(true);
    expect(ChecklistSchema.safeParse({ gates: [{ ...conv, threshold: 101 }] }).success).toBe(false);
    expect(ChecklistSchema.safeParse({ gates: [{ ...gate, threshold: 500 }] }).success).toBe(true);
  });
});

describe('computeChecklistStatus', () => {
  it('computes each metric from tracked events and landing data', async () => {
    const db = await testDb();
    const kase = await aCase(db, 'freight', pack());
    const p1 = await aProspect(db, kase.id);
    const p2 = await aProspect(db, kase.id);
    const p3 = await aProspect(db, kase.id);
    for (const p of [p1, p2, p3]) await markOutreach(db, p.id, 'sent');
    await markOutreach(db, p1.id, 'sent'); // a second send to the same prospect counts once
    await markOutreach(db, p1.id, 'positive');
    await markOutreach(db, p1.id, 'note', 'interview: ops manager, 30 min');
    await markOutreach(db, p2.id, 'note', 'Interview: dispatcher');
    await markOutreach(db, p3.id, 'note', 'left a voicemail');
    const other = await aCase(db, 'other');
    await markOutreach(db, (await aProspect(db, other.id)).id, 'meeting'); // another case's events never count

    let status = await computeChecklistStatus(db, kase.id);
    const by = (id: string) => status.find((g) => g.id === id)!;
    expect(by('sent')).toMatchObject({ value: 3, threshold: 3, state: 'pass', description: 'Send 3 emails' });
    expect(by('positive')).toMatchObject({ value: 1, state: 'pass' });
    expect(by('meetings')).toMatchObject({ value: 0, state: 'pending' });
    expect(by('interviews')).toMatchObject({ value: 2, state: 'pass' });
    expect(by('landing')).toMatchObject({ value: null, state: 'pending' });

    const [page] = await db.insert(landingPages).values({ caseId: kase.id, slug: 'freight', html: '', copy: landingCopy }).returning();
    await db.insert(landingEvents).values([
      ...Array.from({ length: 40 }, () => ({ landingPageId: page!.id, type: 'visit' as const })),
      { landingPageId: page!.id, type: 'submit' as const, email: 'a@b.com' },
    ]);
    status = await computeChecklistStatus(db, kase.id);
    expect(status.find((g) => g.id === 'landing')).toMatchObject({ value: 2.5, state: 'pending' });
  });

  it('a stored legacy gate with threshold 0 (or below) stays pending even when the value meets it (P3-R16)', async () => {
    const db = await testDb();
    const legacy = pack({
      gates: [
        { id: 'zero', description: 'zero', metricKey: 'emails_sent', threshold: 0 },
        { id: 'neg', description: 'neg', metricKey: 'meetings', threshold: -1 },
      ],
    });
    const kase = await aCase(db, 'freight', legacy);
    const status = await computeChecklistStatus(db, kase.id);
    expect(status.map((g) => [g.id, g.value, g.state])).toEqual([['zero', 0, 'pending'], ['neg', 0, 'pending']]);
    const out = tmp();
    await exportValidation(db, kase.id, out); // a legacy pack still renders
    expect(readFileSync(join(out, 'freight', 'pack.md'), 'utf8')).toContain('## MVP spec');
  });

  it('is empty when the case has no pack', async () => {
    const db = await testDb();
    const kase = await aCase(db);
    expect(await computeChecklistStatus(db, kase.id)).toEqual([]);
  });
});

describe('exportValidation', () => {
  it('writes pack.md, prospects.csv, outreach.csv, outreach-drafts.md and landing/index.html under <outDir>/<slug>', async () => {
    const db = await testDb();
    const kase = await aCase(db, 'freight', pack());
    const p = await aProspect(db, kase.id);
    await addDrafts(db, p.id);
    await db.insert(landingPages).values({ caseId: kase.id, slug: 'freight', html: '<p>old</p>', copy: landingCopy });
    const out = tmp();
    const r = await exportValidation(db, kase.id, out);
    const dir = join(out, 'freight');
    expect(r.dir).toBe(dir);
    for (const f of ['pack.md', 'prospects.csv', 'outreach.csv', 'outreach-drafts.md', join('landing', 'index.html')]) {
      expect(existsSync(join(dir, f)), f).toBe(true);
      expect(r.files).toContain(join(dir, f));
    }
    const html = readFileSync(join(dir, 'landing', 'index.html'), 'utf8');
    expect(html).toContain('Win back detention'); // re-rendered from the stored copy
    const pmd = readFileSync(join(dir, 'pack.md'), 'utf8');
    expect(pmd).toContain('# Validation pack: Freight &lt;b&gt;detention&lt;/b&gt;');
    expect(pmd).toContain('## Validation checklist');
    expect(pmd).toMatch(/Send 3 emails.*\|\s*0\s*\|\s*3 \(differs from default 50\)\s*\|\s*pending/);
    expect(pmd).toContain('## MVP spec');
    expect(pmd).toContain('## Pilot plan');
    expect(pmd).toContain('## Interview kit');
    expect(pmd).toContain('outreach mark <prospect-id|email> note --note "interview: <summary>"');
    expect(pmd).toMatch(/not a prospect yet.*prospects import/);

    const prospectsCsv = readCsv(readFileSync(join(dir, 'prospects.csv'), 'utf8'));
    expect(prospectsCsv[0]).toEqual(['prospect_id', 'name', 'website', 'location', 'email', 'email_source_url', 'email_captured_at', 'casl_basis', 'status', 'fit_reason']);
    expect(prospectsCsv[1]).toEqual([p.id, p.name, p.website, 'Toronto, ON', p.email, p.emailSourceUrl, '2026-10-19', 'self_published', 'new', 'fits']);
    expect(readFileSync(join(dir, 'outreach-drafts.md'), 'utf8')).toContain(`Prospect id: ${p.id}`);
  });

  it('leaves visible markers and a loud warning block when sender settings are missing; none when set', async () => {
    const db = await testDb();
    const kase = await aCase(db, 'freight', pack());
    const p = await aProspect(db, kase.id);
    await addDrafts(db, p.id);
    const out = tmp();
    const r = await exportValidation(db, kase.id, out);
    expect(r.senderMissing).toEqual(['sender.name', 'sender.address', 'sender.contact']);
    for (const f of ['pack.md', 'outreach-drafts.md']) {
      const md = readFileSync(join(out, 'freight', f), 'utf8');
      expect(md.slice(0, 800), f).toMatch(/Sender identity is not set/);
      expect(md, f).toContain('sender.address');
    }
    const outreach = readCsv(readFileSync(join(out, 'freight', 'outreach.csv'), 'utf8'));
    expect(outreach[1]![5]).toContain('[SET SENDER NAME]');

    await setSetting(db, 'sender.name', 'Ann Owner');
    await setSetting(db, 'sender.address', '1 King St W, Toronto ON');
    await setSetting(db, 'sender.contact', 'owner.ca');
    const r2 = await exportValidation(db, kase.id, out);
    expect(r2.senderMissing).toEqual([]);
    expect(readFileSync(join(out, 'freight', 'pack.md'), 'utf8')).not.toMatch(/Sender identity is not set/);
    const outreach2 = readCsv(readFileSync(join(out, 'freight', 'outreach.csv'), 'utf8'));
    expect(outreach2[1]![5]).toContain('Ann Owner'); // footer refreshed from current settings at export
    expect(outreach2[1]![5]).not.toContain('[SET SENDER');
    expect(outreach2[1]![5].split(UNSUBSCRIBE_LINE)).toHaveLength(2);
  });

  it('outreach.csv: injection-safe; suppressed, unsubscribed, not-interested and weak-basis prospects excluded by default', async () => {
    const db = await testDb();
    const kase = await aCase(db, 'freight', pack());
    const evil = await aProspect(db, kase.id, { name: '=HYPERLINK("http://evil.example","click")' });
    await addDrafts(db, evil.id);
    const weak = await aProspect(db, kase.id, { caslBasis: 'unknown' });
    await addDrafts(db, weak.id);
    const supp = await aProspect(db, kase.id);
    await addDrafts(db, supp.id);
    await db.insert(suppressions).values({ email: supp.email!, reason: 'unsubscribe' });
    const unsub = await aProspect(db, kase.id, { status: 'unsubscribed' });
    await addDrafts(db, unsub.id);
    const no = await aProspect(db, kase.id, { status: 'not_interested' });
    await addDrafts(db, no.id);
    await aProspect(db, kase.id); // no drafts

    const out = tmp();
    await exportValidation(db, kase.id, out);
    const raw = readFileSync(join(out, 'freight', 'outreach.csv'), 'utf8');
    const rows = readCsv(raw);
    expect(rows[0]).toEqual([
      'prospect_id', 'prospect', 'email', 'casl_basis',
      'cold_subject', 'cold_body', 'followup1_subject', 'followup1_body', 'followup2_subject', 'followup2_body',
    ]);
    expect(rows.slice(1).map((r) => [r[0], r[2], r[3]])).toEqual([[evil.id, evil.email, 'self_published']]);
    expect(rows[1]![1]).toBe(`'=HYPERLINK("http://evil.example","click")`);
    expect(raw).not.toContain(supp.email!);
    expect(raw).not.toContain(unsub.email!);

    const prospectsRaw = readFileSync(join(out, 'freight', 'prospects.csv'), 'utf8');
    expect(prospectsRaw).not.toContain(supp.email!); // suppressed / unsubscribed addresses are never exported
    expect(prospectsRaw).not.toContain(unsub.email!);
    expect(prospectsRaw).toContain(weak.email!); // listed with its basis, but not in outreach.csv
    const drafts = readFileSync(join(out, 'freight', 'outreach-drafts.md'), 'utf8');
    expect(drafts).not.toContain(supp.email!);
    expect(drafts).not.toContain(unsub.email!);

    await exportValidation(db, kase.id, out, { includeWeak: true });
    expect(readCsv(readFileSync(join(out, 'freight', 'outreach.csv'), 'utf8')).slice(1).map((r) => [r[2], r[3]]))
      .toEqual([[evil.email, 'self_published'], [weak.email, 'unknown']]); // weak rows are visible as such
  });

  it('escapes hostile text in pack.md and outreach-drafts.md', async () => {
    const db = await testDb();
    const hostile = '<script>alert(1)</script> [click](javascript:alert(2)) <img src=x onerror=alert(3)>';
    const kase = await aCase(db, 'freight', pack({
      summary: hostile,
      gates: [{ id: 'g', description: `| broken | ${hostile}`, metricKey: 'emails_sent', threshold: 1 }],
    }));
    const p = await aProspect(db, kase.id, { name: `Evil ${hostile}` });
    await db.insert(outreachDrafts).values({ prospectId: p.id, kind: 'cold', subject: hostile, body: `Hi\n${hostile}`, model: 'm', promptVersion: 'v' });
    const out = tmp();
    await exportValidation(db, kase.id, out);
    for (const f of ['pack.md', 'outreach-drafts.md']) {
      const md = readFileSync(join(out, 'freight', f), 'utf8');
      expect(md, f).not.toContain('<script>');
      expect(md, f).not.toContain('<img');
      expect(md, f).not.toContain('[click](');
      expect(md, f).toContain('&lt;script&gt;');
    }
    const pmd = readFileSync(join(out, 'freight', 'pack.md'), 'utf8');
    expect(pmd).toContain('\\| broken \\|');
  });

  it('bidi overrides and zero-width characters never reach the Markdown or CSV files (P3-R16)', async () => {
    const db = await testDb();
    const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
    const idea = await insertIdea(db, run.id);
    const kase = await insertCase(db, idea.id, { slug: 'freight', title: 'Freight‮ noitneted​', sections: { summary: {} } as unknown as CaseSections });
    await db.insert(validationPacks).values({ caseId: kase.id, sections: pack({ summary: 'Sum⁦mary‍' }), model: 'm', promptVersion: 'v' });
    const p = await aProspect(db, kase.id, { name: 'Acme‮Freight​', fitReason: 'fits⁧' });
    await db.insert(outreachDrafts).values({ prospectId: p.id, kind: 'cold', subject: 'Hi‮ there​', body: 'Body​‮ text', model: 'm', promptVersion: 'v' });
    const out = tmp();
    await exportValidation(db, kase.id, out);
    for (const f of ['pack.md', 'outreach-drafts.md', 'prospects.csv', 'outreach.csv']) {
      const text = readFileSync(join(out, 'freight', f), 'utf8');
      expect(text, f).not.toMatch(/[‪-‮⁦-⁩​-‍]/);
    }
    expect(readFileSync(join(out, 'freight', 'outreach.csv'), 'utf8')).toContain('AcmeFreight');
    expect(readFileSync(join(out, 'freight', 'pack.md'), 'utf8')).toContain('Freight noitneted');
  });

  it('pack.md notes a gate threshold that differs from its default (P3-R16)', async () => {
    const db = await testDb();
    const kase = await aCase(db, 'freight', pack({
      gates: [
        { id: 'sent', description: 'Send 3 emails', metricKey: 'emails_sent', threshold: 3 },
        { id: 'conv', description: '5% conversion', metricKey: 'landing_conversion_pct', threshold: 5 },
      ],
    }));
    const out = tmp();
    await exportValidation(db, kase.id, out);
    const md = readFileSync(join(out, 'freight', 'pack.md'), 'utf8');
    expect(md).toMatch(/Send 3 emails.*3 \(differs from default 50\)/);
    expect(md).toMatch(/5% conversion[^\n]*\| 5% \|/);
    expect(md).not.toMatch(/5% conversion[^\n]*differs/);
  });

  it('pack.md shows how many usable addresses exist next to the emails_sent gate', async () => {
    const db = await testDb();
    const kase = await aCase(db, 'freight', pack());
    const drafted = await aProspect(db, kase.id);
    await addDrafts(db, drafted.id);
    await aProspect(db, kase.id); // self-published, no drafts yet: still a usable address
    await aProspect(db, kase.id, { caslBasis: 'unknown' }); // weak: only with --include-weak
    const supp = await aProspect(db, kase.id);
    await db.insert(suppressions).values({ email: supp.email!, reason: 'unsubscribe' });
    await aProspect(db, kase.id, { status: 'unsubscribed' });
    await aProspect(db, kase.id, { status: 'not_interested' });
    await aProspect(db, kase.id, { email: null, emailSourceUrl: null, caslBasis: 'unknown' });
    const pilot = await aProspect(db, kase.id);
    const sentRow = (md: string) => md.split('\n').find((l) => l.includes('Send 3 emails'))!;

    const out = tmp();
    await exportValidation(db, kase.id, out);
    let md = readFileSync(join(out, 'freight', 'pack.md'), 'utf8');
    expect(sentRow(md)).toContain('you currently have 3 usable addresses');
    expect(md.match(/usable address/g)).toHaveLength(1); // only on the emails_sent gate

    await exportValidation(db, kase.id, out, { pilotDomain: pilot.domain });
    md = readFileSync(join(out, 'freight', 'pack.md'), 'utf8');
    expect(sentRow(md)).toContain('you currently have 2 usable addresses');
    expect(sentRow(md)).toMatch(/fewer than the gate needs/);

    await exportValidation(db, kase.id, out, { pilotDomain: pilot.domain, includeWeak: true });
    md = readFileSync(join(out, 'freight', 'pack.md'), 'utf8');
    expect(sentRow(md)).toContain('you currently have 3 usable addresses');
    expect(sentRow(md)).not.toMatch(/fewer than the gate needs/);
  });

  it('works for a case with no pack, prospects or landing page yet', async () => {
    const db = await testDb();
    const kase = await aCase(db);
    const out = tmp();
    const r = await exportValidation(db, kase.id, out);
    expect(readFileSync(join(out, 'freight', 'pack.md'), 'utf8')).toContain('No validation pack yet');
    expect(readCsv(readFileSync(join(out, 'freight', 'outreach.csv'), 'utf8'))).toHaveLength(1);
    expect(existsSync(join(out, 'freight', 'landing', 'index.html'))).toBe(false);
    expect(r.files).toHaveLength(4);
  });
});
