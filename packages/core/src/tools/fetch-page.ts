import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch } from 'undici';
import { NEVER_FETCH_HOSTS, isNeverFetchHost } from './banned-sources';

export type PageFailure = 'http_error' | 'timeout' | 'too_large' | 'not_html' | 'network' | 'blocked_scheme' | 'blocked_host';
export interface PageResult {
  ok: boolean;
  status: number;
  finalUrl: string;
  title: string;
  text: string;
  /** Raw HTML of a successful text/html page, cut to at most HTML_MAX_BYTES of UTF-8 (absent otherwise). Untrusted. */
  html?: string;
  reason?: PageFailure;
}
export interface FetchPageOpts {
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  lookup?: (host: string) => Promise<{ address: string; family: number }[]>;
  /** Extra hosts refused on every hop like NEVER_FETCH_HOSTS (subdomains included; case and trailing dots ignored), e.g. a run's pilot site. */
  blockHosts?: readonly string[];
  /** User-Agent sent on every hop (default BusinessCaseGen). Research missions send their robots.txt identity. */
  userAgent?: string;
}

const USER_AGENT = 'BusinessCaseGen/0.1 (research; contact: owner)';
const MAX_REDIRECTS = 5;
/** Cap on the raw `html` returned with a page (500 KB). */
export const HTML_MAX_BYTES = 500_000;
const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

/** `s` cut to at most `max` bytes of UTF-8, never ending in a split character. */
function capUtf8(s: string, max: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= max) return s;
  let out = buf.subarray(0, max).toString('utf8');
  // A character split at the cut decodes to U+FFFD replacement chars: drop them.
  while (out.endsWith(REPLACEMENT_CHAR)) out = out.slice(0, -1);
  return out;
}

const fail = (reason: PageFailure, status: number, finalUrl: string): PageResult => ({
  ok: false, status, finalUrl, title: '', text: '', reason,
});

const isHttp = (u: URL) => u.protocol === 'http:' || u.protocol === 'https:';

export class TooLarge extends Error {}

// Never-fetch hosts live in banned-sources (one source of truth); re-exported here and checked on every hop below.
export { NEVER_FETCH_HOSTS, isNeverFetchHost };

const defaultLookup: (host: string) => Promise<{ address: string; family: number }[]> = (host) => dns.lookup(host, { all: true });

type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

function ipv4Allowed(v4: ipaddr.IPv4): boolean {
  return v4.range() === 'unicast';
}

/** Allow-list: only globally routable unicast addresses (and embedded IPv4 that is itself unicast). */
export function isAllowedIp(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip.split('%')[0]);
  } catch {
    return false;
  }
  if (addr.kind() === 'ipv4') return ipv4Allowed(addr as ipaddr.IPv4);
  const v6 = addr as ipaddr.IPv6;
  const range = v6.range();
  if (range === 'ipv4Mapped') return ipv4Allowed(v6.toIPv4Address());
  const p = v6.parts;
  const embedded = (hi: number, lo: number) => ipaddr.IPv4.parse([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
  if (range === 'rfc6052') {
    // Only the well-known 64:ff9b::/96 form; local-use 64:ff9b:1::/48 etc. are blocked.
    const wellKnown = p[0] === 0x64 && p[1] === 0xff9b && p.slice(2, 6).every((x) => x === 0);
    return wellKnown && ipv4Allowed(embedded(p[6], p[7]));
  }
  if (range === '6to4') return ipv4Allowed(embedded(p[1], p[2])); // 2002::/16
  return range === 'unicast' && v6.match(ipaddr.parse('2000::'), 3);
}

class BlockedHost extends Error {
  code = 'EBLOCKED';
}

/** DNS lookup for undici connections: the address dialed is the address checked. */
export function makeGuardedLookup(resolve: Resolver = defaultLookup) {
  return (
    hostname: string,
    options: { all?: boolean } | undefined,
    cb: (err: Error | null, address?: any, family?: number) => void,
  ): void => {
    resolve(hostname).then(
      (addrs) => {
        if (addrs.length === 0 || addrs.some((a) => !isAllowedIp(a.address))) {
          cb(new BlockedHost('blocked address for ' + hostname));
          return;
        }
        if (options?.all) cb(null, addrs);
        else cb(null, addrs[0].address, addrs[0].family);
      },
      (err) => cb(err),
    );
  };
}
export const guardedLookup = makeGuardedLookup();

const pinnedAgent = new Agent({ connect: { lookup: guardedLookup as any } });
const pinnedFetch = ((url: any, init: any) => undiciFetch(url, { ...init, dispatcher: pinnedAgent })) as unknown as typeof fetch;

function isBlockedError(err: unknown): boolean {
  for (let e: any = err; e; e = e.cause) if (e.code === 'EBLOCKED') return true;
  return false;
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

const normHost = (h: string) => h.toLowerCase().replace(/\.+$/, '');

async function checkHost(
  u: URL, lookup: Resolver, signal: AbortSignal, isRedirect: boolean, blockHosts: readonly string[],
): Promise<'ok' | 'blocked_host' | 'network' | 'timeout'> {
  if (u.username || u.password) return 'blocked_host';
  const rawHost = u.hostname.toLowerCase();
  // The never-fetch / ".." rules see the raw hostname (an empty label, e.g. "example.com..", fails closed) before any
  // trailing dot is stripped; then ALL trailing dots go before the local-name checks.
  if (isNeverFetchHost(rawHost)) return 'blocked_host';
  let host = rawHost.replace(/\.+$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || ['.localhost', '.local', '.internal'].some((s) => host.endsWith(s))) return 'blocked_host';
  if (isNeverFetchHost(host)) return 'blocked_host';
  if (blockHosts.some((b) => b !== '' && (host === b || host.endsWith(`.${b}`)))) return 'blocked_host';
  // A redirect may not point at an IP literal (it could bypass the never-fetch host set); the entry url still may.
  if (isIP(host) && isRedirect) return 'blocked_host';
  if (isIP(host)) return isAllowedIp(host) ? 'ok' : 'blocked_host';
  try {
    const addrs = await raceAbort(lookup(host), signal);
    if (addrs.length === 0) return 'network';
    return addrs.some((a) => !isAllowedIp(a.address)) ? 'blocked_host' : 'ok';
  } catch {
    return signal.aborted ? 'timeout' : 'network';
  }
}

export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new TooLarge();
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new TooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Readable title and text from raw HTML (also used for browser-rendered pages). */
export function extract(html: string): { title: string; text: string } {
  const { document } = parseHTML(/<html[\s>]/i.test(html) ? html : `<html><body>${html}</body></html>`);
  const title = (document.title || document.querySelector('title')?.textContent || '').trim();
  const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0]).parse();
  const text = (article?.textContent ?? (document.body ?? document.documentElement)?.textContent ?? '').trim();
  return { title, text };
}

/** GET-only page fetch. Never throws. */
export async function fetchPage(url: string, opts: FetchPageOpts = {}): Promise<PageResult> {
  const { timeoutMs = 15000, maxBytes = 2_000_000, fetchImpl = pinnedFetch, lookup = defaultLookup } = opts;
  const blockHosts = (opts.blockHosts ?? []).map(normHost);
  let current = url;
  let prevProtocol: string | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let parsed: URL;
      try {
        parsed = new URL(current);
      } catch {
        return fail('blocked_scheme', 0, current);
      }
      if (!isHttp(parsed)) return fail('blocked_scheme', 0, current);
      const hostCheck = await checkHost(parsed, lookup, controller.signal, hop > 0, blockHosts);
      if (hostCheck !== 'ok') return fail(hostCheck, 0, current);
      if (prevProtocol === 'https:' && parsed.protocol === 'http:') return fail('blocked_scheme', 0, current);
      prevProtocol = parsed.protocol;

      const res = await fetchImpl(parsed.href, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': opts.userAgent ?? USER_AGENT, Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' },
      });

      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        await res.body?.cancel().catch(() => {});
        try {
          current = new URL(res.headers.get('location')!, parsed).href;
        } catch {
          return fail('network', res.status, parsed.href);
        }
        continue;
      }

      if (res.status < 200 || res.status >= 300) {
        await res.body?.cancel().catch(() => {});
        return fail('http_error', res.status, parsed.href);
      }

      const type = (res.headers.get('content-type') ?? '').toLowerCase();
      const isHtml = type.includes('text/html') || type.includes('application/xhtml+xml');
      const isPlain = type.includes('text/plain');
      if (!isHtml && !isPlain) {
        await res.body?.cancel().catch(() => {});
        return fail('not_html', res.status, parsed.href);
      }

      const body = await readCapped(res, maxBytes);
      const { title, text } = isHtml ? extract(body) : { title: '', text: body.trim() };
      return { ok: true, status: res.status, finalUrl: parsed.href, title, text, ...(isHtml ? { html: capUtf8(body, HTML_MAX_BYTES) } : {}) };
    }
    return fail('network', 0, current); // too many redirects
  } catch (err) {
    if (err instanceof TooLarge) return fail('too_large', 200, current);
    if (controller.signal.aborted) return fail('timeout', 0, current);
    if (isBlockedError(err)) return fail('blocked_host', 0, current);
    return fail('network', 0, current);
  } finally {
    clearTimeout(timer);
  }
}
