import { getDomain } from 'tldts';

/** Registrable domains the pipeline must never use as a source (Global Constraint). */
export const BANNED_DOMAINS = [
  'reddit.com', 'redd.it', 'g2.com', 'capterra.com', 'trustpilot.com', 'upwork.com', 'indeed.com', 'linkedin.com', 'bing.com',
] as const;

const BANNED = new Set<string>(BANNED_DOMAINS);

/** True when the url's registrable domain is banned. Unparseable urls return false (other guards handle them). */
export function isBannedSource(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const domain = getDomain(host);
  return domain !== null && BANNED.has(domain);
}
