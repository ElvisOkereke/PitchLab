// Shared pg.Pool settings for the CLI/worker pool (db/client) and the web pool (apps/web/lib/db). Web-safe: it imports
// no env loader, PGlite, router or SDK and takes the env values as arguments. No message ever contains the URL, a
// password, the CA path or the rejected value.
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { PoolConfig } from 'pg';

export type PgPoolOptions = {
  /** DATABASE_SSL: auto (default) | verify | disable. */
  ssl?: string;
  /** DATABASE_SSL_CA: absolute path to a PEM file, used as the trusted CA when TLS is on. */
  sslCa?: string;
  /** DATABASE_POOL_MAX: integer 1 to 20. */
  poolMax?: string;
  /** Pool size when DATABASE_POOL_MAX is unset. */
  defaultMax: number;
  /** Reads the CA file (injected by tests). */
  readFile?: (path: string) => string;
};

/**
 * Removed from the URL: pg lets them override the `ssl` option (`sslmode=require` means verify-full in pg 8.23, and
 * `sslnegotiation=direct` replaces the ssl object with `true`, dropping the CA).
 */
const TLS_PARAMS = new Set(['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey', 'sslpassword', 'uselibpqcompat', 'sslnegotiation']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const SSL_MODES = new Set(['auto', 'verify', 'disable']);

const blankToUndefined = (v: string | undefined) => (v === undefined || v.trim() === '' ? undefined : v.trim());

function paramName(pair: string): string {
  const raw = pair.split('=')[0]!.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/** The URL without its TLS query parameters; every other part, including the other parameters, is kept verbatim. */
function stripTlsParams(url: string): string {
  const hashAt = url.indexOf('#');
  const main = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  const q = main.indexOf('?');
  if (q === -1) return url;
  const kept = main.slice(q + 1).split('&').filter((p) => p !== '' && !TLS_PARAMS.has(paramName(p)));
  return `${main.slice(0, q)}${kept.length ? `?${kept.join('&')}` : ''}${hash}`;
}

const normaliseHost = (host: string) => host.replace(/^\[(.+)\]$/, '$1').toLowerCase();
const isLocalHost = (host: string) => LOCAL_HOSTS.has(host) || host.endsWith('.railway.internal');

/**
 * True only when every host pg might connect to is local: the URL host AND each `host` query value (pg-connection-
 * string lets a `host` parameter replace the URL host and keeps the last one). Anything unparseable counts as remote.
 */
function allHostsLocal(url: string): boolean {
  // Same normalisation as pg-connection-string, so a password with a space or a bare % parses the same way.
  const normalised = / |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(url) ? encodeURI(url).replace(/%25(\d\d)/g, '%$1') : url;
  let parsed: URL;
  try {
    parsed = new URL(normalised);
  } catch {
    return false;
  }
  let authority: string;
  try {
    authority = decodeURIComponent(parsed.hostname);
  } catch {
    return false;
  }
  return [authority, ...parsed.searchParams.getAll('host')].every((h) => isLocalHost(normaliseHost(h)));
}

function poolMax(value: string | undefined, fallback: number): number {
  const v = blankToUndefined(value);
  if (v === undefined) return fallback;
  if (!/^\d{1,2}$/.test(v) || Number(v) < 1 || Number(v) > 20) throw new Error('DATABASE_POOL_MAX must be an integer from 1 to 20');
  return Number(v);
}

/**
 * pg.Pool settings for a postgres:// URL. TLS is decided by DATABASE_SSL only (URL TLS parameters are removed):
 * `auto` is plain TCP for localhost / 127.0.0.1 / ::1 / *.railway.internal and verified TLS for every other host,
 * `verify` is always verified TLS, `disable` is plain TCP. There is deliberately no mode that encrypts without
 * verifying the server certificate; a server whose certificate is not publicly trusted is verified with DATABASE_SSL_CA.
 */
export function pgPoolConfig(url: string, opts: PgPoolOptions): PoolConfig {
  const mode = blankToUndefined(opts.ssl) ?? 'auto';
  if (!SSL_MODES.has(mode)) throw new Error('DATABASE_SSL must be one of auto, verify, disable');
  const caPath = blankToUndefined(opts.sslCa);
  if (caPath !== undefined && !isAbsolute(caPath)) throw new Error('DATABASE_SSL_CA must be an absolute path');
  const max = poolMax(opts.poolMax, opts.defaultMax);
  const connectionString = stripTlsParams(url);

  const tls = mode === 'verify' || (mode === 'auto' && !allHostsLocal(connectionString));
  // `false`, not undefined: pg would otherwise fall back to the PGSSLMODE environment variable.
  let ssl: PoolConfig['ssl'] = false;
  if (tls) {
    ssl = { rejectUnauthorized: true };
    if (caPath !== undefined) {
      const read = opts.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
      try {
        ssl.ca = read(caPath);
      } catch {
        throw new Error('DATABASE_SSL_CA could not be read');
      }
    }
  }
  return {
    connectionString, ssl, max,
    connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 30_000,
    // Keep-alive probes from 10 s of silence, so a connection dropped by the pooler or a NAT is noticed.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  };
}
