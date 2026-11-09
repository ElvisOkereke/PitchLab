// npm run capture:login
// Opens a headed Chromium on the user data dir .data/capture/browser with Instagram and TikTok tabs so the owner can log
// in to the throwaway accounts once. yt-dlp later reads the cookies of its Default profile (Instagram, Facebook and
// TikTok only), passed as .data/capture/browser/Default so yt-dlp finds Local State in the parent. Uses the optional
// playwright-core; when it or its Chromium is missing, prints how to install it. Close the window when done.
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureBrowserDirs } from '../src/paths';

interface PageLike {
  goto(url: string): Promise<unknown>;
}
interface ContextLike {
  pages(): PageLike[];
  newPage(): Promise<PageLike>;
  on(event: 'close', fn: () => void): unknown;
}
interface ChromiumLike {
  executablePath(): string;
  launchPersistentContext(dir: string, options: Record<string, unknown>): Promise<ContextLike>;
}

const PLAYWRIGHT = 'playwright-core';
const INSTALL_HINT = 'Install the browser with `npx playwright-core install chromium` (run in packages/capture), then try again.';
export const LOGIN_URLS = ['https://www.instagram.com/', 'https://www.tiktok.com/'];

export interface LoginOptions {
  /** Chromium's persistent user data dir (`.data/capture/browser`); the logins land in its `Default` profile. */
  userDataDir: string;
  importer?: () => Promise<unknown>;
  log?: (line: string) => void;
}

/** Resolves true once the owner closes the window; false when the browser is unavailable. */
export async function runLogin(opts: LoginOptions): Promise<boolean> {
  const log = opts.log ?? ((l: string) => console.log(l));
  let chromium: ChromiumLike | undefined;
  try {
    // A non-literal specifier keeps tsc and bundlers from resolving the optional package.
    const name = PLAYWRIGHT;
    const mod = (await (opts.importer ? opts.importer() : import(/* @vite-ignore */ name))) as {
      chromium?: ChromiumLike;
      default?: { chromium?: ChromiumLike };
    };
    chromium = mod?.chromium ?? mod?.default?.chromium;
  } catch {
    chromium = undefined;
  }
  if (!chromium || typeof chromium.launchPersistentContext !== 'function') {
    log(`playwright-core is not installed. ${INSTALL_HINT}`);
    return false;
  }
  let exe = '';
  try {
    exe = chromium.executablePath();
  } catch {
    exe = '';
  }
  if (!exe || !existsSync(exe)) {
    log(`Chromium for playwright-core is not installed. ${INSTALL_HINT}`);
    return false;
  }
  await mkdir(opts.userDataDir, { recursive: true });
  let context: ContextLike;
  try {
    context = await chromium.launchPersistentContext(opts.userDataDir, { headless: false, viewport: null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const locked = /ProcessSingleton|already in use|lock/i.test(msg);
    log(
      locked
        ? 'The capture profile is in use. Close the capture browser and stop the worker (it may be capturing), then run capture:login again.'
        : `Chromium could not start (${msg.split('\n')[0].slice(0, 200)}). Close the capture browser and stop the worker if either is running, then try again. ${INSTALL_HINT}`,
    );
    return false;
  }
  const closed = new Promise<void>((r) => context.on('close', () => r()));
  const first = context.pages()[0] ?? (await context.newPage());
  await first.goto(LOGIN_URLS[0]).catch(() => null);
  const second = await context.newPage();
  await second.goto(LOGIN_URLS[1]).catch(() => null);
  log('Log in to the throwaway Instagram and TikTok accounts in the window, then close it.');
  await closed;
  log('Saved. The capture profile keeps the logins.');
  return true;
}

async function main() {
  const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
  const ok = await runLogin({ userDataDir: captureBrowserDirs(root).userDataDir });
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
