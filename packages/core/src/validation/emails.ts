import { and, eq, inArray, isNull } from 'drizzle-orm';
import { parse } from 'tldts';
import { prospects, suppressions } from '../db/schema';
import { capField } from '../llm/untrusted';
import type { StageDeps } from '../pipeline/types';
import { isBannedSource } from '../tools/banned-sources';
import { decodeEntities } from '../tools/entities';
import { prospectDomain } from './prospects';

export type FoundEmail = { email: string; foundOn: string };

/** Extensions that turn `name@2x.png`-style asset names into pseudo-addresses. */
const FILE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'bmp', 'ico', 'tif', 'tiff', 'heic', 'js', 'mjs', 'css', 'map', 'json',
  'xml', 'txt', 'pdf', 'zip', 'mp4', 'webm', 'mov', 'mp3', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'php', 'html', 'htm',
]);
/** Free-mail hosts a small business may publish on its own site. */
const FREE_MAIL = new Set(['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com']);
/** Registrable-domain labels used as placeholders in templates and docs. */
const PLACEHOLDER_LABELS = new Set(['example', 'test', 'domain', 'yourdomain', 'yoursite', 'yourcompany', 'email']);
const NO_REPLY = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply)/;
/** Shared inboxes; ranked after named people (both are allowed). */
const ROLE_INBOXES = new Set([
  'info', 'contact', 'contactus', 'sales', 'hello', 'hi', 'office', 'admin', 'support', 'help', 'dispatch', 'team', 'enquiries',
  'inquiries', 'enquiry', 'inquiry', 'mail', 'careers', 'jobs', 'hr', 'billing', 'accounts', 'accounting', 'service', 'services',
  'marketing', 'booking', 'bookings', 'orders', 'operations', 'general', 'reception', 'webmaster', 'privacy', 'media', 'press',
]);

const EMAIL_RE = /[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}/gi;
const EMAIL_EXACT = new RegExp(`^${EMAIL_RE.source}$`, 'i');

/** Text a visitor can read: comments, scripts, styles and other non-rendered blocks removed, tags dropped, entities decoded. */
function visibleText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head|iframe|object)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(?:script|style)\b[\s\S]*$/i, ' ') // an unclosed script/style hides the rest of the page
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(stripped);
}

/** `name [at] domain [dot] com`, `name(at)domain(dot)com` → `name@domain.com`. */
function deobfuscate(text: string): string {
  return text
    .replace(/\s*[[({]\s*at\s*[\])}]\s*/gi, '@')
    .replace(/\s*[[({]\s*dot\s*[\])}]\s*/gi, '.');
}

/** Addresses from `mailto:` hrefs (each must be a whole, plain address). */
function mailtoAddresses(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const value = decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!/^mailto:/i.test(value)) continue;
    let target = value.slice('mailto:'.length).split('?')[0]!;
    try {
      target = decodeURIComponent(target);
    } catch {
      continue;
    }
    for (const addr of target.split(',')) {
      const a = addr.trim();
      if (EMAIL_EXACT.test(a)) out.push(a);
    }
  }
  return out;
}

/** True when the address is plausible and published for this site: its domain, or a free-mail host. */
function acceptable(email: string, siteDomain: string): boolean {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const host = email.slice(at + 1);
  const tld = host.slice(host.lastIndexOf('.') + 1);
  if (FILE_EXTENSIONS.has(tld)) return false;
  if (NO_REPLY.test(local)) return false;
  if (/^[0-9a-f]{16,}$/.test(local)) return false; // tracking ids / hashes
  const r = parse(host);
  if (r.isIp || !r.isIcann || !r.domain) return false;
  if (PLACEHOLDER_LABELS.has(r.domainWithoutSuffix ?? '')) return false;
  return r.domain === siteDomain || FREE_MAIL.has(host);
}

const isRole = (email: string) => ROLE_INBOXES.has(email.slice(0, email.indexOf('@')).replace(/[._-]/g, ''));

/**
 * Plausible addresses published on one page of a site: from `mailto:` links and visible text (with simple `[at]`/`[dot]`
 * obfuscation decoded), lowercased, deduplicated. Kept only on the site's registrable domain or a free-mail host;
 * asset names, placeholder domains and no-reply inboxes are dropped. Named people come before role inboxes.
 */
export function extractEmails(html: string, siteUrl: string): FoundEmail[] {
  const siteDomain = prospectDomain(siteUrl);
  if (!siteDomain) return [];
  const candidates = [...mailtoAddresses(html), ...(deobfuscate(visibleText(html)).match(EMAIL_RE) ?? [])];
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const c of candidates) {
    const email = c.toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    if (acceptable(email, siteDomain)) kept.push(email);
  }
  // Stable: page order within each group.
  return [...kept.filter((e) => !isRole(e)), ...kept.filter(isRole)].map((email) => ({ email, foundOn: siteUrl }));
}

// ---- Discovery -----------------------------------------------------------------------------------

export type EmailDeps = Pick<StageDeps, 'db' | 'fetchPage' | 'log'>;
type Prospect = typeof prospects.$inferSelect;

export type EmailDiscovery = {
  /** found: stored now · kept: the prospect already had an email · none: nothing usable · blocked: site must not be fetched. */
  status: 'found' | 'kept' | 'none' | 'blocked';
  email: string | null;
  sourceUrl?: string;
  fetches: number;
};

/** Global Constraint: never fetch or submit anything to the owner's pilot site. */
const NEVER_FETCH_DOMAINS = new Set(['gamersgetaway.ca']);
const FALLBACK_PATHS = ['/contact', '/contact-us', '/about'];
const MAX_FETCHES = 3;
const MAX_LINKED = 2;

/** Same-site contact/about pages the homepage links to (contact first), then the usual paths. */
function followUpUrls(homeHtml: string, base: string, domain: string): string[] {
  const linked: string[] = [];
  for (const m of homeHtml.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    let u: URL;
    try {
      u = new URL(decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim(), base);
    } catch {
      continue;
    }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || prospectDomain(u.href) !== domain) continue;
    if (!/contact|about/i.test(u.pathname)) continue;
    u.hash = '';
    if (!linked.includes(u.href)) linked.push(u.href);
  }
  linked.sort((a, b) => Number(!/contact/i.test(new URL(a).pathname)) - Number(!/contact/i.test(new URL(b).pathname)));
  const fallback = FALLBACK_PATHS.map((p) => new URL(p, base).href);
  return [...new Set([...linked.slice(0, MAX_LINKED), ...fallback])];
}

/**
 * Find a self-published address on the prospect's own site: a guarded GET of the homepage, then contact/about pages,
 * at most 3 fetches, stopping at the first page with a usable (not suppressed) address. Stores the address with the page
 * it was on, the capture time and CASL basis `self_published`. An existing email (owner-entered or earlier) is never
 * overwritten, including one set while discovery runs.
 */
export async function discoverEmails({ db, fetchPage, log }: EmailDeps, prospect: Prospect): Promise<EmailDiscovery> {
  if (prospect.email) return { status: 'kept', email: prospect.email, fetches: 0 };
  const domain = prospectDomain(prospect.website);
  if (!domain || NEVER_FETCH_DOMAINS.has(domain) || NEVER_FETCH_DOMAINS.has(prospect.domain) || isBannedSource(prospect.website)) {
    log(`emails: not fetching ${capField(prospect.website, 200)} (blocked or invalid site)`);
    return { status: 'blocked', email: null, fetches: 0 };
  }

  const queue = [prospect.website];
  const tried = new Set<string>();
  let fetches = 0;
  while (fetches < MAX_FETCHES && queue.length > 0) {
    const url = queue.shift()!;
    if (tried.has(url)) continue;
    tried.add(url);
    const page = await fetchPage(url);
    fetches++;
    const onSite = page.ok && prospectDomain(page.finalUrl) === domain;
    if (fetches === 1) queue.push(...followUpUrls(onSite ? (page.html ?? '') : '', onSite ? page.finalUrl : prospect.website, domain));
    if (!page.ok || page.html === undefined) continue;
    if (!onSite) {
      log(`emails: ${capField(url, 200)} redirected off ${domain} to ${capField(page.finalUrl, 200)}; ignored`);
      continue;
    }

    const found = extractEmails(page.html, page.finalUrl);
    if (found.length === 0) continue;
    const blocked = new Set(
      (await db.select({ email: suppressions.email }).from(suppressions).where(inArray(suppressions.email, found.map((f) => f.email))))
        .map((r) => r.email),
    );
    if (blocked.size) log(`emails: skipped ${blocked.size} suppressed address(es) on ${capField(page.finalUrl, 200)}`);
    const pick = found.find((f) => !blocked.has(f.email));
    if (!pick) continue;

    const updated = await db.update(prospects)
      .set({ email: pick.email, emailSourceUrl: pick.foundOn, emailCapturedAt: new Date(), caslBasis: 'self_published' })
      .where(and(eq(prospects.id, prospect.id), isNull(prospects.email)))
      .returning({ id: prospects.id });
    if (updated.length === 0) {
      const [current] = await db.select({ email: prospects.email }).from(prospects).where(eq(prospects.id, prospect.id));
      return { status: 'kept', email: current?.email ?? null, fetches };
    }
    return { status: 'found', email: pick.email, sourceUrl: pick.foundOn, fetches };
  }
  return { status: 'none', email: null, fetches };
}
