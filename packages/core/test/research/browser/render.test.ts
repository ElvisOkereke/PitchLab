// The local browser renderer with Playwright mocked (no Chromium, no network).
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeRenderer, createRenderer, loadBrowser, openMissionBrowser, sweepStaleProfiles, type BrowserLike } from '../../../src/research/browser/render';
import { USER_AGENT } from '../../../src/research/http';

type Handler = (route: any) => unknown;

function mockRoute(method: string, resourceType: string, url = 'https://spa.example/x', frames?: string[]) {
  // frames: the frame chain from the request's own frame up to the top document (absent: no frame info).
  const frameAt = (i: number): any => (frames && i < frames.length ? { url: () => frames[i], parentFrame: () => (i + 1 < frames.length ? frameAt(i + 1) : null) } : null);
  return {
    request: () => ({ method: () => method, resourceType: () => resourceType, url: () => url, ...(frames ? { frame: () => frameAt(0) } : {}) }),
    abort: vi.fn(async () => {}), continue: vi.fn(async () => {}),
  };
}

function mockBrowser(opts: { gotoImpl?: (url: string, o: any) => Promise<any>; html?: string; htmls?: string[]; finalUrl?: string; navStatus?: unknown } = {}) {
  const routes: Handler[] = [];
  const pages: any[] = [];
  const launches: { dir: string; options: any }[] = [];
  const wsRoutes: { pattern: string; handler: (ws: any) => unknown }[] = [];
  const ctxListeners: ((p: any) => void)[] = [];
  const context = {
    route: vi.fn(async (_p: string, h: Handler) => void routes.push(h)),
    routeWebSocket: vi.fn(async (pattern: string, handler: (ws: any) => unknown) => void wsRoutes.push({ pattern, handler })),
    on: vi.fn((ev: string, fn: (p: any) => void) => void (ev === 'page' ? ctxListeners.push(fn) : undefined)),
    /** Simulates a page the renderer did not create (window.open, target=_blank, ...). */
    emitPage: (p: any) => ctxListeners.forEach((f) => f(p)),
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
        content: vi.fn(async () => (opts.htmls && opts.htmls.length > 1 ? opts.htmls.shift()! : opts.htmls?.[0] ?? opts.html ?? '<html><body><p>rendered</p></body></html>')),
        evaluate: vi.fn(async () => opts.navStatus),
        url: () => current,
        close: vi.fn(async () => {}),
        emit: (ev: string, x: any) => (listeners[ev] ?? []).forEach((f) => f(x)),
      };
      pages.push(page);
      // Like Playwright, the context's 'page' event fires before newPage() resolves.
      ctxListeners.forEach((f) => f(page));
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
  return { browser, context, routes, pages, launches, wsRoutes };
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
    expect(options.args).toEqual(expect.arrayContaining(['--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-quic']));
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
    for (const u of ['https://www.bing.com/search?q=x', 'https://gamersgetaway.ca/', 'file:///etc/passwd', 'http://127.0.0.1/', 'not a url']) {
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

describe('createRenderer hardening', () => {
  it('closes every WebSocket at the route layer (the GET-only rule also holds inside wss tunnels)', async () => {
    const m = mockBrowser();
    await make(m.browser).render('https://spa.example/a');
    expect(m.wsRoutes.map((w) => w.pattern)).toEqual(['**/*']);
    const ws = { close: vi.fn(async () => {}), connectToServer: vi.fn() };
    await m.wsRoutes[0]!.handler(ws);
    expect(ws.close).toHaveBeenCalled();
    expect(ws.connectToServer).not.toHaveBeenCalled();
  });

  it('closes pages it did not create, but never its own', async () => {
    const m = mockBrowser();
    const r = make(m.browser);
    await r.render('https://spa.example/a');
    expect(m.pages[0].close).toHaveBeenCalledTimes(1); // only the renderer's own close after rendering
    const stray = { close: vi.fn(async () => {}) };
    m.context.emitPage(stray);
    await new Promise((res) => setTimeout(res, 0));
    expect(stray.close).toHaveBeenCalled();
  });

  it('a stray page during concurrent renders is closed while renders still succeed', async () => {
    const m = mockBrowser();
    const r = make(m.browser);
    await r.render('https://spa.example/0'); // context launched
    const stray = { close: vi.fn(async () => {}) };
    const all = Promise.all([r.render('https://spa.example/1'), r.render('https://spa.example/2')]);
    m.context.emitPage(stray);
    const out = await all;
    await new Promise((res) => setTimeout(res, 0));
    expect(out.every((o) => o !== null)).toBe(true);
    expect(stray.close).toHaveBeenCalled();
    for (const p of m.pages) expect(p.close).toHaveBeenCalledTimes(1);
  });
});

describe('createRenderer real-browser mode', () => {
  const realMake = (b: BrowserLike, o: { profileDir: string; sleep?: (ms: number) => Promise<void>; random?: () => number }) => {
    const r = createRenderer(b, proxy, { mode: 'real', sleep: async () => {}, ...o });
    renderers.push(r);
    return r;
  };
  let profileRoot: string;
  beforeEach(() => { profileRoot = mkdtempSync(join(tmpdir(), 'fetch-profile-test-')); });
  afterEach(() => rmSync(profileRoot, { recursive: true, force: true }));

  it('is headed, on the persistent profile, through the guarded proxy, with the browser\'s own user agent', async () => {
    const m = mockBrowser();
    const profileDir = join(profileRoot, 'fetch-profile');
    const r = realMake(m.browser, { profileDir });
    expect(r.kind).toBe('real');
    expect(make(mockBrowser().browser).kind).toBe('headless');
    await r.render('https://walled.example/a');
    const { dir, options } = m.launches[0]!;
    expect(dir).toBe(profileDir);
    expect(existsSync(profileDir)).toBe(true);
    expect(options).toMatchObject({ headless: false, proxy: { server: 'http://127.0.0.1:54321', bypass: '' }, acceptDownloads: false, serviceWorkers: 'block' });
    expect('userAgent' in options).toBe(false);
    expect(JSON.stringify(options)).not.toContain(USER_AGENT);
    expect(options.args).toEqual(expect.arrayContaining(['--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-quic']));
    // No stealth: no fingerprint or automation-flag tampering.
    expect(options.args.join(' ')).not.toMatch(/AutomationControlled|user-agent|fingerprint/i);
  });

  it('waits 3 to 8 seconds per page', async () => {
    for (const [random, ms] of [[0, 3000], [0.5, 5500], [0.99999, 8000]] as const) {
      const sleep = vi.fn(async () => {});
      const r = realMake(mockBrowser().browser, { profileDir: join(profileRoot, `p${random}`), sleep, random: () => random });
      await r.render('https://walled.example/a');
      expect(sleep).toHaveBeenCalledWith(ms);
    }
  });

  it('uses one tab at a time', async () => {
    let active = 0;
    let peak = 0;
    const m = mockBrowser({
      gotoImpl: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((res) => setTimeout(res, 5));
        active--;
        return { status: () => 200 };
      },
    });
    const r = realMake(m.browser, { profileDir: join(profileRoot, 'p') });
    await Promise.all([1, 2, 3].map((i) => r.render(`https://walled.example/${i}`)));
    expect(peak).toBe(1);
  });

  it('returns an error-status page with its status and whether the first load was a challenge', async () => {
    const m = mockBrowser({ gotoImpl: async () => ({ status: () => 403 }), html: '<p>Forbidden</p>' });
    const r = realMake(m.browser, { profileDir: join(profileRoot, 'p') });
    expect(await r.render('https://walled.example/a')).toEqual({ html: '<p>Forbidden</p>', finalUrl: 'https://walled.example/a', status: 403, challenged: false });
  });

  it('prefers the final document status (navigation entry) over the first response, and flags a first-load challenge', async () => {
    const challenge = '<html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>';
    const m = mockBrowser({ gotoImpl: async () => ({ status: () => 403 }), htmls: [challenge, '<p>the real page</p>'], navStatus: 200 });
    const r = realMake(m.browser, { profileDir: join(profileRoot, 'p') });
    expect(await r.render('https://walled.example/a')).toEqual({ html: '<p>the real page</p>', finalUrl: 'https://walled.example/a', status: 200, challenged: true });
    // A missing or zero navigation status falls back to the first response's status.
    for (const navStatus of [undefined, 0, 'x']) {
      const f = mockBrowser({ gotoImpl: async () => ({ status: () => 503 }), html: '<p>x</p>', navStatus });
      expect(await realMake(f.browser, { profileDir: join(profileRoot, `f${String(navStatus)}`) }).render('https://walled.example/a')).toMatchObject({ status: 503 });
    }
  });

  it('declines banned and never-fetch urls without launching', async () => {
    const m = mockBrowser();
    const r = realMake(m.browser, { profileDir: join(profileRoot, 'p') });
    for (const u of ['https://www.bing.com/x', 'https://gamersgetaway.ca/', 'https://shop.gamersgetaway.ca/', 'http://127.0.0.1/']) expect(await r.render(u)).toBeNull();
    expect(m.launches).toHaveLength(0);
  });

  it('keeps GET-only except the challenge page\'s own same-origin check (POST to /cdn-cgi/challenge-platform/)', async () => {
    const m = mockBrowser();
    await realMake(m.browser, { profileDir: join(profileRoot, 'p') }).render('https://walled.example/a');
    const TOP = ['https://walled.example/a'];
    const handle = async (method: string, type: string, url: string, frames: string[] | null = TOP) => {
      const route = mockRoute(method, type, url, frames ?? undefined);
      for (const h of m.routes) await h(route);
      return route;
    };
    expect((await handle('POST', 'xhr', 'https://walled.example/cdn-cgi/challenge-platform/h/b/flow/ov1/x')).continue).toHaveBeenCalled();
    const denied: [string, string, string[] | null][] = [
      ['POST', 'https://walled.example/api/comment', TOP],
      ['POST', 'https://walled.example/x?u=/cdn-cgi/challenge-platform/', TOP],
      ['PUT', 'https://walled.example/cdn-cgi/challenge-platform/x', TOP],
      ['DELETE', 'https://walled.example/a', TOP],
      // Cross-origin: another site's challenge path, from a walled.example page or from an iframe of that site.
      ['POST', 'https://evil.example/cdn-cgi/challenge-platform/h/b/x', TOP],
      ['POST', 'https://evil.example/cdn-cgi/challenge-platform/h/b/x', ['https://evil.example/frame', 'https://walled.example/a']],
      // Turnstile's own host is not allowed either (the scraper covers those sites).
      ['POST', 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/x', ['https://challenges.cloudflare.com/turnstile', 'https://walled.example/a']],
      ['POST', 'http://walled.example/cdn-cgi/challenge-platform/h/b/x', TOP], // different scheme, different origin
      ['POST', 'https://walled.example/cdn-cgi/challenge-platform/h/b/x', null], // no frame information: refused
    ];
    for (const [method, url, frames] of denied) {
      const route = await handle(method, 'xhr', url, frames);
      expect(route.abort, `${method} ${url} from ${frames?.join(' < ')}`).toHaveBeenCalled();
      expect(route.continue).not.toHaveBeenCalled();
    }
    // A same-origin iframe of the page may run the check too (the top document decides the origin).
    expect((await handle('POST', 'xhr', 'https://walled.example/cdn-cgi/challenge-platform/h/b/y', ['https://walled.example/frame', 'https://walled.example/a'])).continue).toHaveBeenCalled();
    // The headless renderer still refuses every POST.
    const h = mockBrowser();
    await make(h.browser).render('https://spa.example/a');
    const route = mockRoute('POST', 'xhr', 'https://spa.example/cdn-cgi/challenge-platform/h/b/flow/ov1/x');
    for (const fn of h.routes) await fn(route);
    expect(route.abort).toHaveBeenCalled();
  });

  it('close() shuts the browser but keeps the persistent profile (cookies)', async () => {
    const m = mockBrowser();
    const profileDir = join(profileRoot, 'p');
    const r = createRenderer(m.browser, proxy, { mode: 'real', profileDir, sleep: async () => {} });
    await r.render('https://walled.example/a');
    await r.close();
    expect(m.context.close).toHaveBeenCalled();
    expect(existsSync(profileDir)).toBe(true);
  });

  it('openMissionBrowser gives a headless renderer and, with a profile, a real one, both behind one guarded proxy and closed after the mission', async () => {
    const m = mockBrowser();
    const proxyClose = vi.fn(async () => {});
    const s = await openMissionBrowser({
      load: async () => m.browser, realProfileDir: join(profileRoot, 'p'), sleep: async () => {},
      startProxy: async () => ({ port: 4343, address: '127.0.0.1' as const, close: proxyClose }),
    });
    expect(s!.renderer.kind).toBe('headless');
    expect(s!.realRenderer!.kind).toBe('real');
    expect(m.launches).toHaveLength(0); // nothing opens (no window) until a page needs it
    await s!.realRenderer!.render('https://walled.example/');
    expect(m.launches[0]!.options).toMatchObject({ headless: false, proxy: { server: 'http://127.0.0.1:4343' } });
    await s!.close();
    expect(m.context.close).toHaveBeenCalled();
    expect(proxyClose).toHaveBeenCalled();
    const plain = await openMissionBrowser({ load: async () => mockBrowser().browser, startProxy: async () => ({ port: 1, address: '127.0.0.1' as const, close: async () => {} }) });
    expect(plain!.realRenderer).toBeNull();
    await plain!.close();
  });
});

describe('sweepStaleProfiles', () => {
  it('removes pitchlab-browser-* directories older than an hour and keeps everything else', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-test-'));
    try {
      const { mkdirSync, utimesSync, writeFileSync } = await import('node:fs');
      const old = join(root, 'pitchlab-browser-old');
      const fresh = join(root, 'pitchlab-browser-fresh');
      const other = join(root, 'something-else-old');
      for (const d of [old, fresh, other]) {
        mkdirSync(d);
        writeFileSync(join(d, 'f'), 'x');
      }
      const now = Date.now();
      const twoHoursAgo = new Date(now - 2 * 3_600_000);
      utimesSync(old, twoHoursAgo, twoHoursAgo);
      utimesSync(other, twoHoursAgo, twoHoursAgo);
      const removed = await sweepStaleProfiles({ dir: root, now: () => now });
      expect(removed).toBe(1);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(other)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('never throws (missing directory)', async () => {
    expect(await sweepStaleProfiles({ dir: join(tmpdir(), 'definitely-missing-dir-xyz') })).toBe(0);
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
    expect(blocked!('www.bing.com')).toBe(true);
    expect(blocked!('www.reddit.com')).toBe(false); // terms-of-service bans lifted
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
