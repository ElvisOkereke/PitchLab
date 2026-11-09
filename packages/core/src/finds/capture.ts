import { promises as dns } from 'node:dns';
import { existsSync, mkdirSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { Db } from '../db/client';
import { startGuardedProxy, type GuardedProxy } from '../research/browser/proxy';
import { collectPage } from '../research/collect';
import { respectRobotsSetting, robotsAllows as defaultRobotsAllows } from '../research/robots';
import { isNeverFetchHost } from '../tools/banned-sources';
import { fetchPage as defaultFetchPage, isAllowedIp } from '../tools/fetch-page';
import { errorMessage } from '../tools/scrub';
import type { FindCaptureResult } from './worker';

/**
 * Wires the capture service into the worker safely (worker-side only; the web never imports this file or @bcg/capture):
 * - yt-dlp's every request goes through core's guarded proxy (127.0.0.1, random port), which resolves each host once
 *   and refuses private, loopback and link-local answers and never-fetch hosts on every hop;
 * - checkUrl refuses such links before anything runs;
 * - the page fallback reads through collectPage (robots.txt, then the SSRF-guarded fetchPage).
 * `@bcg/capture` is imported dynamically, so the dependency only loads in the worker.
 */

type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;
const defaultLookup: Lookup = (host) => dns.lookup(host, { all: true });
const LOOKUP_TIMEOUT_MS = 10_000;
const PAGE_TEXT_MAX = 20_000;

/** The part of @bcg/capture the worker uses. */
export type CaptureModule = {
  captureLink: (url: string, opts: Record<string, unknown>) => Promise<FindCaptureResult>;
  scrubHandles: (text: string, handles: string[]) => string;
  toolPaths: (toolsDir: string) => { ytdlp: string; ffmpeg: string };
};

const localName = (host: string) => host === 'localhost' || ['.localhost', '.local', '.internal'].some((s) => host.endsWith(s)) || !host.includes('.');

/**
 * True only for an http(s) link without credentials whose host is not a never-fetch, local or IP-literal host, and
 * whose every DNS answer is a public unicast address. Never throws.
 */
export async function checkCaptureUrl(url: string, lookup: Lookup = defaultLookup): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) return false;
  const raw = u.hostname.toLowerCase();
  if (!raw || isNeverFetchHost(raw)) return false;
  let host = raw.replace(/\.+$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host || isNeverFetchHost(host) || isIP(host) || localName(host)) return false;
  try {
    const addrs = await new Promise<{ address: string }[]>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('lookup timed out')), LOOKUP_TIMEOUT_MS);
      lookup(host).then(resolve, reject).finally(() => clearTimeout(t));
    });
    return addrs.length > 0 && addrs.every((a) => isAllowedIp(a.address));
  } catch {
    return false;
  }
}

type ReadPageCtx = {
  db: Db;
  fetchPage?: typeof defaultFetchPage;
  robotsAllows?: (url: string) => Promise<boolean>;
  log: (m: string) => void;
};

/** The capture fallback: the page's title (as the caption) and readable text, through collectPage. Null when unreadable. */
export function makeReadPage(ctx: ReadPageCtx): (url: string) => Promise<{ caption?: string; pageText?: string } | null> {
  const fetchPage = ctx.fetchPage ?? defaultFetchPage;
  const robotsAllows = ctx.robotsAllows ?? ((u: string) => defaultRobotsAllows(u, { fetchPage }));
  return async (url) => {
    const respectRobots = await respectRobotsSetting(ctx.db);
    const page = await collectPage(url, { db: ctx.db, fetchPage, robotsAllows, respectRobots, log: ctx.log, state: { archiveDisabled: true } });
    if ('failed' in page) return null;
    const text = page.text.trim().slice(0, PAGE_TEXT_MAX);
    if (!text && !page.title) return null;
    return { caption: page.title || undefined, pageText: text || undefined };
  };
}

export type OpenCaptureDeps = {
  db: Db;
  log: (m: string) => void;
  /** The repo root: tools in `.tools`, the profile in `.data/capture-profile`, work folders under `.data/capture-tmp`. */
  root: string;
  importer?: () => Promise<CaptureModule>;
  startProxy?: typeof startGuardedProxy;
  lookup?: Lookup;
  fetchPage?: typeof defaultFetchPage;
  exists?: (path: string) => boolean;
};

export type OpenedCapture = {
  capture: (url: string) => Promise<FindCaptureResult>;
  scrubHandles: (text: string, handles: string[]) => string;
  /** yt-dlp and ffmpeg are installed (npm run capture:setup). */
  toolsPresent: boolean;
  close(): Promise<void>;
};

const defaultImporter = async (): Promise<CaptureModule> => (await import('@bcg/capture')) as unknown as CaptureModule;

/** Whether the capture tools are installed, for the heartbeat. Never throws. */
export async function captureToolsPresent(root: string, deps: { importer?: () => Promise<CaptureModule>; exists?: (p: string) => boolean } = {}): Promise<boolean> {
  try {
    const mod = await (deps.importer ?? defaultImporter)();
    const p = mod.toolPaths(join(root, '.tools'));
    const exists = deps.exists ?? existsSync;
    return exists(p.ytdlp) && exists(p.ffmpeg);
  } catch {
    return false;
  }
}

/**
 * Loads the capture package and starts the guarded proxy for it. Null when either is not available (finds then wait
 * in the queue). `close()` stops the proxy.
 */
export async function openCapture(deps: OpenCaptureDeps): Promise<OpenedCapture | null> {
  let mod: CaptureModule;
  try {
    mod = await (deps.importer ?? defaultImporter)();
  } catch (err) {
    deps.log(`capture unavailable: ${errorMessage(err)}`);
    return null;
  }
  let proxy: GuardedProxy;
  try {
    proxy = await (deps.startProxy ?? startGuardedProxy)({ isBlockedHost: (host) => isNeverFetchHost(host), lookup: deps.lookup });
  } catch (err) {
    deps.log(`capture proxy failed to start: ${errorMessage(err)}`);
    return null;
  }
  // Anything that throws from here on must not leave the proxy listening.
  try {
    const toolsDir = join(deps.root, '.tools');
    const profileDir = join(deps.root, '.data', 'capture-profile');
    const tmpDir = join(deps.root, '.data', 'capture-tmp');
    const exists = deps.exists ?? existsSync;
    try {
      if (!exists(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    } catch {
      // captureLink creates its own work folder; a missing parent shows up there as a readable error
    }
    const paths = mod.toolPaths(toolsDir);
    const opts = {
      toolsDir, profileDir, tmpDir,
      proxyUrl: `http://127.0.0.1:${proxy.port}`,
      checkUrl: (url: string) => checkCaptureUrl(url, deps.lookup),
      readPage: makeReadPage({ db: deps.db, fetchPage: deps.fetchPage, log: deps.log }),
      log: (m: string) => deps.log(`capture: ${m}`),
    };
    return {
      capture: (url) => mod.captureLink(url, opts),
      scrubHandles: mod.scrubHandles,
      toolsPresent: exists(paths.ytdlp) && exists(paths.ffmpeg),
      close: () => proxy.close().catch(() => {}),
    };
  } catch (err) {
    await proxy.close().catch(() => {});
    deps.log(`capture unavailable: ${errorMessage(err)}`);
    return null;
  }
}
