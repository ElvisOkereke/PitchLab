import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
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
 * additionally allow GET only and drop images, media and fonts. No stealth: the PitchLab user agent, no logins.
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
export interface ContextLike {
  route(pattern: string, handler: (route: RouteLike) => unknown): Promise<void>;
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
const PLAYWRIGHT = 'playwright-core';

type Importer = () => Promise<unknown>;

/**
 * playwright-core's Chromium, or null when the package cannot be imported or its Chromium executable is not on disk
 * (the owner installs it with `npx playwright install chromium`). Never throws.
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
    return context;
  }

  async function renderOne(url: string): Promise<{ html: string; finalUrl: string } | null> {
    if (closed) return null;
    contextPromise ??= launch();
    const context = await contextPromise;
    if (closed) return null;
    const page = await context.newPage();
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
