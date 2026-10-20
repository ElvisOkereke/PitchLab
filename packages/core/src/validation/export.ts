import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { block, cell, line, link, table } from '../case/export-markdown';
import type { Db } from '../db/client';
import { stripInvisible } from '../llm/untrusted';
import { OUTREACH_KINDS, cases, landingPages, outreachDrafts, prospects, suppressions, validationPacks, type OutreachKind } from '../db/schema';
import { computeChecklistStatus, type GateStatus } from './checklist';
import { landingOptions, renderLandingHtml } from './landing';
import { applyFooter, exportableOutreach, outreachCounts, senderFooter, type OutreachCounts } from './outreach';
import { DEFAULT_CHECKLIST_GATES, LandingCopySchema, PackSectionsSchema, type PackDocs } from './schema';

// All LLM- and web-derived text is escaped for its output format (R13): Markdown via the case export helpers, HTML by
// the landing template, CSV by csvCell (quoted, formula starts defused).

// ---- CSV -----------------------------------------------------------------------------------------

/** Characters that make a spreadsheet treat a cell as a formula (or that can precede one). */
const FORMULA_START = /^[=+\-@\t\r\n]|^\s+[=+\-@]/;

/**
 * One CSV cell: line ends unified to \n (a lone CR becomes \n), invisible/bidi/control characters stripped (P3-R16),
 * then a formula-looking start gets a `'`; always quoted, quotes doubled, newlines kept inside the quotes.
 */
export function csvCell(v: string | number | null | undefined): string {
  let s = stripInvisible((v === null || v === undefined ? '' : String(v)).replace(/\r\n?/g, '\n'));
  if (FORMULA_START.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** A whole CSV file: UTF-8 byte-order mark (so spreadsheets read accents), CRLF record ends. */
export function csvRows(rows: (string | number | null | undefined)[][]): string {
  return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

// ---- Markdown pieces -----------------------------------------------------------------------------

const list = (items: string[]) => (items.length ? items.map((i) => `- ${line(i)}`) : ['_None._']);

/** Loud notice at the top of files whose emails would go out without CASL identification. */
function senderWarning(missing: string[]): string[] {
  if (missing.length === 0) return [];
  return [
    '> ⚠️ **Sender identity is not set.** Canada’s anti-spam law (CASL) requires your name, a mailing address and one',
    '> other contact method (phone or website) in every email. Until you set them, every draft shows',
    '> `[SET SENDER NAME]`, `[SET SENDER ADDRESS]` or `[SET SENDER CONTACT]` markers. Do not send drafts with markers.',
    '>',
    `> Missing: ${missing.join(', ')}. Set each one, then run validate again:`,
    '>',
    ...missing.map((k) => `> \`npm run gen -- config set ${k} "…"\``),
    '',
  ];
}

const fmtValue = (g: GateStatus) =>
  g.value === null ? 'n/a' : g.metricKey === 'landing_conversion_pct' ? `${g.value}%` : String(g.value);
const fmtNumber = (g: GateStatus, n: number) => (g.metricKey === 'landing_conversion_pct' ? `${n}%` : String(n));
/** The threshold, noting when it differs from the default gate for the same metric (P3-R16). */
const fmtThreshold = (g: GateStatus) => {
  const def = DEFAULT_CHECKLIST_GATES.find((d) => d.metricKey === g.metricKey);
  const note = def && def.threshold !== g.threshold ? ` (differs from default ${fmtNumber(g, def.threshold)})` : '';
  return `${fmtNumber(g, g.threshold)}${note}`;
};

function checklistSection(status: GateStatus[]): string[] {
  const passed = status.filter((g) => g.state === 'pass').length;
  return [
    '## Validation checklist',
    '',
    `${passed} of ${status.length} gates passed. Values come from what you record with \`npm run gen -- outreach mark\`.`,
    '',
    table(
      ['Gate', 'Metric', 'Current', 'Threshold', 'Status'],
      status.map((g) => [cell(g.description), g.metricKey, fmtValue(g), fmtThreshold(g), g.state === 'pass' ? '✅ pass' : 'pending']),
    ),
  ];
}

function mvpSection(m: PackDocs['mvpSpec']): string[] {
  return [
    '## MVP spec',
    '',
    block(m.summary),
    '',
    '### Features',
    '',
    ...m.features.map((f) => `- **${line(f.name)}**${f.manualAtFirst ? ' (manual at first)' : ''}: ${line(f.why)}`),
    '',
    '### Fake or do by hand first',
    '',
    ...list(m.fakeOrManualFirst),
    '',
    '### Architecture sketch',
    '',
    block(m.architectureSketch),
    '',
    '### Build estimate',
    '',
    `${m.buildEstimate.lowDays}–${m.buildEstimate.highDays} days for one engineer. Assumptions:`,
    '',
    ...list(m.buildEstimate.assumptions),
    '',
    '### Risks',
    '',
    ...list(m.risks),
    '',
    '### Packaging',
    '',
    block(m.packaging),
  ];
}

function pilotSection(p: PackDocs['pilotPlan']): string[] {
  return [
    '## Pilot plan',
    '',
    `**Ideal pilot customer:** ${block(p.idealPilotCustomer)}`,
    '',
    `**First step:** ${block(p.firstStep)}`,
    '',
    '### Steps',
    '',
    ...p.steps.map((s, i) => `${i + 1}. ${line(s)}`),
    '',
    '### Measures',
    '',
    table(['Metric', 'Success threshold'], p.measures.map((x) => [cell(x.metric), cell(x.successThreshold)])),
    '',
    `**Timeline:** ${p.timelineWeeks} weeks`,
    '',
    '### Permissions and risks',
    '',
    ...list(p.permissionsAndRisks),
  ];
}

function interviewSection(k: PackDocs['interviewKit']): string[] {
  return [
    '## Interview kit',
    '',
    '### Who to talk to',
    '',
    ...list(k.targetRoles),
    '',
    '### Where to find them',
    '',
    ...list(k.whereToFind),
    '',
    '### Opening',
    '',
    block(k.opening),
    '',
    '### Questions',
    '',
    ...k.questions.flatMap((q, i) => [
      `${i + 1}. **${line(q.question)}**`,
      `   - Why ask: ${line(q.whyAsk)}`,
      `   - Listen for: ${line(q.listenFor)}`,
    ]),
    '',
    '### Red flags',
    '',
    ...list(k.redFlags),
    '',
    'Record each interview as a note starting "interview:" so the checklist counts it: `npm run gen -- outreach mark <email> note --note "interview: …"`.',
  ];
}

function outreachSummary(c: OutreachCounts): string[] {
  const e = c.events;
  return [
    '## Outreach so far',
    '',
    `- Prospects: ${c.prospects} (${c.withEmail} with an email)`,
    `- Sent: ${e.sent.prospects} · Replied: ${e.replied.prospects} · Positive: ${e.positive.prospects} · Meetings: ${e.meeting.prospects} · ` +
      `Not interested: ${e.not_interested.prospects} · Unsubscribed: ${e.unsubscribe.prospects}`,
  ];
}

function packMarkdown(
  title: string, docs: PackDocs | null, meta: { model: string; promptVersion: string } | null, status: GateStatus[],
  counts: OutreachCounts, senderMissing: string[],
): string {
  const out = [`# Validation pack: ${line(title)}`, '', ...senderWarning(senderMissing)];
  if (!docs || !meta) {
    out.push('_No validation pack yet. Run `npm run gen -- validate <case>` to generate one._', '', ...outreachSummary(counts), '');
    return out.join('\n');
  }
  out.push(`_Model: ${line(meta.model)} · Prompt: ${line(meta.promptVersion)}_`, '');
  if (docs.reviewNotes?.length) out.push('> **Review notes:**', ...docs.reviewNotes.map((n) => `> - ${line(n)}`), '');
  out.push(
    ...checklistSection(status), '',
    ...outreachSummary(counts), '',
    ...mvpSection(docs.mvpSpec), '',
    ...pilotSection(docs.pilotPlan), '',
    ...interviewSection(docs.interviewKit), '',
  );
  return out.join('\n');
}

// ---- Export --------------------------------------------------------------------------------------

const KIND_LABEL: Record<OutreachKind, string> = { cold: 'Cold email', followup1: 'Follow-up 1', followup2: 'Follow-up 2' };
const isoDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');

export type ValidationExport = {
  dir: string;
  files: string[];
  senderMissing: string[];
  privacyMissing: boolean;
  prospects: number;
  outreachRows: number;
};

/**
 * Write a case's validation files under `<outDir>/<slug>/`: pack.md (documents + live checklist status), prospects.csv,
 * outreach.csv (only sendable prospects: self-published email unless includeWeak, never suppressed / unsubscribed /
 * not interested), outreach-drafts.md and landing/index.html (re-rendered from the stored copy with current settings).
 * Draft footers are refreshed from the current sender settings; missing settings give a warning block and markers.
 */
export async function exportValidation(
  db: Db,
  caseId: string,
  outDir: string,
  opts: { includeWeak?: boolean; log?: (msg: string) => void } = {},
): Promise<ValidationExport> {
  const log = opts.log ?? (() => {});
  const [kase] = await db.select().from(cases).where(eq(cases.id, caseId));
  if (!kase) throw new Error(`exportValidation: unknown case ${caseId}`);
  if (!/^[a-z0-9-]+$/.test(kase.slug)) throw new Error(`exportValidation: unsafe case slug ${JSON.stringify(kase.slug)}`);
  const dir = join(outDir, kase.slug);
  mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  const write = (name: string, content: string) => {
    const path = join(dir, name);
    writeFileSync(path, content, 'utf8');
    files.push(path);
  };

  const { footer, missing: senderMissing } = await senderFooter(db);

  // pack.md
  const [packRow] = await db.select().from(validationPacks).where(eq(validationPacks.caseId, caseId));
  const parsed = packRow ? PackSectionsSchema.safeParse(packRow.sections) : null;
  if (packRow && !parsed?.success) log('export: the stored validation pack does not match the current schema; regenerate it with --refresh');
  const docs = parsed?.success ? parsed.data : null;
  const status = await computeChecklistStatus(db, caseId);
  const counts = await outreachCounts(db, caseId);
  write('pack.md', packMarkdown(kase.title, docs, packRow ?? null, status, counts, senderMissing));

  // prospects.csv — suppressed / unsubscribed addresses are left out.
  const allProspects = await db.select().from(prospects).where(eq(prospects.caseId, caseId)).orderBy(prospects.createdAt, prospects.id);
  const emails = allProspects.map((p) => p.email?.toLowerCase()).filter((e): e is string => !!e);
  const suppressed = new Set(
    emails.length ? (await db.select({ email: suppressions.email }).from(suppressions).where(inArray(suppressions.email, emails))).map((r) => r.email) : [],
  );
  const hidden = (p: (typeof allProspects)[number]) => p.status === 'unsubscribed' || (!!p.email && suppressed.has(p.email.toLowerCase()));
  write('prospects.csv', csvRows([
    ['name', 'website', 'location', 'email', 'email_source_url', 'email_captured_at', 'casl_basis', 'status', 'fit_reason'],
    ...allProspects.map((p) => {
      const showEmail = !!p.email && !hidden(p);
      return [
        p.name, p.website, p.location, showEmail ? p.email : '', showEmail ? p.emailSourceUrl : '', showEmail ? isoDate(p.emailCapturedAt) : '',
        p.caslBasis, p.status, p.fitReason,
      ];
    }),
  ]));

  // outreach.csv — only sendable prospects, footers from the current settings.
  const sendable = await exportableOutreach(db, caseId, { includeWeak: opts.includeWeak });
  const body = (b: string | undefined) => (b === undefined ? '' : applyFooter(b, footer));
  write('outreach.csv', csvRows([
    ['prospect', 'email', ...OUTREACH_KINDS.flatMap((k) => [`${k}_subject`, `${k}_body`])],
    ...sendable.map(({ prospect, drafts }) => [
      prospect.name, prospect.email, ...OUTREACH_KINDS.flatMap((k) => [drafts[k]?.subject ?? '', body(drafts[k]?.body)]),
    ]),
  ]));

  // outreach-drafts.md — every draft except those of suppressed / unsubscribed prospects.
  const draftRows = allProspects.length
    ? await db.select().from(outreachDrafts).where(inArray(outreachDrafts.prospectId, allProspects.map((p) => p.id)))
    : [];
  const sendableIds = new Set(sendable.map((s) => s.prospect.id));
  const withDrafts = allProspects.filter((p) => draftRows.some((d) => d.prospectId === p.id));
  const shown = withDrafts.filter((p) => !hidden(p));
  const md = [
    `# Outreach drafts: ${line(kase.title)}`,
    '',
    ...senderWarning(senderMissing),
    '> This tool never sends email. Read and edit each draft, send it yourself from your own mailbox, then record it:',
    '> `npm run gen -- outreach mark <email> sent`. Record replies the same way (replied, positive, meeting, not_interested, unsubscribe).',
    '',
  ];
  if (withDrafts.length > shown.length) md.push(`_${withDrafts.length - shown.length} prospect(s) left out: unsubscribed or suppressed._`, '');
  if (shown.length === 0) md.push('_No drafts yet._', '');
  for (const p of shown) {
    md.push(`## ${line(p.name)} (${line(p.domain)})`, '');
    md.push(`- Email: ${p.email ? line(p.email) : 'none'}${p.emailSourceUrl ? ` (found on ${link(p.emailSourceUrl)})` : ''} · CASL basis: ${p.caslBasis}`);
    md.push(`- Status: ${p.status}`);
    if (!sendableIds.has(p.id)) {
      const why = p.status === 'not_interested' ? 'marked not interested' : `weak CASL basis (${p.caslBasis}); export with --include-weak`;
      md.push(`- Not in outreach.csv: ${why}`);
    }
    md.push('');
    for (const kind of OUTREACH_KINDS) {
      const d = draftRows.find((x) => x.prospectId === p.id && x.kind === kind);
      if (!d) continue;
      md.push(`### ${KIND_LABEL[kind]}: ${line(d.subject)}`, '', block(applyFooter(d.body, footer)), '');
    }
  }
  write('outreach-drafts.md', md.join('\n'));

  // landing/index.html — from the stored copy with the current settings (falls back to the stored html).
  let privacyMissing = false;
  const [page] = await db.select().from(landingPages).where(eq(landingPages.caseId, caseId));
  if (page) {
    const copy = LandingCopySchema.safeParse(page.copy);
    let html = page.html;
    if (copy.success) {
      const { privacyMissing: pm, ...renderOpts } = await landingOptions(db, log);
      privacyMissing = pm;
      html = renderLandingHtml(copy.data, renderOpts);
    } else {
      log('export: stored landing copy does not match the current schema; writing the stored html');
    }
    mkdirSync(join(dir, 'landing'), { recursive: true });
    write(join('landing', 'index.html'), html);
  }

  return { dir, files, senderMissing, privacyMissing, prospects: allProspects.length, outreachRows: sendable.length };
}
