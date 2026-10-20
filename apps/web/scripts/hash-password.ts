// npm run hash-password -w apps/web
// Reads the owner password twice from the terminal with echo muted (or once from piped stdin) and prints only the
// scrypt hash line for .env. The password itself is never printed or logged.
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { hashPassword } from '../lib/auth/password';

const MIN_LENGTH = 12;

/** Reads one line from the terminal without echoing what is typed. */
function askMuted(prompt: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function readPiped(): Promise<string[]> {
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text.split(/\r?\n/);
}

async function main(): Promise<number> {
  let password: string;
  if (process.stdin.isTTY) {
    password = await askMuted('Owner password: ');
    const again = await askMuted('Repeat it: ');
    if (password !== again) {
      console.error('The two entries differ. Nothing was printed.');
      return 1;
    }
  } else {
    const [first = '', second] = await readPiped();
    if (second !== undefined && second !== '' && second !== first) {
      console.error('The two piped lines differ. Nothing was printed.');
      return 1;
    }
    password = first;
  }
  if (password.length < MIN_LENGTH) {
    console.error(`The password must be at least ${MIN_LENGTH} characters. Nothing was printed.`);
    return 1;
  }
  const hash = await hashPassword(password);
  console.log(hash);
  console.error('\nPaste it into the repo-root .env as OWNER_PASSWORD_HASH=<the line above>.');
  console.error('SESSION_SECRET (if not set yet): node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"');
  return 0;
}

process.exitCode = await main();
