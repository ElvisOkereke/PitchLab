import { parse } from 'tldts';

/**
 * Registrable domains the pipeline must never use as a source. The owner lifted the terms-of-service bans on 2026-11-08
 * ("I don't care about rules and terms of service"; Reddit, G2, Capterra and Trustpilot wanted), so only bing.com is left
 * (search-engine result pages are not sources). The never-fetch hosts below stay absolute.
 */
export const BANNED_DOMAINS = ['bing.com'] as const;

const BANNED = new Set<string>(BANNED_DOMAINS);

/**
 * Hosts (and their subdomains) never fetched or used, anywhere (Global Constraint: the owner's pilot site). The single
 * source of truth: isBannedSource refuses them, and fetchPage checks them on every hop.
 */
export const NEVER_FETCH_HOSTS = ['gamersgetaway.ca'] as const;

/**
 * True for a never-fetch host or one of its subdomains (case and all trailing dots ignored). A hostname with an empty
 * label ("..") is malformed and also counts (fails closed).
 */
export function isNeverFetchHost(hostname: string): boolean {
  if (hostname.includes('..')) return true;
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  return NEVER_FETCH_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * True when the url must not be used as a source: its registrable domain is banned, or its host is a never-fetch host.
 * Fails closed — an unparseable url, a non-http(s) protocol or an IP-literal host also counts as banned.
 */
export function isBannedSource(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  if (isNeverFetchHost(u.hostname)) return true;
  const r = parse(u.hostname.toLowerCase());
  if (r.isIp) return true;
  return r.domain !== null && BANNED.has(r.domain);
}
