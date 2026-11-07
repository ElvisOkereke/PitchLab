import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

/** Reads one line from the terminal without echoing what is typed. */
export function askMuted(prompt: string): Promise<string> {
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

/** All lines of piped stdin. */
export async function readPiped(): Promise<string[]> {
  let text = '';
  for await (const chunk of process.stdin) text += String(chunk);
  return text.split(/\r?\n/);
}

/**
 * The new password from a muted double prompt (terminal) or from piped stdin (first line, optional matching second).
 * Returns null after printing why when the two entries differ.
 */
export async function readNewPassword(label: string, againLabel: string): Promise<string | null> {
  if (process.stdin.isTTY) {
    const password = await askMuted(label);
    const again = await askMuted(againLabel);
    if (password !== again) {
      console.error('The two entries differ. Nothing was changed.');
      return null;
    }
    return password;
  }
  const [first = '', second] = await readPiped();
  if (second !== undefined && second !== '' && second !== first) {
    console.error('The two piped lines differ. Nothing was changed.');
    return null;
  }
  return first;
}
