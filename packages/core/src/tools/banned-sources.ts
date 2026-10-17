import { parse } from 'tldts';

/** Registrable domains the pipeline must never use as a source (Global Constraint). */
export const BANNED_DOMAINS = [
  'reddit.com', 'redd.it', 'g2.com', 'capterra.com', 'trustpilot.com', 'upwork.com', 'indeed.com', 'linkedin.com', 'bing.com',
] as const;

const BANNED = new Set<string>(BANNED_DOMAINS);

/**
 * True when the url must not be used as a source: its registrable domain is banned. Fails closed — an
 * unparseable url, a non-http(s) protocol or an IP-literal host also counts as banned.
 */
export function isBannedSource(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return true;
  const r = parse(u.hostname.toLowerCase());
  if (r.isIp) return true;
  return r.domain !== null && BANNED.has(r.domain);
}
