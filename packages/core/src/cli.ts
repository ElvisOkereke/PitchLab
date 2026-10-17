import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Command, Option } from 'commander';
import { count, desc, eq, inArray } from 'drizzle-orm';
import { caseToMarkdown } from './case/export-markdown';
import { loadEnv } from './config/env';
import { createDb, type Db } from './db/client';
import { runMigrations } from './db/migrate';
import { cases, claims, ideas, lenses, markets, runs, scores } from './db/schema';
import { seedDefaults } from './db/seed';
import { buildRouter } from './llm/router';
import { createRun, executeRun } from './pipeline/run';
import { defaultRunConfig, type RunConfig, type StageDeps } from './pipeline/types';
import { fetchPage } from './tools/fetch-page';
import { buildSources } from './tools/sources';

/** npm runs workspace scripts inside packages/core; resolve user paths against where `npm` was run. */
const BASE_DIR = process.env.INIT_CWD ?? process.cwd();
const fromBase = (p: string) => resolve(BASE_DIR, p);
const EXPORT_DIR = fromBase(join('output', 'cases'));
const DEFAULT_DB_URL = 'pglite://.data/pglite';

class CliError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
  }
}

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
function positiveInt(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new CliError(`Expected a positive whole number, got: ${v}`, 2);
  return n;
}

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

type RunOpts = {
  seed: RunConfig['seedType'];
  sectors?: string; lenses?: string; file?: string; ideas?: string; advance?: string;
};

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

const program = new Command()
  .name('gen')
  .description('Business-case generator')
  .showHelpAfterError();

program.command('run')
  .description('Create and execute a run')
  .addOption(new Option('--seed <type>', 'how to seed the run').choices(['open', 'sector', 'lens', 'idea']).makeOptionMandatory())
  .option('--sectors <list>', 'comma-separated sectors (for --seed sector)')
  .option('--lenses <list>', 'comma-separated lens ids (for --seed lens)')
  .option('--file <path>', 'idea file (for --seed idea)')
  .option('--ideas <n>', 'number of ideas to generate')
  .option('--advance <n>', 'number of ideas to advance to the gate')
  .action(async (opts: RunOpts) => {
    process.exitCode = await execute(null, configFrom(opts));
  });

program.command('resume')
  .description('Resume a failed run from its failed stage')
  .argument('<runId>')
  .action(async (runId: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new CliError(`Run not found: ${runId}`, 1);
    process.exitCode = await execute(runId, null);
  });

program.command('export')
  .description('Export case(s) as Markdown to output/cases/<slug>.md')
  .argument('[slug]')
  .option('--all', 'export every case')
  .action(async (slug: string | undefined, opts: { all?: boolean }) => {
    process.exitCode = await exportCommand(slug, opts);
  });

program.command('runs')
  .description('List recent runs')
  .action(async () => {
    process.exitCode = await listRuns();
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  // Error messages never contain env values: loadEnv reports variable names only, and the router never puts keys in messages.
  console.error(clean(err instanceof Error ? err.message : String(err)));
  process.exitCode = err instanceof CliError ? err.exitCode : 1;
}
