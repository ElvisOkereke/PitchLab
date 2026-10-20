import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { and, count, desc, eq, gte, inArray, isNull, like, or, sum } from 'drizzle-orm';
import { caseToMarkdown } from './case/export-markdown';
import {
  CliError, KNOWN_CONFIG_KEYS, buildProgram, positiveInt, type MarkType, type RunOpts, type ValidateCliOpts,
} from './cli-program';
import { loadEnv } from './config/env';
import { createDb, type Db } from './db/client';
import { runMigrations } from './db/migrate';
import { cases, claims, dataCalls, ideas, lenses, llmCalls, markets, runs, scores, settings } from './db/schema';
import { seedDefaults } from './db/seed';
import { buildRouter } from './llm/router';
import { createRun, executeRun } from './pipeline/run';
import { defaultRunConfig, type RunConfig, type StageDeps } from './pipeline/types';
import { fetchPage } from './tools/fetch-page';
import { buildSources } from './tools/sources';
import { computeChecklistStatus } from './validation/checklist';
import { markOutreach, outreachCounts } from './validation/outreach';
import { parseProspectCsv, upsertProspects } from './validation/prospects';
import { runValidation } from './validation/run';
import { getSetting, setSetting } from './validation/settings';

/** npm runs workspace scripts inside packages/core; resolve user paths against where `npm` was run. */
const BASE_DIR = process.env.INIT_CWD ?? process.cwd();
const fromBase = (p: string) => resolve(BASE_DIR, p);
const EXPORT_DIR = fromBase(join('output', 'cases'));
const VALIDATION_DIR = fromBase(join('output', 'validation'));
const DEFAULT_DB_URL = 'pglite://.data/pglite';

/** Strip terminal control characters from text that may come from harvested/LLM content. */
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
const out = (s: string) => console.log(clean(s));

function loadDotEnv(): void {
  const path = fromBase('.env');
  if (existsSync(path)) process.loadEnvFile(path);
}

function resolveDbUrl(url: string): string {
  if (!url.startsWith('pglite://')) return url;
  const target = url.slice('pglite://'.length);
  if (!target || target === 'memory') return url;
  return `pglite://${fromBase(target)}`;
}

async function openDb(url: string): Promise<Db> {
  const db = await createDb(resolveDbUrl(url));
  await runMigrations(db);
  await seedDefaults(db);
  return db;
}

async function closeDb(db: Db): Promise<void> {
  const client = (db as unknown as { $client: { close?: () => Promise<void>; end?: () => Promise<void> } }).$client;
  if (client.close) await client.close();
  else if (client.end) await client.end();
}

/** Opens the DB without needing the LLM key (for read-only commands). */
async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  loadDotEnv();
  const db = await openDb(process.env.DATABASE_URL || DEFAULT_DB_URL);
  try {
    return await fn(db);
  } finally {
    await closeDb(db);
  }
}

async function exportCase(db: Db, slug: string): Promise<string> {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new CliError(`Invalid case slug: ${slug}`, 1);
  const [kase] = await db.select().from(cases).where(eq(cases.slug, slug));
  if (!kase) throw new CliError(`No case with slug: ${slug}`, 1);
  const claimRows = await db.select().from(claims).where(eq(claims.caseId, kase.id)).orderBy(claims.createdAt);
  const scoreRows = await db.select().from(scores).where(eq(scores.caseId, kase.id)).orderBy(scores.createdAt);
  mkdirSync(EXPORT_DIR, { recursive: true });
  const path = join(EXPORT_DIR, `${slug}.md`);
  writeFileSync(path, caseToMarkdown(kase, claimRows, scoreRows), 'utf8');
  return path;
}

/** Executes (or resumes) a run with the real stages, then prints slugs, cost and export paths. */
async function execute(runId: string | null, config: RunConfig | null): Promise<number> {
  loadDotEnv();
  const env = loadEnv();
  const db = await openDb(env.DATABASE_URL);
  try {
    let id = runId;
    if (id === null) {
      if (config?.lensIds) {
        const found = await db.select({ id: lenses.id }).from(lenses).where(inArray(lenses.id, config.lensIds));
        const missing = config.lensIds.filter((l) => !found.some((f) => f.id === l));
        if (missing.length) throw new CliError(`Unknown lens id(s): ${missing.join(', ')}`, 2);
      }
      id = (await createRun(db, config!)).id;
      out(`Run ${id} created`);
    }
    const [row] = await db.select().from(runs).where(eq(runs.id, id));
    if (!row) throw new CliError(`Run not found: ${id}`, 1);
    const [market] = await db.select().from(markets).where(eq(markets.id, row.config.marketId));

    const deps: StageDeps = {
      db,
      router: buildRouter(env, db),
      sources: buildSources(env, market ? { countries: market.countries } : undefined),
      fetchPage,
      log: out,
    };
    const status = await executeRun(deps, id);
    const [final] = await db.select().from(runs).where(eq(runs.id, id));
    const cost = `$${Number(final!.costUsd).toFixed(4)}`;

    if (status === 'failed') {
      console.error(clean(`Run ${id} failed at ${final!.currentStage ?? 'unknown stage'}: ${final!.error ?? 'unknown error'}`));
      console.error(`Total cost: ${cost}`);
      console.error(`Resume with: npm run gen -- resume ${id}`);
      return 1;
    }

    const caseRows = await db.select({ slug: cases.slug }).from(cases)
      .innerJoin(ideas, eq(cases.ideaId, ideas.id)).where(eq(ideas.runId, id)).orderBy(cases.createdAt);
    out(`Run ${id} succeeded`);
    out(caseRows.length ? `Cases: ${caseRows.map((c) => c.slug).join(', ')}` : 'Cases: none');
    out(`Total cost: ${cost}`);
    for (const c of caseRows) out(`Exported ${await exportCase(db, c.slug)}`);
    return 0;
  } finally {
    await closeDb(db);
  }
}

const csv = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);

function readIdeaFile(path: string): string {
  let text = '';
  try {
    text = readFileSync(fromBase(path), 'utf8');
  } catch {
    // reported below
  }
  if (!text.trim()) throw new CliError(`Idea file is empty or unreadable: ${path}`, 2);
  return text;
}

function configFrom(opts: RunOpts): RunConfig {
  const partial: Partial<RunConfig> & Pick<RunConfig, 'seedType'> = { seedType: opts.seed };
  if (opts.seed === 'idea') {
    if (!opts.file) throw new CliError('--seed idea requires --file <path>', 2);
    partial.ideaText = readIdeaFile(opts.file);
  }
  if (opts.seed === 'sector') {
    partial.sectors = csv(opts.sectors ?? '');
    if (partial.sectors.length === 0) throw new CliError('--seed sector requires --sectors a,b', 2);
  }
  if (opts.seed === 'lens') {
    partial.lensIds = csv(opts.lenses ?? '');
    if (partial.lensIds.length === 0) throw new CliError('--seed lens requires --lenses x,y', 2);
  }
  if (opts.ideas !== undefined) partial.ideaCount = positiveInt(opts.ideas);
  if (opts.advance !== undefined) partial.advanceCount = positiveInt(opts.advance);
  return defaultRunConfig(partial);
}

async function listRuns(): Promise<number> {
  return withDb(async (db) => {
    const rows = await db.select().from(runs).orderBy(desc(runs.createdAt)).limit(20);
    if (rows.length === 0) {
      out('No runs yet.');
      return 0;
    }
    const counts = await db.select({ runId: ideas.runId, n: count(cases.id) }).from(cases)
      .innerJoin(ideas, eq(cases.ideaId, ideas.id))
      .where(inArray(ideas.runId, rows.map((r) => r.id)))
      .groupBy(ideas.runId);
    const caseCount = new Map(counts.map((c) => [c.runId, c.n]));
    const table = [
      ['ID', 'SEED', 'STATUS', 'STAGE', 'COST', 'CASES'],
      ...rows.map((r) => [
        r.id, r.config.seedType, r.status, r.currentStage ?? '-', `$${Number(r.costUsd).toFixed(4)}`, String(caseCount.get(r.id) ?? 0),
      ]),
    ];
    const widths = table[0]!.map((_, i) => Math.max(...table.map((r) => r[i]!.length)));
    for (const r of table) out(r.map((v, i) => v.padEnd(widths[i]!)).join('  ').trimEnd());
    return 0;
  });
}

async function exportCommand(slug: string | undefined, opts: { all?: boolean }): Promise<number> {
  if (!slug && !opts.all) throw new CliError('Give a case slug or --all', 2);
  return withDb(async (db) => {
    const slugs = opts.all
      ? (await db.select({ slug: cases.slug }).from(cases).orderBy(cases.createdAt)).map((c) => c.slug)
      : [slug!];
    if (slugs.length === 0) out('No cases to export.');
    for (const s of slugs) out(`Exported ${await exportCase(db, s)}`);
    return 0;
  });
}

// ---- Validation pack -----------------------------------------------------------------------------

async function findCase(db: Db, slug: string): Promise<typeof cases.$inferSelect> {
  if (!/^[a-z0-9-]+$/.test(slug)) throw new CliError(`Invalid case slug: ${slug}`, 1);
  const [kase] = await db.select().from(cases).where(eq(cases.slug, slug));
  if (!kase) throw new CliError(`No case with slug: ${slug}`, 1);
  return kase;
}

function senderWarning(missing: string[]): void {
  if (missing.length === 0) return;
  console.error('');
  console.error('WARNING: sender identity is not set (CASL). Every draft shows [SET SENDER ...] markers: do not send them as is.');
  console.error(`Missing: ${missing.join(', ')}. Set them, then run validate again:`);
  for (const k of missing) console.error(`  npm run gen -- config set ${k} "..."`);
}

/** Model and data-API spend recorded since `since` outside pipeline runs (validation calls carry no run id). */
async function spendSince(db: Db, since: Date): Promise<number> {
  const [llm] = await db.select({ total: sum(llmCalls.costUsd) }).from(llmCalls).where(and(isNull(llmCalls.runId), gte(llmCalls.createdAt, since)));
  const [data] = await db.select({ total: sum(dataCalls.costUsd) }).from(dataCalls).where(and(isNull(dataCalls.runId), gte(dataCalls.createdAt, since)));
  return Number(llm?.total ?? 0) + Number(data?.total ?? 0);
}

async function validateCommand(slug: string, opts: ValidateCliOpts): Promise<number> {
  loadDotEnv();
  const env = loadEnv();
  const db = await openDb(env.DATABASE_URL);
  try {
    const kase = await findCase(db, slug);
    const started = new Date();
    const result = await runValidation(
      { db, router: buildRouter(env, db), fetchPage, log: out, outDir: VALIDATION_DIR, placesApiKey: env.GOOGLE_PLACES_API_KEY },
      kase.id,
      opts,
    );
    out('');
    out(`Validation for ${slug}:`);
    for (const s of result.steps) out(`  ${s.step.padEnd(10)} ${s.status.padEnd(8)} ${s.detail}`);
    if (result.export) out(`Files: ${result.export.dir}`);
    out(`Cost: $${(await spendSince(db, started)).toFixed(4)}`);
    if (result.export) {
      senderWarning(result.export.senderMissing);
      if (result.export.privacyMissing) {
        console.error('WARNING: the landing page has no privacy contact. Set one: npm run gen -- config set landing.privacyContact "you@example.com"');
      }
    }
    if (!result.ok) console.error(clean(`Validation for ${slug} did not finish cleanly; finished steps are saved. Fix the failure and run it again.`));
    return result.exitCode;
  } finally {
    await closeDb(db);
  }
}

async function prospectsImportCommand(slug: string, opts: { file: string }): Promise<number> {
  let text: string;
  try {
    text = readFileSync(fromBase(opts.file), 'utf8');
  } catch {
    throw new CliError(`CSV file is unreadable: ${opts.file}`, 2);
  }
  let parsed: ReturnType<typeof parseProspectCsv>;
  try {
    parsed = parseProspectCsv(text);
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err), 2);
  }
  return withDb(async (db) => {
    const kase = await findCase(db, slug);
    const r = await upsertProspects(db, kase.id, parsed.rows, 'csv');
    out(`Imported ${r.inserted} new prospect(s); ${r.existing} already listed (left unchanged); ${r.skipped + parsed.skipped.length} skipped.`);
    for (const s of parsed.skipped) out(`  line ${s.line}: skipped (${s.reason})`);
    for (const w of parsed.warnings) out(`  line ${w.line}: ${w.message}`);
    return 0;
  });
}

async function outreachMarkCommand(ref: string, type: MarkType, opts: { note?: string }): Promise<number> {
  return withDb(async (db) => {
    let r: Awaited<ReturnType<typeof markOutreach>>;
    try {
      r = await markOutreach(db, ref, type, opts.note);
    } catch (err) {
      throw new CliError(err instanceof Error ? err.message : String(err), 1);
    }
    for (const p of r.prospects) out(`Recorded ${type} for prospect ${p.id}; status: ${p.status}`);
    if (r.suppressed) out(`Suppressed ${r.suppressed}: it will never be drafted or exported again.`);
    return 0;
  });
}

async function outreachStatusCommand(slug: string): Promise<number> {
  return withDb(async (db) => {
    const kase = await findCase(db, slug);
    const c = await outreachCounts(db, kase.id);
    out(`Prospects: ${c.prospects} (${c.withEmail} with an email)`);
    out(`By status: ${Object.entries(c.byStatus).filter(([, n]) => n > 0).map(([s, n]) => `${s} ${n}`).join(', ') || 'none'}`);
    out(`Events (prospects / events): ${Object.entries(c.events).map(([t, e]) => `${t} ${e.prospects}/${e.events}`).join(', ')}`);
    const gates = await computeChecklistStatus(db, kase.id);
    if (gates.length === 0) out('Checklist: no validation pack yet (run validate).');
    else {
      out('Checklist:');
      for (const g of gates) {
        const pct = g.metricKey === 'landing_conversion_pct' ? '%' : '';
        out(`  [${g.state === 'pass' ? 'x' : ' '}] ${g.description} (${g.metricKey}: ${g.value === null ? 'n/a' : `${g.value}${pct}`} of ${g.threshold}${pct})`);
      }
    }
    return 0;
  });
}

async function configSetCommand(key: string, value: string): Promise<number> {
  return withDb(async (db) => {
    await setSetting(db, key, value.trim());
    out(`Set ${key}.`);
    if (!(KNOWN_CONFIG_KEYS as readonly string[]).includes(key)) {
      out(`Note: ${key} is not a key this tool reads (known: ${KNOWN_CONFIG_KEYS.join(', ')}).`);
    }
    return 0;
  });
}

const showValue = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

async function configGetCommand(key: string | undefined): Promise<number> {
  return withDb(async (db) => {
    if (key !== undefined) {
      const v = await getSetting(db, key);
      out(v === null ? `${key} is not set` : `${key} = ${showValue(v)}`);
      return 0;
    }
    const rows = await db.select().from(settings)
      .where(or(like(settings.key, 'sender.%'), like(settings.key, 'landing.%')))
      .orderBy(settings.key);
    if (rows.length === 0) out('No sender. or landing. settings yet.');
    for (const r of rows) out(`${r.key} = ${showValue(r.value)}`);
    return 0;
  });
}

const program = buildProgram({
  run: (opts: RunOpts) => execute(null, configFrom(opts)),
  resume: async (runId: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new CliError(`Run not found: ${runId}`, 1);
    return execute(runId, null);
  },
  export: exportCommand,
  runs: listRuns,
  validate: validateCommand,
  prospectsImport: prospectsImportCommand,
  outreachMark: outreachMarkCommand,
  outreachStatus: outreachStatusCommand,
  configSet: configSetCommand,
  configGet: configGetCommand,
});

try {
  await program.parseAsync(process.argv);
} catch (err) {
  // Error messages never contain env values: loadEnv reports variable names only, and the router never puts keys in messages.
  console.error(clean(err instanceof Error ? err.message : String(err)));
  process.exitCode = err instanceof CliError ? err.exitCode : 1;
}
