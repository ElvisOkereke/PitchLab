import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isBannedSource } from '../../tools/banned-sources';
import { HTML_MAX_BYTES } from '../../tools/fetch-page';
import { looksLikeChallenge } from '../challenge';
import type { BrowserRenderer } from '../collect';
import { USER_AGENT } from '../http';
import { startGuardedProxy, type GuardedProxy } from './proxy';

/**
 * Optional local headless Chromium for JavaScript-rendered pages. playwright-core is an optional dependency loaded at
 * runtime; these local interfaces cover only what we call, so core type-checks without the package installed.
 *
 * All browser traffic goes through the guarded proxy (proxy.ts): the context is launched with it, with no bypass list
 * and loopback explicitly proxied, WebRTC limited to proxied traffic, QUIC off and service workers blocked. Routes
 * additionally allow GET only and drop images, media and fonts, and every WebSocket is closed at the route layer (so
 * nothing but GET leaves the browser, even inside a wss:// tunnel). Pages the renderer did not open are closed.
 * No stealth: the PitchLab user agent, no logins.
 *
 * Real-browser mode (`mode: 'real'`, the escalation step for blocked pages): headed Chromium on the persistent profile
 * `.data/fetch-profile` (cookies kept between missions, never deleted), the browser's own user agent (no PitchLab
 * override, and no other change: no fingerprint spoofing, no stealth plugins, no CAPTCHA solving), one tab at a time and
 * a 3-8 s wait per page (human pace, and time for a challenge page's own script to finish). Same guarded proxy, same
 * routes, with one exception: a POST to `/cdn-cgi/challenge-platform/` on the same origin as the tab's top document
 * (Cloudflare's own check) is let through, since the interstitial cannot clear without it. Cross-origin POSTs, including
 * Turnstile's challenges.cloudflare.com, stay blocked (the scraping service covers those sites). Error-status pages are
 * returned with the final document status and whether the first load was a challenge, so the caller can tell a cleared
 * challenge from a block. Missions use it only for blocked pages (403 or challenge); thin pages use the headless one.
 *
 * Remaining gap (accepted; the proxy is the security boundary and only reaches checked public, non-banned hosts):
 * requests Playwright's routing does not see, such as navigator.sendBeacon / keepalive fetches sent while a page is
 * unloading and traffic from dedicated or shared workers, are not method-filtered here; over https they travel inside
 * an opaque CONNECT tunnel. Service workers are blocked outright.
 */
export interface FrameLike {
  url(): string;
  parentFrame(): FrameLike | null;
}
export interface RequestLike {
  method(): string;
  resourceType(): string;
  url(): string;
  frame?(): FrameLike | null;
}
export interface RouteLike {
  request(): RequestLike;
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}
export interface ResponseLike {
  status(): number;
}
export interface PageLike {
  on(event: 'popup', listener: (popup: { close(): Promise<void> }) => void): unknown;
  goto(url: string, options: { timeout: number; waitUntil: 'load' | 'domcontentloaded' | 'networkidle' }): Promise<ResponseLike | null>;
  waitForLoadState(state: 'networkidle', options: { timeout: number }): Promise<void>;
  content(): Promise<string>;
  /** Real mode reads the navigation entry's final status. */
  evaluate?<T>(fn: () => T): Promise<T>;
  url(): string;
  close(): Promise<void>;
}
export interface WebSocketRouteLike {
  close(options?: { code?: number; reason?: string }): Promise<void>;
}
export interface ContextLike {
  route(pattern: string, handler: (route: RouteLike) => unknown): Promise<void>;
  /** Playwright >= 1.48. */
  routeWebSocket(pattern: string, handler: (ws: WebSocketRouteLike) => unknown): Promise<void>;
  on(event: 'page', listener: (page: { close(): Promise<void> }) => void): unknown;
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
export type LaunchOptions = {
  headless: boolean;
  proxy: { server: string; bypass: string };
  /** Set in headless mode only (the research identity); real mode keeps the browser's own. */
  userAgent?: string;
  acceptDownloads: boolean;
  javaScriptEnabled: boolean;
  serviceWorkers: 'block';
  args: string[];
};
export interface BrowserLike {
  executablePath(): string;
  launchPersistentContext(userDataDir: string, options: LaunchOptions): Promise<ContextLike>;
}

export type Renderer = BrowserRenderer & { kind: 'headless' | 'real'; close(): Promise<void> };

export type RendererOpts = {
  /** 'real': headed, persistent profile, own user agent, one tab, 3-8 s per page. Default 'headless'. */
  mode?: 'headless' | 'real';
  /** Real mode: the persistent profile directory (`.data/fetch-profile`). Required for real mode. */
  profileDir?: string;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

/** Real mode's per-page wait: 3 to 8 seconds. */
export const REAL_PACE_MIN_MS = 3_000;
export const REAL_PACE_MAX_MS = 8_000;
const CHALLENGE_PATH = '/cdn-cgi/challenge-platform/';

export const NAV_TIMEOUT_MS = 20_000;
/** Best-effort extra wait for client-side rendering after `load` (inside no more than this). */
const SETTLE_TIMEOUT_MS = 5_000;
export const MAX_PAGES = 3;
const BLOCKED_TYPES = new Set(['image', 'media', 'font']);
const PROFILE_PREFIX = 'pitchlab-browser-';
/** Profiles older than this at worker start belong to a crashed or killed mission. */
const STALE_PROFILE_MS = 3_600_000;
const PLAYWRIGHT = 'playwright-core';

type Importer = () => Promise<unknown>;

/**
 * playwright-core's Chromium, or null when the package cannot be imported or its Chromium executable is not on disk
 * (the owner installs it with `npx playwright-core install chromium`, run in packages/core). Never throws.
 */
export async function loadBrowser(deps: { importer?: Importer } = {}): Promise<BrowserLike | null> {
  try {
    // A non-literal specifier keeps tsc and bundlers from resolving the optional package.
    const name = PLAYWRIGHT;
    const mod = (await (deps.importer ? deps.importer() : import(/* @vite-ignore */ name))) as { chromium?: BrowserLike; default?: { chromium?: BrowserLike } };
    const chromium = mod?.chromium ?? mod?.default?.chromium;
    if (!chromium || typeof chromium.executablePath !== 'function' || typeof chromium.launchPersistentContext !== 'function') return null;
    const exe = chromium.executablePath();
    if (typeof exe !== 'string' || exe === '' || !existsSync(exe)) return null;
    return {
      executablePath: () => chromium.executablePath(),
      launchPersistentContext: (dir, options) => chromium.launchPersistentContext(dir, options),
    };
  } catch {
    return null;
  }
}

/** A tiny counting semaphore: at most `max` holders at once, FIFO. */
function semaphore(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    else active++;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

function isHttpUrl(url: string): boolean {
  try {
    const p = new URL(url).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

/**
 * A renderer for one mission. Chromium starts on the first render (a temporary profile directory, one context) and
 * `close()` shuts it and deletes the profile. Returns null for anything it declines or cannot render; never throws.
 */
export function createRenderer(browser: BrowserLike, proxy: { port: number }, opts: RendererOpts = {}): Renderer {
  const real = opts.mode === 'real';
  if (real && !opts.profileDir) throw new Error('real-browser mode needs a profile directory');
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const paceMs = () => REAL_PACE_MIN_MS + Math.floor(Math.min(Math.max(random(), 0), 0.999999) * (REAL_PACE_MAX_MS - REAL_PACE_MIN_MS + 1));
  const limit = semaphore(real ? 1 : MAX_PAGES);
  let closed = false;
  let profileDir: string | null = null;
  let contextPromise: Promise<ContextLike> | null = null;
  /** Pages this renderer opened, and newPage() calls still in flight (Playwright emits 'page' before they resolve). */
  const ours = new WeakSet<object>();
  const creating = new Set<Promise<unknown>>();

  async function launch(): Promise<ContextLike> {
    let dir: string;
    if (real) {
      dir = opts.profileDir!;
      await mkdir(dir, { recursive: true });
    } else {
      dir = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
      profileDir = dir; // temporary: deleted on close
    }
    const context = await browser.launchPersistentContext(dir, {
      headless: !real,
      proxy: { server: `http://127.0.0.1:${proxy.port}`, bypass: '' },
      ...(real ? {} : { userAgent: USER_AGENT }),
      acceptDownloads: false,
      javaScriptEnabled: true,
      serviceWorkers: 'block',
      args: [
        // Loopback goes through the proxy too (where it is refused), whatever PLAYWRIGHT_* env vars say.
        '--proxy-bypass-list=<-loopback>',
        // WebRTC may not open UDP that skips the proxy; QUIC off so every connection is a proxied TCP one.
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--disable-quic',
      ],
    });
    // Every request from every page (pop-ups included, until they close): GET only, no images, media or fonts.
    await context.route('**/*', (route) => {
      const req = route.request();
      if (real && req.method() === 'POST' && isSameOriginChallengeCheck(req)) return route.continue();
      if (req.method() !== 'GET' || BLOCKED_TYPES.has(req.resourceType())) return route.abort('blockedbyclient');
      return route.continue();
    });
    // No WebSocket is ever opened to a server: the GET-only rule must also hold inside a wss:// tunnel.
    await context.routeWebSocket('**/*', (ws) => void ws.close().catch(() => {}));
    // Any page we did not open (window.open, target=_blank, ...) is closed once our own pending opens have settled.
    context.on('page', (page) => {
      void Promise.allSettled([...creating]).then(() => {
        if (!ours.has(page)) void page.close().catch(() => {});
      });
    });
    return context;
  }

  async function renderOne(url: string): Promise<{ html: string; finalUrl: string; status?: number; challenged?: boolean } | null> {
    if (closed) return null;
    contextPromise ??= launch();
    const context = await contextPromise;
    if (closed) return null;
    // Marked as in flight before newPage() is called, so a 'page' event for it always waits for ours.add below.
    let settle!: () => void;
    const opening = new Promise<void>((r) => (settle = r));
    creating.add(opening);
    let page: PageLike;
    try {
      page = await context.newPage();
      ours.add(page);
    } finally {
      creating.delete(opening);
      settle();
    }
    try {
      page.on('popup', (popup) => void popup.close().catch(() => {}));
      const res = await page.goto(url, { timeout: NAV_TIMEOUT_MS, waitUntil: 'load' });
      const firstStatus = res ? res.status() : undefined;
      const errorStatus = firstStatus !== undefined && (firstStatus < 200 || firstStatus >= 300);
      if (errorStatus && !real) return null; // headless: a block or error page stays a failure
      let challenged = false;
      if (real) {
        challenged = looksLikeChallenge(await page.content().catch(() => ''));
        await sleep(paceMs());
      }
      await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
      const finalUrl = page.url();
      if (!isHttpUrl(finalUrl)) return null;
      const html = await page.content();
      const capped = html.length > HTML_MAX_BYTES ? html.slice(0, HTML_MAX_BYTES) : html;
      if (!real) return { html: capped, finalUrl };
      // The final document's status (after a challenge reloads the page), else the first response's.
      const nav = await navigationStatus(page);
      const status = nav ?? firstStatus;
      return status !== undefined ? { html: capped, finalUrl, status, challenged } : { html: capped, finalUrl, challenged };
    } finally {
      await page.close().catch(() => {});
    }
  }

  return {
    kind: real ? 'real' : 'headless',
    async render(url) {
      if (closed || !isHttpUrl(url) || isBannedSource(url)) return null;
      try {
        return await limit(() => renderOne(url));
      } catch {
        return null;
      }
    },
    async close() {
      closed = true;
      const ctx = contextPromise;
      contextPromise = null;
      if (ctx) await ctx.then((c) => c.close()).catch(() => {});
      if (profileDir) {
        const dir = profileDir;
        profileDir = null;
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
      }
    },
  };
}

/**
 * A POST to Cloudflare's challenge path on the same origin as the tab's top document (real mode lets only this one
 * through). The top document is found by walking the request's frame chain; no frame information means no.
 */
function isSameOriginChallengeCheck(req: RequestLike): boolean {
  try {
    const target = new URL(req.url());
    if (!target.pathname.startsWith(CHALLENGE_PATH)) return false;
    let frame: FrameLike | null = req.frame?.() ?? null;
    if (!frame) return false;
    for (let i = 0; i < 20; i++) {
      const parent: FrameLike | null = frame.parentFrame();
      if (!parent) break;
      frame = parent;
    }
    return new URL(frame.url()).origin === target.origin;
  } catch {
    return false;
  }
}

/** The navigation entry's responseStatus (Chromium), or null when missing, zero or unreadable. */
async function navigationStatus(page: PageLike): Promise<number | null> {
  if (!page.evaluate) return null;
  try {
    const v = await page.evaluate(() => {
      const e = (globalThis as unknown as { performance?: { getEntriesByType(t: string): { responseStatus?: unknown }[] } }).performance?.getEntriesByType('navigation')[0];
      return e?.responseStatus;
    });
    return typeof v === 'number' && Number.isInteger(v) && v >= 100 && v < 600 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Deletes `pitchlab-browser-*` profile directories older than an hour (left by a crashed or killed mission). Run at
 * worker start. Returns how many were removed; never throws.
 */
export async function sweepStaleProfiles(opts: { dir?: string; now?: () => number; maxAgeMs?: number } = {}): Promise<number> {
  const { dir = tmpdir(), now = Date.now, maxAgeMs = STALE_PROFILE_MS } = opts;
  let removed = 0;
  try {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith(PROFILE_PREFIX)) continue;
      const full = join(dir, e.name);
      try {
        if (now() - (await stat(full)).mtimeMs <= maxAgeMs) continue;
        await rm(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        removed++;
      } catch {
        // in use or already gone: leave it for the next sweep
      }
    }
  } catch {
    // unreadable temp directory: nothing to sweep
  }
  return removed;
}

/** Closes the mission's browser context and deletes its temporary profile (a real-mode profile is kept). */
export function closeRenderer(renderer: Renderer): Promise<void> {
  return renderer.close();
}

/**
 * One mission's browsers: the guarded proxy plus a headless renderer (thin pages) and, with `realProfileDir`, a real
 * headed renderer (blocked pages), both behind the same proxy; or null when Chromium is not available. `close()` shuts
 * both renderers (the temporary profile deleted, the real profile kept), then the proxy. Never throws.
 */
export async function openMissionBrowser(
  deps: {
    load?: () => Promise<BrowserLike | null>; startProxy?: typeof startGuardedProxy;
    /** With a profile directory (`.data/fetch-profile`), also a real (headed) renderer for blocked pages. */
    realProfileDir?: string;
  } & Pick<RendererOpts, 'sleep' | 'random'> = {},
): Promise<{ renderer: Renderer; realRenderer: Renderer | null; close(): Promise<void> } | null> {
  const browser = await (deps.load ?? loadBrowser)().catch(() => null);
  if (!browser) return null;
  let proxy: GuardedProxy;
  try {
    // isBannedSource also refuses never-fetch hosts and IP literals (a page's sub-requests must use public names).
    proxy = await (deps.startProxy ?? startGuardedProxy)({ isBlockedHost: (host) => isBannedSource(`https://${host}/`) });
  } catch {
    return null;
  }
  // Both start lazily: no Chromium (and no window) until a page needs one.
  const renderer = createRenderer(browser, proxy);
  const realRenderer = deps.realProfileDir
    ? createRenderer(browser, proxy, { mode: 'real', profileDir: deps.realProfileDir, sleep: deps.sleep, random: deps.random })
    : null;
  return {
    renderer,
    realRenderer,
    async close() {
      await closeRenderer(renderer).catch(() => {});
      if (realRenderer) await closeRenderer(realRenderer).catch(() => {});
      await proxy.close().catch(() => {});
    },
  };
}
