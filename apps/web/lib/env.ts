import 'server-only';
import { z } from 'zod';

export type WebEnv = {
  /** postgres:// or postgresql:// only (PGlite is single-process and cannot be shared with the worker). */
  DATABASE_URL: string;
  /** `scrypt:N:r:p:salt:key` (':' separators, because @next/env expands `$NAME` in .env values). */
  OWNER_PASSWORD_HASH: string;
  /** HS256 key for the session JWT, at least 32 characters. Rotating it logs out every device. */
  SESSION_SECRET: string;
  /** Reverse proxies in front of the app whose X-Forwarded-For entry is trusted (0 = ignore the header). */
  TRUST_PROXY_HOPS: number;
  /** Extra hosts (host[:port]) that may post Server Actions, e.g. a tunnel host. */
  ALLOWED_ORIGINS: string[];
  /** Secure session cookie (`__Host-` prefix); defaults to NODE_ENV === 'production'. */
  COOKIE_SECURE: boolean;
};

const HASH = /^scrypt:\d+:\d+:\d+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

// Every message is written here, so no zod default (which might quote input) ever reaches the error text.
const Schema = z.object({
  DATABASE_URL: z.string({ error: 'required' }).refine((v) => /^postgres(ql)?:\/\//.test(v), 'must be a postgres:// or postgresql:// URL'),
  OWNER_PASSWORD_HASH: z.string({ error: 'required' }).regex(HASH, 'must be scrypt:N:r:p:salt:key (run npm run hash-password -w apps/web)'),
  SESSION_SECRET: z.string({ error: 'required' }).min(32, 'must be at least 32 characters'),
  TRUST_PROXY_HOPS: z.preprocess(blankToUndefined, z.string().regex(/^[0-3]$/, 'must be an integer from 0 to 3').optional())
    .transform((v) => (v === undefined ? 0 : Number(v))),
  ALLOWED_ORIGINS: z.preprocess(blankToUndefined, z.string().optional())
    .transform((v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
  COOKIE_SECURE: z.preprocess(blankToUndefined, z.enum(['true', 'false', '1', '0'], { error: 'must be true or false' }).optional()),
  ALLOW_INSECURE_COOKIE: z.preprocess(blankToUndefined, z.enum(['true', 'false', '1', '0'], { error: 'must be true or false' }).optional()),
  NODE_ENV: z.string().optional(),
});

const isTrue = (v: string | undefined) => v === 'true' || v === '1';

/** Parses the web app's env. Errors name the variables and the rule, never a value. */
export function parseWebEnv(raw: Record<string, string | undefined>): WebEnv {
  const r = Schema.safeParse(raw);
  if (!r.success) {
    const problems = r.error.issues.map((i) => `${String(i.path[0] ?? '?')} (${i.message})`);
    throw new Error(`Invalid web environment: ${problems.join(', ')}`);
  }
  const { NODE_ENV, COOKIE_SECURE, ALLOW_INSECURE_COOKIE, ...env } = r.data;
  const production = NODE_ENV === 'production';
  const secure = COOKIE_SECURE === undefined ? production : isTrue(COOKIE_SECURE);
  // Fail closed: a plain-http session cookie in production needs a second, explicit opt-in (e.g. `next start` on localhost).
  if (production && !secure && !isTrue(ALLOW_INSECURE_COOKIE)) {
    throw new Error('Invalid web environment: COOKIE_SECURE (false in production; set ALLOW_INSECURE_COOKIE=true only for http on localhost)');
  }
  return { ...env, COOKIE_SECURE: secure };
}

let cached: WebEnv | undefined;

/** The parsed env, read once from process.env. */
export function webEnv(): WebEnv {
  cached ??= parseWebEnv(process.env);
  return cached;
}
