// The local browser renderer with Playwright mocked (no Chromium, no network).
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeRenderer, createRenderer, loadBrowser, openMissionBrowser, type BrowserLike } from '../../../src/research/browser/render';
import { USER_AGENT } from '../../../src/research/http';

type Handler = (route: any) => unknown;

function mockRoute(method: string, resourceType: string) {
  return { request: () => ({ method: () => method, resourceType: () => resourceType }), abort: vi.fn(async () => {}), continue: vi.fn(async () => {}) };
}

function mockBrowser(opts: { gotoImpl?: (url: string, o: any) => Promise<any>; html?: string; finalUrl?: string } = {}) {
  const routes: Handler[] = [];
  const pages: any[] = [];
  const launches: { dir: string; options: any }[] = [];
  const context = {
    route: vi.fn(async (_p: string, h: Handler) => void routes.push(h)),
    newPage: vi.fn(async () => {
      const listeners: Record<string, ((x: any) => void)[]> = {};
      let current = 'about:blank';
      const page = {
        on: vi.fn((ev: string, fn: (x: any) => void) => void (listeners[ev] ??= []).push(fn)),
        route: vi.fn(async (_p: string, h: Handler) => void routes.push(h)),
        goto: vi.fn(async (url: string, o: any) => {
          const r = opts.gotoImpl ? await opts.gotoImpl(url, o) : { status: () => 200 };
          current = opts.finalUrl ?? url;
          return r;
        }),
        waitForLoadState: vi.fn(async () => {}),
        content: vi.fn(async () => opts.html ?? '<html><body><p>rendered</p></body></html>'),
        url: () => current,
        close: vi.fn(async () => {}),
        emit: (ev: string, x: any) => (listeners[ev] ?? []).forEach((f) => f(x)),
      };
      pages.push(page);
      return page;
    }),
    close: vi.fn(async () => {}),
  };
  const browser: BrowserLike = {
    executablePath: () => 'C:/fake/chrome.exe',
    launchPersistentContext: vi.fn(async (dir: string, options: any) => {
      launches.push({ dir, options });
      return context as any;
    }),
  };
  return { browser, context, routes, pages, launches };
}

const proxy = { port: 54321 };
const renderers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  while (renderers.length) await renderers.pop()!.close();
});
const make = (b: BrowserLike) => {
  const r = createRenderer(b, proxy);
  renderers.push(r);
  return r;
};

describe('createRenderer', () => {
  it('launches one temporary-profile context through the guarded proxy with the research identity', async () => {
    const m = mockBrowser();
    const r = make(m.browser);
    await r.render('https://spa.example/a');
    await r.render('https://spa.example/b');
    expect(m.launches).toHaveLength(1);
    const { dir, options } = m.launches[0]!;
    expect(options).toMatchObject({
      headless: true,
      proxy: { server: 'http://127.0.0.1:54321', bypass: '' },
      userAgent: USER_AGENT,
      acceptDownloads: false,
      javaScriptEnabled: true,
      serviceWorkers: 'block',
    });
    expect(options.args).toEqual(expect.arrayContaining(['--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp']));
    expect(dir.startsWith(tmpdir())).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });

  it('returns the rendered html and the final url', async () => {
    const m = mockBrowser({ html: '<html><body><p>hi</p></body></html>', finalUrl: 'https://spa.example/final' });
    const r = make(m.browser);
    expect(await r.render('https://spa.example/a')).toEqual({ html: '<html><body><p>hi</p></body></html>', finalUrl: 'https://spa.example/final' });
    expect(m.pages[0].close).toHaveBeenCalled();
  });

  it('aborts non-GET requests and images, media and fonts; continues GET documents, scripts, xhr', async () => {
    const m = mockBrowser();
    const r = make(m.browser);
    await r.render('https://spa.example/a');
    expect(m.routes.length).toBeGreaterThan(0);
    const handle = async (method: string, type: string) => {
      const route = mockRoute(method, type);
      for (const h of m.routes) await h(route);
      return route;
    };
    for (const [method, type] of [['POST', 'xhr'], ['PUT', 'fetch'], ['DELETE', 'fetch'], ['HEAD', 'document'], ['GET', 'image'], ['GET', 'media'], ['GET', 'font']] as const) {
      const route = await handle(method, type);
      expect(route.abort, `${method} ${type}`).toHaveBeenCalled();
      expect(route.continue, `${method} ${type}`).not.toHaveBeenCalled();
    }
    for (const type of ['document', 'script', 'xhr', 'fetch', 'stylesheet']) {
      const route = await handle('GET', type);
      expect(route.continue, type).toHaveBeenCalled();
      expect(route.abort, type).not.toHaveBeenCalled();
    }
  });

  it('navigates with a 20-second timeout and returns null on a timeout', async () => {
    const m = mockBrowser({ gotoImpl: async () => { throw new Error('Timeout 20000ms exceeded'); } });
    const r = make(m.browser);
    expect(await r.render('https://slow.example/')).toBeNull();
    expect(m.pages[0].goto).toHaveBeenCalledWith('https://slow.example/', expect.objectContaining({ timeout: 20_000 }));
    expect(m.pages[0].close).toHaveBeenCalled();
  });

  it('returns null for an error status (no bot-wall evasion) and for non-http final urls', async () => {
    const m403 = mockBrowser({ gotoImpl: async () => ({ status: () => 403 }) });
    expect(await make(m403.browser).render('https://walled.example/')).toBeNull();
    const mErr = mockBrowser({ finalUrl: 'chrome-error://chromewebdata/' });
    expect(await make(mErr.browser).render('https://x.example/')).toBeNull();
  });

  it('declines banned, never-fetch and non-http urls without launching', async () => {
    const m = mockBrowser();
    const r = make(m.browser);
    for (const u of ['https://www.reddit.com/r/x', 'https://gamersgetaway.ca/', 'file:///etc/passwd', 'http://127.0.0.1/', 'not a url']) {
      expect(await r.render(u), u).toBeNull();
    }
    expect(m.launches).toHaveLength(0);
  });

  it('closes pop-ups', async () => {
    const m = mockBrowser();
    const r = make(m.browser);
    await r.render('https://spa.example/a');
    const popup = { close: vi.fn(async () => {}) };
    m.pages[0].emit('popup', popup);
    expect(popup.close).toHaveBeenCalled();
  });

  it('runs at most 3 pages at once', async () => {
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const m = mockBrowser({
      gotoImpl: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((res) => releases.push(res));
        active--;
        return { status: () => 200 };
      },
    });
    const r = make(m.browser);
    const all = Promise.all(Array.from({ length: 7 }, (_, i) => r.render(`https://spa.example/${i}`)));
    for (let i = 0; i < 50 && releases.length < 3; i++) await new Promise((res) => setTimeout(res, 5));
    expect(releases.length).toBe(3);
    while (releases.length || active) {
      releases.shift()?.();
      await new Promise((res) => setTimeout(res, 5));
    }
    await all;
    expect(peak).toBe(3);
  });

  it('closeRenderer closes the context and deletes the temporary profile', async () => {
    const m = mockBrowser();
    const r = createRenderer(m.browser, proxy);
    await r.render('https://spa.example/a');
    const dir = m.launches[0]!.dir;
    expect(existsSync(dir)).toBe(true);
    await closeRenderer(r);
    expect(m.context.close).toHaveBeenCalled();
    expect(existsSync(dir)).toBe(false);
    expect(await r.render('https://spa.example/b')).toBeNull();
  });

  it('closeRenderer before any render launches nothing', async () => {
    const m = mockBrowser();
    await closeRenderer(createRenderer(m.browser, proxy));
    expect(m.launches).toHaveLength(0);
  });
});

describe('loadBrowser', () => {
  it('returns null when playwright-core cannot be imported', async () => {
    expect(await loadBrowser({ importer: async () => { throw new Error('Cannot find package'); } })).toBeNull();
  });
  it('returns null when the Chromium executable is missing', async () => {
    const chromium = { executablePath: () => join(tmpdir(), 'definitely-missing-chrome-xyz.exe'), launchPersistentContext: vi.fn() };
    expect(await loadBrowser({ importer: async () => ({ chromium }) })).toBeNull();
  });
  it('returns null when executablePath throws or the module has no chromium', async () => {
    expect(await loadBrowser({ importer: async () => ({ chromium: { executablePath: () => { throw new Error('no'); }, launchPersistentContext: vi.fn() } }) })).toBeNull();
    expect(await loadBrowser({ importer: async () => ({}) })).toBeNull();
  });
  it('returns a browser when the executable exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fake-chrome-'));
    try {
      const exe = join(dir, 'chrome.exe');
      (await import('node:fs')).writeFileSync(exe, '');
      const launchPersistentContext = vi.fn(async () => ({}));
      const b = await loadBrowser({ importer: async () => ({ chromium: { executablePath: () => exe, launchPersistentContext } }) });
      expect(b).not.toBeNull();
      expect(b!.executablePath()).toBe(exe);
      await b!.launchPersistentContext('d', { headless: true } as never);
      expect(launchPersistentContext).toHaveBeenCalledWith('d', { headless: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('openMissionBrowser', () => {
  it('returns null and starts no proxy when no browser is available', async () => {
    const startProxy = vi.fn();
    expect(await openMissionBrowser({ load: async () => null, startProxy: startProxy as never })).toBeNull();
    expect(startProxy).not.toHaveBeenCalled();
  });
  it('starts the guarded proxy with the banned-source check and closes renderer then proxy', async () => {
    const m = mockBrowser();
    const order: string[] = [];
    let blocked: ((h: string) => boolean) | undefined;
    const startProxy = vi.fn(async (o: { isBlockedHost: (h: string) => boolean }) => {
      blocked = o.isBlockedHost;
      return { port: 4242, address: '127.0.0.1' as const, close: async () => void order.push('proxy') };
    });
    const s = await openMissionBrowser({ load: async () => m.browser, startProxy });
    expect(s).not.toBeNull();
    expect(startProxy).toHaveBeenCalledWith(expect.not.objectContaining({ allowLoopbackForTests: true }));
    expect(blocked!('www.reddit.com')).toBe(true);
    expect(blocked!('shop.gamersgetaway.ca')).toBe(true);
    expect(blocked!('93.184.216.34')).toBe(true);
    expect(blocked!('example.com')).toBe(false);
    await s!.renderer.render('https://spa.example/');
    expect(m.launches[0]!.options.proxy.server).toBe('http://127.0.0.1:4242');
    m.context.close.mockImplementation(async () => void order.push('renderer'));
    await s!.close();
    expect(order).toEqual(['renderer', 'proxy']);
  });
  it('returns null when the proxy cannot start', async () => {
    const m = mockBrowser();
    expect(await openMissionBrowser({ load: async () => m.browser, startProxy: async () => { throw new Error('EADDRINUSE'); } })).toBeNull();
  });
});
