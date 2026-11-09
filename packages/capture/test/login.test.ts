import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLogin } from '../scripts/login';
import { captureBrowserDirs } from '../src/paths';
import { defaultCaptureDirs } from '../src/index';

function fakeChromium() {
  const pages: { goto: ReturnType<typeof vi.fn> }[] = [];
  let closeHandler: (() => void) | undefined;
  const context = {
    pages: () => pages,
    newPage: vi.fn(async () => {
      const p = { goto: vi.fn(async () => null) };
      pages.push(p);
      return p;
    }),
    on: vi.fn((event: string, fn: () => void) => {
      if (event === 'close') closeHandler = fn;
    }),
  };
  const chromium = {
    executablePath: () => process.execPath,
    launchPersistentContext: vi.fn(async () => context),
  };
  return { chromium, context, pages, close: () => closeHandler?.() };
}

describe('runLogin', () => {
  it('opens a headed Chromium on the capture profile with Instagram and TikTok tabs, and waits for the window to close', async () => {
    const f = fakeChromium();
    let done = false;
    const userDataDir = join(mkdtempSync(join(tmpdir(), 'bcg-login-test-')), '.data', 'capture', 'browser');
    const p = runLogin({ userDataDir, importer: async () => ({ chromium: f.chromium }), log: () => {} }).then((r) => {
      done = true;
      return r;
    });
    await vi.waitFor(() => expect(f.pages).toHaveLength(2));
    expect(f.chromium.launchPersistentContext).toHaveBeenCalledWith(userDataDir, expect.objectContaining({ headless: false }));
    expect(f.pages.map((pg) => pg.goto.mock.calls[0][0])).toEqual(['https://www.instagram.com/', 'https://www.tiktok.com/']);
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    f.close();
    expect(await p).toBe(true);
    rmSync(join(userDataDir, '..', '..', '..'), { recursive: true, force: true });
  });

  it('explains how to install Chromium when playwright-core is missing', async () => {
    const log = vi.fn();
    const ok = await runLogin({ userDataDir: 'x', importer: async () => Promise.reject(new Error('Cannot find module')), log });
    expect(ok).toBe(false);
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toMatch(/playwright-core install chromium/);
  });

  it('explains a locked profile instead of crashing when the launch fails', async () => {
    const f = fakeChromium();
    f.chromium.launchPersistentContext.mockRejectedValueOnce(new Error('Failed to create a ProcessSingleton for your profile directory'));
    const log = vi.fn();
    const userDataDir = join(mkdtempSync(join(tmpdir(), 'bcg-login-test-')), 'p');
    const ok = await runLogin({ userDataDir, importer: async () => ({ chromium: f.chromium }), log });
    expect(ok).toBe(false);
    expect(log.mock.calls.map((c) => c[0]).join(' ')).toMatch(/close the capture browser.*stop the worker/i);
    rmSync(join(userDataDir, '..'), { recursive: true, force: true });
  });
});

describe('capture browser folders', () => {
  it('login uses the user data dir .data/capture/browser; yt-dlp reads its Default profile (parent = the user data dir)', () => {
    const root = join('R:', 'repo');
    expect(captureBrowserDirs(root)).toEqual({ userDataDir: join(root, '.data', 'capture', 'browser'), profileDir: join(root, '.data', 'capture', 'browser', 'Default') });
    expect(defaultCaptureDirs(root).profileDir).toBe(join(root, '.data', 'capture', 'browser', 'Default'));
  });
});
