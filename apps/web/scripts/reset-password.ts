// npm run reset-password                      (from the repo root)
// npm run reset-password -- --keep-sessions   (do not sign other devices out)
// Asks for a new owner password twice with echo muted, then rewrites OWNER_PASSWORD_HASH (and SESSION_SECRET) in the
// repo-root .env. The old file is kept as .env.bak. Neither the password, the hash nor the secret is printed.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readNewPassword } from './lib/prompt';
import { findRepoRoot } from './lib/repo-root';
import { resetPassword } from './lib/reset-password-flow';

async function main(): Promise<number> {
  const keepSessions = process.argv.includes('--keep-sessions');
  const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
  const password = await readNewPassword('New password: ', 'Repeat it: ');
  if (password === null) return 1;
  const result = await resetPassword({ repoRoot, password, keepSessions });
  if (!result.ok) {
    console.error(result.message);
    return 1;
  }
  console.log(
    result.sessionsRotated ? 'Password changed. Every device has been signed out.' : 'Password changed. Existing sessions were kept (--keep-sessions).',
  );
  console.log('Restart the web app (npm run web) and log in with the new password.');
  return 0;
}

process.exitCode = await main();
