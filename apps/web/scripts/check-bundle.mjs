// npm run check-bundle -w apps/web   (after `npm run build -w apps/web`, with the same web env as the build)
// Searches every file the browser can download (apps/web/.next/static) for the secrets this app holds and for
// server-only markers. Prints file names and labels only, never a value. Exit 0 = no hits, 1 = hits, 2 = no build.
//   Secrets (process env first, else the repo-root .env, read only to search): SESSION_SECRET, OWNER_PASSWORD_HASH,
//   DATABASE_URL and its password, LLM_API_KEY, YOUTUBE_API_KEY, ACCEPT_PASSWORD when set.
//   Markers: postgres://, postgresql://, drizzle, pglite, scrypt:, playwright (the optional local browser is core-only)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = resolve(webRoot, '..', '..');

const MARKERS = ['postgres://', 'postgresql://', 'drizzle', 'pglite', 'scrypt:', 'playwright'];
/** Values shorter than this are too generic to search for (they would match ordinary words). */
const MIN_SECRET_LENGTH = 8;

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

/** The password part of a postgres URL, or undefined. */
function dbPassword(url) {
  try {
    return decodeURIComponent(new URL(url).password) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The repo-root .env overlaid by the process env (the process env wins, as with Next and the CLI). Empty values count
 * as unset.
 */
export function loadEnv(processEnv = process.env) {
  const file = join(repoRoot, '.env');
  const fromFile = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  const merged = { ...fromFile };
  for (const [k, v] of Object.entries(processEnv)) if (v !== undefined && v !== '') merged[k] = v;
  for (const [k, v] of Object.entries(merged)) if (v === '') delete merged[k];
  return merged;
}

/** Labelled needles: every secret that is set and long enough, plus the fixed markers. */
export function bundleNeedles(env = loadEnv()) {
  const secrets = {
    SESSION_SECRET: env.SESSION_SECRET,
    OWNER_PASSWORD_HASH: env.OWNER_PASSWORD_HASH,
    DATABASE_URL: env.DATABASE_URL,
    'DATABASE_URL password': env.DATABASE_URL ? dbPassword(env.DATABASE_URL) : undefined,
    LLM_API_KEY: env.LLM_API_KEY,
    YOUTUBE_API_KEY: env.YOUTUBE_API_KEY,
    ACCEPT_PASSWORD: env.ACCEPT_PASSWORD,
  };
  const needles = [];
  const skipped = [];
  for (const [label, value] of Object.entries(secrets)) {
    if (typeof value === 'string' && value.length >= MIN_SECRET_LENGTH) needles.push({ label, value });
    else skipped.push(label);
  }
  for (const m of MARKERS) needles.push({ label: `marker ${m}`, value: m, caseInsensitive: true });
  return { needles, skipped };
}

/** Scans `.next/static`; returns the hits as `{ file, label }` (never the value). */
export function checkBundle(env = loadEnv(), staticDir = join(webRoot, '.next', 'static')) {
  if (!existsSync(staticDir)) return { ok: false, missing: true, files: 0, hits: [], skipped: [] };
  const { needles, skipped } = bundleNeedles(env);
  const files = walk(staticDir);
  const hits = [];
  for (const f of files) {
    const text = readFileSync(f).toString('latin1');
    const lower = text.toLowerCase();
    for (const n of needles) {
      const found = n.caseInsensitive ? lower.includes(n.value.toLowerCase()) : text.includes(n.value);
      if (found) hits.push({ file: relative(webRoot, f), label: n.label });
    }
  }
  return { ok: hits.length === 0, missing: false, files: files.length, hits, skipped, needles: needles.map((n) => n.label) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = checkBundle();
  if (r.missing) {
    console.error('No apps/web/.next/static: run npm run build -w apps/web first.');
    process.exitCode = 2;
  } else {
    console.log(`Scanned ${r.files} files under .next/static for: ${r.needles.join(', ')}`);
    if (r.skipped.length) console.log(`Not set (or too short to search), skipped: ${r.skipped.join(', ')}`);
    for (const h of r.hits) console.log(`HIT ${h.label} in ${h.file}`);
    console.log(r.ok ? 'check-bundle: 0 hits' : `check-bundle: ${r.hits.length} hit(s)`);
    process.exitCode = r.ok ? 0 : 1;
  }
}
