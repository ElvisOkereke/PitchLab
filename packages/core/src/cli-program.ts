import { Argument, Command, Option } from 'commander';
import type { RunConfig } from './pipeline/types';
import { pilotSiteDomain } from './validation/prospects';

// Command definitions and option parsing, separate from the handlers in cli.ts so they can be tested without a DB or
// network. Handlers return the process exit code.

export class CliError extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
  }
}

export function positiveInt(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new CliError(`Expected a positive whole number, got: ${v}`, 2);
  return n;
}

/** Most prospects one validate run may ask for (cost guard). */
export const MAX_PROSPECTS = 100;
function prospectCount(v: string): number {
  const n = positiveInt(v);
  if (n > MAX_PROSPECTS) throw new CliError(`--prospects is at most ${MAX_PROSPECTS}, got: ${v}`, 2);
  return n;
}

/** --pilot-site must be an http(s) URL with a registrable domain (P3-R21); the value itself is passed on unchanged. */
function pilotSiteArg(v: string): string {
  try {
    pilotSiteDomain(v);
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err), 2);
  }
  return v;
}

export type RunOpts = {
  seed: RunConfig['seedType'];
  sectors?: string; lenses?: string; file?: string; ideas?: string; advance?: string;
};

export type ValidateCliOpts = {
  prospects?: number;
  skipProspects?: boolean;
  source?: 'web_research' | 'places';
  includeWeak?: boolean;
  pilotSite?: string;
  refresh?: boolean;
  redraft?: boolean;
};

export const MARK_TYPES = ['sent', 'replied', 'positive', 'meeting', 'not_interested', 'unsubscribe', 'note'] as const;
export type MarkType = (typeof MARK_TYPES)[number];

export type CliHandlers = {
  run(opts: RunOpts): Promise<number>;
  resume(runId: string): Promise<number>;
  export(slug: string | undefined, opts: { all?: boolean }): Promise<number>;
  runs(): Promise<number>;
  validate(slug: string, opts: ValidateCliOpts): Promise<number>;
  prospectsImport(slug: string, opts: { file: string }): Promise<number>;
  outreachMark(ref: string, type: MarkType, opts: { note?: string }): Promise<number>;
  outreachStatus(slug: string): Promise<number>;
  configSet(key: string, value: string): Promise<number>;
  configGet(key: string | undefined): Promise<number>;
  worker(opts: WorkerCliOpts): Promise<number>;
  benchBaseline(opts: { force?: boolean; dryRun?: boolean }): Promise<number>;
  benchRun(): Promise<number>;
  benchReport(passId: string | undefined, opts: { recompute?: boolean }): Promise<number>;
};

export type WorkerCliOpts = { interval: number; once?: boolean };

/** Why `gen resume` refuses a run with this status, or null when it may resume it (failed or running only). */
export function resumeRefusal(status: 'queued' | 'running' | 'succeeded' | 'failed'): string | null {
  if (status === 'queued') return 'run is queued for the worker; let the worker take it or requeue after it fails';
  if (status === 'succeeded') return 'run already succeeded; nothing to resume';
  return null;
}

/** Seconds between queue checks while idle: a whole number, at least 2. */
export const WORKER_INTERVAL_DEFAULT_S = 10;
function intervalSeconds(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 2) throw new CliError(`--interval must be a whole number of seconds, at least 2, got: ${v}`, 2);
  return n;
}

/** Settings keys the CLI may read or write: `sender.*` and `landing.*` only. */
const CONFIG_KEY = /^(?:sender|landing)\.[A-Za-z][A-Za-z0-9_]*$/;
/** Keys the tool actually reads; others are accepted (prefix rule) with a warning. */
export const KNOWN_CONFIG_KEYS = [
  'sender.name', 'sender.company', 'sender.address', 'sender.contact', 'sender.email', 'landing.formEndpoint', 'landing.privacyContact',
] as const;
const CONFIG_VALUE_MAX = 500;

export function checkConfigKey(key: string): void {
  if (!CONFIG_KEY.test(key)) throw new CliError(`Only settings keys starting "sender." or "landing." are accepted (e.g. sender.name), got: ${key}`, 2);
}

export function checkConfigValue(key: string, value: string): void {
  if (value.length > CONFIG_VALUE_MAX) throw new CliError(`Value for ${key} is too long (max ${CONFIG_VALUE_MAX} characters)`, 2);
  if (key === 'landing.formEndpoint' && value.trim() !== '') {
    let ok = false;
    try {
      const u = new URL(value.trim());
      ok = (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
    } catch {
      ok = false;
    }
    if (!ok) throw new CliError('landing.formEndpoint must be an http(s) URL', 2);
  }
}

export function buildProgram(h: CliHandlers): Command {
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
      process.exitCode = await h.run(opts);
    });

  program.command('resume')
    .description('Resume a failed run from its failed stage')
    .argument('<runId>')
    .action(async (runId: string) => {
      process.exitCode = await h.resume(runId);
    });

  program.command('worker')
    .description('Execute runs queued from the dashboard, oldest first (Ctrl+C: stop after the current run; twice: exit now)')
    .option('--interval <seconds>', `seconds between queue checks while idle (default ${WORKER_INTERVAL_DEFAULT_S}, minimum 2)`, intervalSeconds, WORKER_INTERVAL_DEFAULT_S)
    .option('--once', 'check the queue once (execute at most one queued run), then exit')
    .action(async (opts: WorkerCliOpts) => {
      process.exitCode = await h.worker(opts);
    });

  program.command('export')
    .description('Export case(s) as Markdown to output/cases/<slug>.md')
    .argument('[slug]')
    .option('--all', 'export every case')
    .action(async (slug: string | undefined, opts: { all?: boolean }) => {
      process.exitCode = await h.export(slug, opts);
    });

  program.command('runs')
    .description('List recent runs')
    .action(async () => {
      process.exitCode = await h.runs();
    });

  program.command('validate')
    .description('Build the validation pack for a case: docs, prospects, emails, outreach drafts, landing page; export to output/validation/<slug>/')
    .argument('<case>', 'case slug')
    .option('--prospects <n>', `most prospects to look for (default 25, max ${MAX_PROSPECTS})`, prospectCount)
    .option('--skip-prospects', 'do not look for new prospects (existing ones still get emails and drafts)')
    .addOption(new Option('--source <source>', 'prospect source').choices(['web_research', 'places']))
    .option('--include-weak', 'also draft and export emails whose CASL basis is not self-published')
    .option('--pilot-site <url>', 'http(s) URL of the site named in the pilot plan (never fetched, contacted, listed or exported)', pilotSiteArg)
    .option('--refresh', 'regenerate the pack and landing page even if they exist')
    .option('--redraft', 'regenerate outreach drafts of prospects not yet contacted (status new or drafted; replaces edited drafts; status and tracking kept)')
    .action(async (slug: string, opts: ValidateCliOpts) => {
      process.exitCode = await h.validate(slug, opts);
    });

  const prospectsCmd = program.command('prospects').description('Manage prospects');
  prospectsCmd.command('import')
    .description('Import prospects from a CSV (name,website required; email,email_source_url,contact_name,contact_role,location optional)')
    .argument('<case>', 'case slug')
    .requiredOption('--file <csv>', 'CSV file')
    .action(async (slug: string, opts: { file: string }) => {
      process.exitCode = await h.prospectsImport(slug, opts);
    });

  const outreachCmd = program.command('outreach').description('Track outreach you sent yourself (this tool never sends email)');
  outreachCmd.command('mark')
    .description('Record an outreach event for a prospect (id or email); "unsubscribe" also suppresses the address')
    .argument('<prospect>', 'prospect id or email address')
    .addArgument(new Argument('<type>', 'event type').choices([...MARK_TYPES]))
    .option('--note <text>', 'a note (required for "note"; start it with "interview:" to count an interview)')
    .action(async (ref: string, type: MarkType, opts: { note?: string }) => {
      if (type === 'note' && !opts.note?.trim()) throw new CliError('"note" needs --note <text>', 2);
      process.exitCode = await h.outreachMark(ref, type, opts);
    });
  outreachCmd.command('status')
    .description('Outreach counts and checklist status for a case')
    .argument('<case>', 'case slug')
    .action(async (slug: string) => {
      process.exitCode = await h.outreachStatus(slug);
    });

  const configCmd = program.command('config').description('Sender identity and landing settings (keys starting sender. or landing.)');
  configCmd.command('set')
    .description(`Set a setting (${KNOWN_CONFIG_KEYS.join(', ')})`)
    .argument('<key>')
    .argument('<value>')
    .action(async (key: string, value: string) => {
      checkConfigKey(key);
      checkConfigValue(key, value);
      process.exitCode = await h.configSet(key, value);
    });
  configCmd.command('get')
    .description('Show one setting, or all sender./landing. settings')
    .argument('[key]')
    .action(async (key: string | undefined) => {
      if (key !== undefined) checkConfigKey(key);
      process.exitCode = await h.configGet(key);
    });

  const benchCmd = program.command('bench').description('Idea-quality benchmark: baseline, passes and the scorecard');
  benchCmd.command('baseline')
    .description("Freeze today's scorecard over every finished real run as baseline-N")
    .option('--force', 'add another baseline even if one exists')
    .option('--dry-run', 'print the scorecard without saving anything')
    .action(async (opts: { force?: boolean; dryRun?: boolean }) => {
      process.exitCode = await h.benchBaseline(opts);
    });
  benchCmd.command('run')
    .description('Queue the benchmark runs (costs model calls; start `gen worker` to execute them)')
    .action(async () => {
      process.exitCode = await h.benchRun();
    });
  benchCmd.command('report')
    .description('Print and write the scorecard (baseline plus the newest passes, or one pass) to output/bench/')
    .argument('[passId]', 'a pass id')
    .option('--recompute', "freeze a new snapshot of that pass with today's data first")
    .action(async (passId: string | undefined, opts: { recompute?: boolean }) => {
      process.exitCode = await h.benchReport(passId, opts);
    });

  return program;
}
