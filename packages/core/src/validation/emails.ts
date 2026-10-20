import { and, eq, inArray, isNull } from 'drizzle-orm';
import { parseHTML } from 'linkedom';
import { parse } from 'tldts';
import { prospects, suppressions } from '../db/schema';
import { capField } from '../llm/untrusted';
import type { StageDeps } from '../pipeline/types';
import { isBannedSource } from '../tools/banned-sources';
import { isNeverFetchHost } from '../tools/fetch-page';
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

/** Elements whose content a visitor never reads as page text. */
const HIDDEN_ELEMENTS = 'script, style, noscript, template, svg, iframe, object, head';

type PageDom = ReturnType<typeof parseHTML>['document'];

/** Most characters of a page that are parsed; above this the first PARSE_HEAD and the rest from the end are kept. */
export const PARSE_MAX = 200_000;
const PARSE_HEAD = 120_000;

/** Parse with linkedom (linear, no regex over raw HTML) and drop non-rendered elements. Comments are not elements. */
function parseClean(html: string): PageDom {
  const { document } = parseHTML(/<html[\s>]/i.test(html) ? html : `<html><body>${html}</body></html>`);
  for (const el of [...document.querySelectorAll(HIDDEN_ELEMENTS)]) el.remove();
  return document;
}

/**
 * The cleaned DOM(s) of a page; text, mailto links and page links all come from these. Parsing cost grows with nesting
 * (60k nested divs at 500 KB take seconds), so a page longer than PARSE_MAX is parsed as two independent documents: its
 * start and its end (where contact details usually sit in the footer). They are never spliced together, so an unclosed
 * comment or tag in the head cannot swallow the footer (ruling P3-R6). A partial tag at the start of the tail is dropped.
 */
function cleanDoms(raw: string): PageDom[] {
  if (raw.length <= PARSE_MAX) return [parseClean(raw)];
  let tail = raw.slice(raw.length - (PARSE_MAX - PARSE_HEAD));
  const gt = tail.indexOf('>');
  const lt = tail.indexOf('<');
  if (gt >= 0 && (lt < 0 || gt < lt)) tail = tail.slice(gt + 1); // the cut landed inside a tag
  return [parseClean(raw.slice(0, PARSE_HEAD)), parseClean(`<html><body>${tail}</body></html>`)];
}

type DomNode = { nodeType: number; nodeValue: string | null; childNodes: ArrayLike<DomNode> };

/**
 * The page's text nodes in order. Adjacent text nodes join directly (the parser may split "ops&#64;x.com" into several),
 * and every element boundary adds a space so adjacent elements never glue words together. Iterative: deep trees are fine.
 */
function visibleText(document: PageDom): string {
  const root = (document.body ?? document.documentElement) as unknown as DomNode | null;
  if (!root) return '';
  const parts: string[] = [];
  const stack: (DomNode | null)[] = [root]; // null = element boundary
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node === null) parts.push(' ');
    else if (node.nodeType === 3) parts.push(node.nodeValue ?? '');
    else if (node.nodeType === 1) {
      parts.push(' ');
      stack.push(null);
      const kids = node.childNodes;
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    }
  }
  return parts.join('');
}

/** `name [at] domain [dot] com`, `name(at)domain(dot)com` → `name@domain.com`. Whitespace is collapsed first, so each pattern is linear. */
function deobfuscate(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/ ?[[({] ?at ?[\])}] ?/gi, '@')
    .replace(/ ?[[({] ?dot ?[\])}] ?/gi, '.');
}

/** Raw `href` values of the page's links (entity-decoded by the parser, not trimmed). */
function hrefs(document: PageDom): string[] {
  return [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? '');
}

/** Addresses from `mailto:` hrefs. Each must be a whole, plain address; any whitespace (raw or %-decoded) rejects it. */
function mailtoAddresses(document: PageDom): string[] {
  const out: string[] = [];
  for (const value of hrefs(document)) {
    if (!/^mailto:/i.test(value) || /\s/.test(value)) continue;
    let target = value.slice('mailto:'.length).split('?')[0]!;
    try {
      target = decodeURIComponent(target);
    } catch {
      continue;
    }
    for (const addr of target.split(',')) {
      if (!/\s/.test(addr) && EMAIL_EXACT.test(addr)) out.push(addr);
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
 * asset names, placeholder domains and no-reply inboxes are dropped. Same-domain addresses come before free-mail ones, and named people before role inboxes.
 */
export function extractEmails(html: string, siteUrl: string): FoundEmail[] {
  return extractFromDoms(cleanDoms(html), siteUrl);
}

function extractFromDoms(documents: PageDom[], siteUrl: string): FoundEmail[] {
  const siteDomain = prospectDomain(siteUrl);
  if (!siteDomain) return [];
  // Union over the page's documents (one, or head and tail of a large page), in page order.
  const candidates = documents.flatMap((d) => [...mailtoAddresses(d), ...(deobfuscate(visibleText(d)).match(EMAIL_RE) ?? [])]);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const c of candidates) {
    const email = c.toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    if (acceptable(email, siteDomain)) kept.push(email);
  }
  // Rank: same-domain named, same-domain role, free-mail named, free-mail role; page order within each group.
  const rank = (e: string) => (FREE_MAIL.has(e.slice(e.indexOf('@') + 1)) ? 2 : 0) + (isRole(e) ? 1 : 0);
  return kept
    .map((email, i) => ({ email, i }))
    .sort((a, b) => rank(a.email) - rank(b.email) || a.i - b.i)
    .map(({ email }) => ({ email, foundOn: siteUrl }));
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

const FALLBACK_PATHS = ['/contact', '/contact-us', '/about'];
const MAX_FETCHES = 3;
const MAX_LINKED = 2;

/** Same-site contact/about pages the homepage links to (contact first), then the usual paths. */
function followUpUrls(home: PageDom[], base: string, domain: string): string[] {
  const linked: string[] = [];
  for (const href of home.flatMap(hrefs)) {
    let u: URL;
    try {
      u = new URL(href.trim(), base);
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
  // Early block (fetchPage also refuses never-fetch hosts on every hop, including redirects).
  if (!domain || isNeverFetchHost(domain) || isNeverFetchHost(prospect.domain) || isBannedSource(prospect.website)) {
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
    const doms = onSite && page.html !== undefined ? cleanDoms(page.html) : [];
    if (fetches === 1) queue.push(...followUpUrls(doms, onSite ? page.finalUrl : prospect.website, domain));
    if (!page.ok || page.html === undefined) continue;
    if (!onSite) {
      log(`emails: ${capField(url, 200)} redirected off ${domain} to ${capField(page.finalUrl, 200)}; ignored`);
      continue;
    }

    const found = extractFromDoms(doms, page.finalUrl);
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
