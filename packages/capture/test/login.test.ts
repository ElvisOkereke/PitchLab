import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLogin } from '../scripts/login';

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
    const profileDir = join(mkdtempSync(join(tmpdir(), 'bcg-login-test-')), '.data', 'capture-profile');
    const p = runLogin({ profileDir, importer: async () => ({ chromium: f.chromium }), log: () => {} }).then((r) => {
      done = true;
      return r;
    });
    await vi.waitFor(() => expect(f.pages).toHaveLength(2));
    expect(f.chromium.launchPersistentContext).toHaveBeenCalledWith(profileDir,expect.objectContaining({ headless: false }));
    expect(f.pages.map((pg) => pg.goto.mock.calls[0][0])).toEqual(['https://www.instagram.com/', 'https://www.tiktok.com/']);
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false);
    f.close();
    expect(await p).toBe(true);
    rmSync(join(profileDir, '..', '..'), { recursive: true, force: true });
  });

  it('explains how to install Chromium when playwright-core is missing', async () => {
    const log = vi.fn();
    const ok = await runLogin({ profileDir: 'x', importer: async () => Promise.reject(new Error('Cannot find module')), log });
    expect(ok).toBe(false);
    expect(log.mock.calls.map((c) => c[0]).join('\n')).toMatch(/playwright-core install chromium/);
  });

  it('explains a locked profile instead of crashing when the launch fails', async () => {
    const f = fakeChromium();
    f.chromium.launchPersistentContext.mockRejectedValueOnce(new Error('Failed to create a ProcessSingleton for your profile directory'));
    const log = vi.fn();
    const profileDir = join(mkdtempSync(join(tmpdir(), 'bcg-login-test-')), 'p');
    const ok = await runLogin({ profileDir, importer: async () => ({ chromium: f.chromium }), log });
    expect(ok).toBe(false);
    expect(log.mock.calls.map((c) => c[0]).join(' ')).toMatch(/close the capture browser.*stop the worker/i);
    rmSync(join(profileDir, '..'), { recursive: true, force: true });
  });
});
