// npm run hash-password -w apps/web
// Reads the owner password twice from the terminal with echo muted (or once from piped stdin) and prints only the
// scrypt hash line for .env. The password itself is never printed or logged.
// To change the password of an existing install, `npm run reset-password` does this and edits .env for you.
import { hashPassword } from '../lib/auth/password';
import { MIN_PASSWORD_LENGTH } from './lib/reset-password-flow';
import { readNewPassword } from './lib/prompt';

async function main(): Promise<number> {
  const password = await readNewPassword('Owner password: ', 'Repeat it: ');
  if (password === null) return 1;
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`The password must be at least ${MIN_PASSWORD_LENGTH} characters. Nothing was printed.`);
    return 1;
  }
  const hash = await hashPassword(password);
  console.log(hash);
  console.error('\nPaste it into the repo-root .env as OWNER_PASSWORD_HASH=<the line above>.');
  console.error('SESSION_SECRET (if not set yet): node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"');
  return 0;
}

process.exitCode = await main();
