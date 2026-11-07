import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashPassword } from '../../lib/auth/password';
import { setEnvValues } from './env-file';

export const MIN_PASSWORD_LENGTH = 12;

export type ResetResult = { ok: true; sessionsRotated: boolean } | { ok: false; message: string };

/**
 * Sets a new OWNER_PASSWORD_HASH in `<repoRoot>/.env` (and a fresh SESSION_SECRET unless keepSessions, which signs every
 * device out). Backs the old file up to .env.bak first and writes atomically. Never returns or prints the hash or secret.
 */
export async function resetPassword(opts: { repoRoot: string; password: string; keepSessions: boolean }): Promise<ResetResult> {
  const envPath = join(opts.repoRoot, '.env');
  if (!existsSync(envPath)) {
    return { ok: false, message: `No .env found in ${opts.repoRoot}. Copy .env.example to .env first, then run this again.` };
  }
  if (opts.password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, message: `The password must be at least ${MIN_PASSWORD_LENGTH} characters. Nothing was changed.` };
  }
  const values: Record<string, string> = { OWNER_PASSWORD_HASH: await hashPassword(opts.password) };
  if (!opts.keepSessions) values.SESSION_SECRET = randomBytes(32).toString('base64url');

  const updated = setEnvValues(readFileSync(envPath, 'utf8'), values);
  copyFileSync(envPath, join(opts.repoRoot, '.env.bak'));
  const tmp = join(opts.repoRoot, `.env.tmp-${process.pid}`);
  try {
    writeFileSync(tmp, updated, { mode: 0o600 });
    renameSync(tmp, envPath);
  } finally {
    rmSync(tmp, { force: true });
  }
  return { ok: true, sessionsRotated: !opts.keepSessions };
}
