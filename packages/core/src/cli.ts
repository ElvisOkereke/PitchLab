import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { and, count, desc, eq, gte, inArray, isNull, like, or, sum } from 'drizzle-orm';
import { caseToMarkdown } from './case/export-markdown';
import {
  CliError, KNOWN_CONFIG_KEYS, buildProgram, positiveInt, resumeRefusal,
  type MarkType, type ResearchCliOpts, type RunOpts, type ValidateCliOpts, type WorkerCliOpts,
} from './cli-program';
import { loadEnv, type Env } from './config/env';
import { scrubError } from './tools/scrub';
import { BENCHMARKS, CURRENT_BENCHMARK } from './bench/definitions';
import { renderScorecardMarkdown } from './bench/markdown';
import {
  BENCH_REFUSAL, finalizeBenchmarkPasses, listBenchmarkPasses, previewBaseline, queueBenchmarkPass, recomputePass, saveBaseline, type PassRow,
} from './bench/passes';
import { WORKER_STATUS_KEY } from './dashboard/settings';
import { createDb, type Db } from './db/client';
import { runMigrations } from './db/migrate';
import { cases, claims, dataCalls, ideas, lenses, llmCalls, runs, scores, settings } from './db/schema';
import { seedDefaults } from './db/seed';
import { EXAMPLE_REFUSAL, ensureExampleQuietly, listRealRuns, realCaseSlugs } from './example/example';
import { buildRouter } from './llm/router';
import { buildStageDeps } from './pipeline/deps';
import { createRun, executeRunWithSetup } from './pipeline/run';
import { defaultRunConfig, type RunConfig } from './pipeline/types';
import { fetchPage } from './tools/fetch-page';
import { computeChecklistStatus } from './validation/checklist';
import { markOutreach, outreachCounts } from './validation/outreach';
import { parseProspectCsv, upsertProspects } from './validation/prospects';
import { executeValidationJob } from './validation/job';
import { runValidation, type ValidationDeps } from './validation/run';
import { getSetting, setSetting } from './validation/settings';
import { runMaintenanceQuietly } from './maintenance';
import { resolveModels, runWorker, workerStatus } from './worker';
import { listMissions, MissionInputSchema, queueMission } from './dashboard/missions';
import { createArchiveClient } from './research/archive';
import { buildCollectors, runMission } from './research/mission';

/** npm runs workspace scripts inside packages/core; resolve user paths against where `npm` was run. */
const BASE_DIR = process.env.INIT_CWD ?? process.cwd();
const fromBase = (p: string) => resolve(BASE_DIR, p);
const EXPORT_DIR = fromBase(join('output', 'cases'));
const BENCH_DIR = fromBase(join('output', 'bench'));
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
  await ensureExampleQuietly(db, (l) => console.error(l));
  // Expired YouTube data goes before anything else uses the database (a worker down for weeks must not leave it behind).
  await runMaintenanceQuietly(db, (l) => console.error(l));
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

/** Freezes any benchmark pass whose runs have all finished; never lets a failure stop the worker. */
async function finaliseBenchmarks(db: Db): Promise<void> {
  try {
    await finalizeBenchmarkPasses(db);
  } catch (err) {
    console.error(clean(`benchmark finalise failed: ${scrubError(err instanceof Error ? err.message : String(err)).slice(0, 300)}`));
  }
}

/** Executes (or resumes) one run with the real stages, then prints slugs, cost and export paths (gen run and gen worker). */
async function executeAndReport(db: Db, env: Env, id: string): Promise<number> {
  const [row] = await db.select().from(runs).where(eq(runs.id, id));
  if (!row) throw new CliError(`Run not found: ${id}`, 1);
  // A setup failure (e.g. model config) marks the run failed instead of leaving it running.
  const status = await executeRunWithSetup(db, id, () => buildStageDeps(env, db, row.config, out));
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
}

/** `gen run` (config) or `gen resume` (runId). */
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
      // Created as running (not queued) so a `gen worker` on the same database never claims it.
      id = (await createRun(db, config!, { status: 'running' })).id;
      out(`Run ${id} created`);
    } else {
      const [row] = await db.select({ status: runs.status }).from(runs).where(eq(runs.id, id));
      if (!row) throw new CliError(`Run not found: ${id}`, 1);
      const refusal = resumeRefusal(row.status);
      if (refusal) throw new CliError(`Cannot resume ${id}: ${refusal}`, 1);
    }
    const code = await executeAndReport(db, env, id);
    await finaliseBenchmarks(db);
    return code;
  } finally {
    await closeDb(db);
  }
}

/** `gen worker`: executes runs queued from the dashboard until stopped (or one pass with --once). */
async function workerCommand(opts: WorkerCliOpts): Promise<number> {
  loadDotEnv();
  const env = loadEnv();
  const db = await openDb(env.DATABASE_URL);
  const models = resolveModels(env);
  const stop = new AbortController();
  let busy = false;
  let interrupts = 0;
  const onSigint = () => {
    interrupts += 1;
    if (interrupts > 1) {
      console.error('Exiting now. A run that was executing stays "running": recover it with npm run gen -- resume <id>');
      process.exit(130);
    }
    console.error(busy ? 'Stopping after the current task (press Ctrl+C again to exit now).' : 'Stopping.');
    stop.abort();
  };
  process.on('SIGINT', onSigint);
  try {
    if (!opts.once) out(`Worker started: checking the queue every ${opts.interval}s. Ctrl+C to stop.`);
    await runWorker({
      db,
      intervalMs: opts.interval * 1000,
      signal: stop.signal,
      once: opts.once,
      log: out,
      // Also finalises here: a run that failed during setup is marked failed by the worker after `execute` throws.
      heartbeat: async () => {
        try {
          await setSetting(db, WORKER_STATUS_KEY, workerStatus(env, models));
        } finally {
          await finaliseBenchmarks(db);
        }
      },
      finalize: () => finaliseBenchmarks(db),
      execute: async (id) => {
        busy = true;
        try {
          return (await executeAndReport(db, env, id)) === 0 ? 'succeeded' : 'failed';
        } finally {
          busy = false;
        }
      },
      executeMission: async (missionId) => {
        busy = true;
        try {
          return await runMission({
            db, router: buildRouter(env, db), fetchPage, log: out, archive: createArchiveClient({ fetchPage }),
            collectors: buildCollectors({ productHuntToken: env.PRODUCTHUNT_TOKEN, stackexchangeKey: env.STACKEXCHANGE_KEY, githubToken: env.GITHUB_TOKEN }),
          }, missionId);
        } finally {
          busy = false;
        }
      },
      executeValidation: async (jobId) => {
        busy = true;
        try {
          return await executeValidationJob(validationDeps(env, db), jobId);
        } finally {
          busy = false;
        }
      },
    });
    return 0;
  } finally {
    process.off('SIGINT', onSigint);
    await closeDb(db);
  }
}

/** `gen research <topic>`: queues a mission for the worker. */
async function researchCommand(topic: string, opts: ResearchCliOpts): Promise<number> {
  const parsed = MissionInputSchema.safeParse({
    topic, ...(opts.kinds ? { kinds: opts.kinds } : {}), ...(opts.countries ? { countries: opts.countries } : {}),
    ...(opts.audience ? { audience: opts.audience } : {}), ...(opts.budget !== undefined ? { budgetUsd: opts.budget } : {}),
  });
  if (!parsed.success) throw new CliError('Topic must be 3 to 200 characters.', 2);
  return withDb(async (db) => {
    const r = await queueMission(db, parsed.data);
    if (!r.ok) {
      console.error('Too many missions are waiting. Start `gen worker` or wait for them to finish.');
      return 1;
    }
    out(`Mission ${r.id} queued: up to $${parsed.data.budgetUsd.toFixed(2)}. Start \`gen worker\` to run it.`);
    return 0;
  });
}

/** `gen research status`: the last 10 missions. */
async function researchStatusCommand(): Promise<number> {
  return withDb(async (db) => {
    const rows = await listMissions(db, 10);
    if (rows.length === 0) {
      out('No research missions yet.');
      return 0;
    }
    for (const m of rows) {
      out(`${m.id}  ${(m.stalled ? 'stalled' : m.status).padEnd(9)} ${m.origin.padEnd(10)} $${m.costUsd.toFixed(2)}/$${m.budgetUsd.toFixed(2)}  +${m.itemsAdded} new, ${m.itemsMerged} merged  ${m.topic}`);
    }
    return 0;
  });
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
    const rows = await listRealRuns(db, 20);
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
      ? await realCaseSlugs(db)
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

/** The deps `runValidation` needs (shared by `gen validate` and the worker's validation jobs). */
function validationDeps(env: Env, db: Db): ValidationDeps {
  return { db, router: buildRouter(env, db), fetchPage, log: out, outDir: VALIDATION_DIR, placesApiKey: env.GOOGLE_PLACES_API_KEY };
}

async function validateCommand(slug: string, opts: ValidateCliOpts): Promise<number> {
  loadDotEnv();
  const env = loadEnv();
  const db = await openDb(env.DATABASE_URL);
  try {
    const kase = await findCase(db, slug);
    if (kase.isExample) throw new CliError(EXAMPLE_REFUSAL, 1);
    const started = new Date();
    const result = await runValidation(validationDeps(env, db), kase.id, opts);
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
    if (kase.isExample) throw new CliError(EXAMPLE_REFUSAL, 1);
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
    if (r.duplicate) {
      out('Already logged: the same note was recorded for this prospect in the last 10 minutes, so it was not recorded again.');
      return 0;
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

// ---- Benchmark ---------------------------------------------------------------------------------------

async function benchBaselineCommand(opts: { force?: boolean; dryRun?: boolean }): Promise<number> {
  return withDb(async (db) => {
    if (opts.dryRun) {
      out(renderScorecardMarkdown([await previewBaseline(db)]));
      out('Dry run: nothing was saved.');
      return 0;
    }
    const r = await saveBaseline(db, { force: opts.force });
    if (!r.ok) {
      console.error('A baseline already exists. Use --force to save another.');
      return 1;
    }
    out(`Saved ${r.pass.label} over ${r.pass.runIds.length} run(s).`);
    return 0;
  });
}

async function benchRunCommand(): Promise<number> {
  return withDb(async (db) => {
    const r = await queueBenchmarkPass(db);
    if (!r.ok) {
      console.error(BENCH_REFUSAL[r.reason]);
      return 1;
    }
    out(`Queued ${r.pass.label} (pass id ${r.pass.id}): ${BENCHMARKS[CURRENT_BENCHMARK].costNote}.`);
    for (const id of r.pass.runIds) out(`  run ${id}`);
    out('Start the worker to execute them: npm run gen -- worker');
    return 0;
  });
}

const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'scorecard';

async function benchReportCommand(passId: string | undefined, opts: { recompute?: boolean }): Promise<number> {
  if (opts.recompute && !passId) throw new CliError('--recompute needs a pass id', 2);
  return withDb(async (db) => {
    await finalizeBenchmarkPasses(db);
    const all = await listBenchmarkPasses(db, 200);
    let passes: PassRow[];
    if (passId) {
      const found = all.find((p) => p.id === passId);
      if (!found) throw new CliError(`No benchmark pass with id: ${passId}`, 1);
      if (opts.recompute) {
        const r = await recomputePass(db, passId);
        if (!r.ok) throw new CliError(r.reason === 'running' ? 'That pass is still running.' : `No benchmark pass with id: ${passId}`, 1);
        passes = [r.pass];
      } else {
        passes = [found];
      }
    } else {
      const baseline = all.filter((p) => p.kind === 'baseline').at(-1);
      // Same order as the Progress page: baseline first, then passes oldest to newest.
      passes = [...(baseline ? [baseline] : []), ...all.filter((p) => p.kind !== 'baseline').slice(0, 5).reverse()];
      if (passes.length === 0) {
        out('No benchmark passes yet. Save a baseline first: npm run gen -- bench baseline');
        return 0;
      }
    }
    const md = renderScorecardMarkdown(passes);
    out(md);
    mkdirSync(BENCH_DIR, { recursive: true });
    const path = join(BENCH_DIR, `${new Date().toISOString().slice(0, 10)}-${slugOf(passes[0]!.label)}.md`);
    writeFileSync(path, md, 'utf8');
    out(`Wrote ${path}`);
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
  worker: workerCommand,
  research: researchCommand,
  researchStatus: researchStatusCommand,
  benchBaseline: benchBaselineCommand,
  benchRun: benchRunCommand,
  benchReport: benchReportCommand,
});

try {
  await program.parseAsync(process.argv);
} catch (err) {
  // Error messages never contain env values: loadEnv reports variable names only, and the router never puts keys in messages.
  console.error(clean(err instanceof Error ? err.message : String(err)));
  process.exitCode = err instanceof CliError ? err.exitCode : 1;
}
