// npm run db:copy -- [--from pglite://.data/pglite] [--to <postgres url>] [--dry-run]
// One-time copy of the local PGlite database into Postgres. Never writes to the source. The target URL (it holds a
// password) is never printed.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { count, getTableName, sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { createDb, type Db } from '../src/db/client';
import { allTables, assertSameMigrations, copyDatabase, tableCopyOrder } from '../src/db/copy';
import { runMigrations } from '../src/db/migrate';
import { scrubSecrets } from '../src/tools/scrub';

const USAGE = 'Usage: npm run db:copy -- [--from pglite://.data/pglite] [--to postgres://...] [--dry-run]';
const BEHIND = 'Local DB is behind the code: run any gen command once with DATABASE_URL=pglite://.data/pglite to migrate it';

export type CopyArgs =
  | { ok: true; from: string; to: string; dryRun: boolean }
  | { ok: false; exitCode: 2; message: string };

const fail = (message: string): CopyArgs => ({ ok: false, exitCode: 2, message: `${message}\n${USAGE}` });

/** Parses the flags. `--to` defaults to DATABASE_URL and must be postgres://; `--from` is a PGlite folder resolved against `baseDir`. */
export function parseCopyArgs(argv: string[], env: Record<string, string | undefined>, baseDir: string): CopyArgs {
  let from = 'pglite://.data/pglite';
  let to = env.DATABASE_URL ?? '';
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dry-run') dryRun = true;
    else if (a === '--from' || a === '--to') {
      const v = argv[++i];
      if (v === undefined) return fail(`${a} needs a value.`);
      if (a === '--from') from = v;
      else to = v;
    } else return fail('Unknown argument (expected --from, --to or --dry-run).'); // never echoed: it may be a URL
  }
  if (!/^postgres(?:ql)?:\/\//.test(to)) return fail('--to (default DATABASE_URL) must be a postgres:// or postgresql:// URL.');
  if (!from.startsWith('pglite://')) return fail('--from must be a pglite://<folder> URL.');
  const dir = from.slice('pglite://'.length);
  if (!dir || dir === 'memory') return fail('--from must name a PGlite folder.');
  return { ok: true, from: `pglite://${resolve(baseDir, dir)}`, to, dryRun };
}

async function closeDb(db: Db): Promise<void> {
  const client = (db as unknown as { $client: { close?: () => Promise<void>; end?: () => Promise<void> } }).$client;
  if (client.close) await client.close();
  else if (client.end) await client.end();
}

function printTable(rows: string[][]): void {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  for (const r of rows) console.log(r.map((v, i) => v.padEnd(widths[i]!)).join('  ').trimEnd());
}

async function main(): Promise<number> {
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const envFile = resolve(baseDir, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const args = parseCopyArgs(process.argv.slice(2), process.env, baseDir);
  if (!args.ok) {
    console.error(args.message);
    return args.exitCode;
  }
  const dir = args.from.slice('pglite://'.length);
  if (!existsSync(dir)) {
    console.error(`No PGlite database at ${dir}`);
    return 2;
  }
  console.error('Make sure no other process (gen, gen worker, the dashboard) has the PGlite folder open while this runs.');

  const src = await createDb(args.from);
  try {
    if (args.dryRun) {
      // Checks only: nothing is written to either database.
      const code = readMigrationFiles({ migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) }).map((m) => m.hash);
      const have = await src.execute(sql`select hash from drizzle.__drizzle_migrations order by id`)
        .then((res) => (res as unknown as { rows: { hash: string }[] }).rows.map((r) => r.hash), () => [] as string[]);
      const current = have.length === code.length && have.every((h, i) => h === code[i]);
      console.log(current ? 'Source migrations match the code.' : BEHIND);
      const rows = [['TABLE', 'SOURCE ROWS']];
      for (const t of tableCopyOrder(allTables)) {
        const n = await src.select({ n: count() }).from(t).then((r) => String(r[0]?.n ?? 0), () => 'missing (migrate first)');
        rows.push([getTableName(t), n]);
      }
      printTable(rows);
      console.log('Dry run: nothing was copied.');
      return current ? 0 : 2;
    }

    const dst = await createDb(args.to);
    try {
      await runMigrations(dst);
      try {
        await assertSameMigrations(src, dst);
      } catch (err) {
        console.error(String(err instanceof Error ? err.message : err).includes('behind')
          ? BEHIND
          : 'The local DB and the target recorded different migrations. Update the code (git pull) and run again. If the counts '
            + 'match, the hashes differ: check that packages/core/drizzle/*.sql have LF line endings (git ls-files --eol), and '
            + 'restore any CRLF file from git before migrating the target.');
        return 2;
      }
      const report = await copyDatabase(src, dst);
      printTable([
        ['TABLE', 'SOURCE', 'INSERTED', 'TARGET', 'OK'],
        ...report.map((r) => [r.table, String(r.source), String(r.inserted), String(r.target), r.ok ? 'ok' : 'MISMATCH']),
      ]);
      const bad = report.filter((r) => !r.ok);
      if (bad.length) {
        console.error(`Target row counts differ from the source for: ${bad.map((r) => r.table).join(', ')}`);
        return 1;
      }
      console.log('Copy complete: every table matches.');
      return 0;
    } finally {
      await closeDb(dst);
    }
  } finally {
    await closeDb(src);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exitCode = await main();
  } catch (err) {
    // Connection errors may carry a URL: scrub before printing.
    console.error(scrubSecrets(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  }
}
