import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isBannedSource } from '../../tools/banned-sources';
import { HTML_MAX_BYTES } from '../../tools/fetch-page';
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
 * Remaining gap (accepted; the proxy is the security boundary and only reaches checked public, non-banned hosts):
 * requests Playwright's routing does not see, such as navigator.sendBeacon / keepalive fetches sent while a page is
 * unloading and traffic from dedicated or shared workers, are not method-filtered here; over https they travel inside
 * an opaque CONNECT tunnel. Service workers are blocked outright.
 */
export interface RequestLike {
  method(): string;
  resourceType(): string;
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
  userAgent: string;
  acceptDownloads: boolean;
  javaScriptEnabled: boolean;
  serviceWorkers: 'block';
  args: string[];
};
export interface BrowserLike {
  executablePath(): string;
  launchPersistentContext(userDataDir: string, options: LaunchOptions): Promise<ContextLike>;
}

export type Renderer = BrowserRenderer & { close(): Promise<void> };

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
export function createRenderer(browser: BrowserLike, proxy: { port: number }): Renderer {
  const limit = semaphore(MAX_PAGES);
  let closed = false;
  let profileDir: string | null = null;
  let contextPromise: Promise<ContextLike> | null = null;
  /** Pages this renderer opened, and newPage() calls still in flight (Playwright emits 'page' before they resolve). */
  const ours = new WeakSet<object>();
  const creating = new Set<Promise<unknown>>();

  async function launch(): Promise<ContextLike> {
    profileDir = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
    const context = await browser.launchPersistentContext(profileDir, {
      headless: true,
      proxy: { server: `http://127.0.0.1:${proxy.port}`, bypass: '' },
      userAgent: USER_AGENT,
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

  async function renderOne(url: string): Promise<{ html: string; finalUrl: string } | null> {
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
      if (res && (res.status() < 200 || res.status() >= 300)) return null; // a block or error page stays a failure
      await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
      const finalUrl = page.url();
      if (!isHttpUrl(finalUrl)) return null;
      const html = await page.content();
      return { html: html.length > HTML_MAX_BYTES ? html.slice(0, HTML_MAX_BYTES) : html, finalUrl };
    } finally {
      await page.close().catch(() => {});
    }
  }

  return {
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

/** Closes the mission's browser context and deletes its temporary profile. */
export function closeRenderer(renderer: Renderer): Promise<void> {
  return renderer.close();
}

/**
 * One mission's browser: the guarded proxy plus a renderer behind it, or null when Chromium is not available (missions
 * then keep thin pages as they are). `close()` shuts the renderer (profile deleted), then the proxy. Never throws.
 */
export async function openMissionBrowser(
  deps: { load?: () => Promise<BrowserLike | null>; startProxy?: typeof startGuardedProxy } = {},
): Promise<{ renderer: Renderer; close(): Promise<void> } | null> {
  const browser = await (deps.load ?? loadBrowser)().catch(() => null);
  if (!browser) return null;
  let proxy: GuardedProxy;
  try {
    // isBannedSource also refuses never-fetch hosts and IP literals (a page's sub-requests must use public names).
    proxy = await (deps.startProxy ?? startGuardedProxy)({ isBlockedHost: (host) => isBannedSource(`https://${host}/`) });
  } catch {
    return null;
  }
  const renderer = createRenderer(browser, proxy);
  return {
    renderer,
    async close() {
      await closeRenderer(renderer).catch(() => {});
      await proxy.close().catch(() => {});
    },
  };
}
