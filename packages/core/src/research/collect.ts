import type { Db } from '../db/client';
import { BANNED_DOMAINS, isBannedSource } from '../tools/banned-sources';
import { extract, type FetchPageOpts, type PageResult } from '../tools/fetch-page';
import type { ArchiveClient } from './archive';
import { looksLikeChallenge } from './challenge';
import { classifyFetch, recordFetch, type FetchOutcome, type FetchVia } from './fetch-log';
import { SourceError, USER_AGENT } from './http';

/** Readable text under this many characters means a page that probably renders client-side. */
export const THIN_TEXT_CHARS = 800;

/**
 * Renders a page in a browser. `kind` 'real' is the headed persistent-profile browser (logged as real_browser);
 * otherwise the headless renderer (logged as browser). Null means it declined or could not. `status` is the navigation
 * status when the renderer returns error pages (real mode); absent means 2xx.
 */
export type BrowserRenderer = {
  kind?: 'headless' | 'real';
  render(url: string): Promise<{ html: string; finalUrl: string; status?: number } | null>;
};

/** The scraping-service step (scraper.ts). `skipped`: no provider/key, or the monthly page budget is used up. */
export type ScraperStep = { scrape(url: string): Promise<PageResult | { skipped: 'not_configured' | 'budget' }> };

export type CollectCtx = {
  db: Db;
  fetchPage: (url: string, opts: FetchPageOpts) => Promise<PageResult>;
  robotsAllows: (url: string) => Promise<boolean>;
  archive?: ArchiveClient;
  browser?: BrowserRenderer | null;
  scraper?: ScraperStep | null;
  /** Setting `fetch.respectRobots` (default true). False skips robots.txt; never-fetch and banned hosts are still refused. */
  respectRobots?: boolean;
  missionId?: string;
  log: (message: string) => void;
  state: { archiveDisabled: boolean };
};

export type Collected =
  | { text: string; title: string; finalUrl: string; via: FetchVia; snapshotAt?: Date }
  | { failed: FetchOutcome };

/** Failures worth an archive lookup: the page is gone, forbidden, walled or down, not a client or content problem. */
const ARCHIVE_OUTCOMES: ReadonlySet<FetchOutcome> = new Set(['http_403', 'http_404', 'http_410', 'http_5xx', 'timeout', 'challenge']);

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

const len = (s: string) => s.trim().length;
type Page = { text: string; title: string; finalUrl: string; via: FetchVia };

/**
 * One web page. Order: direct guarded fetch; on a 403, a challenge page or thin text, the browser (the real one when the
 * mission has it); if still blocked (403 or challenge), the scraping service (when a key is set and the monthly budget
 * remains); then the Internet Archive for a page that is gone or still blocked. Thin text alone never spends a scraper
 * page. robots.txt is checked unless `respectRobots` is false; never-fetch and banned hosts are refused first, always.
 * Every attempt (and a skipped scraper step) is logged in page_fetches; never throws.
 */
export async function collectPage(url: string, ctx: CollectCtx): Promise<Collected> {
  const { db, missionId } = ctx;
  const record = (u: string, outcome: FetchOutcome, via: FetchVia, status?: number) => recordFetch(db, { url: u, outcome, via, status, missionId });
  const allows = (u: string) => (ctx.respectRobots === false ? Promise.resolve(true) : ctx.robotsAllows(u));

  if (isBannedSource(url)) {
    await record(url, 'blocked_host', 'direct');
    return { failed: 'blocked_host' };
  }
  if (!(await allows(url))) {
    await record(url, 'blocked_robots', 'direct');
    return { failed: 'blocked_robots' };
  }
  const direct = await ctx.fetchPage(url, { userAgent: USER_AGENT, blockHosts: BANNED_DOMAINS });

  /** Why the page is still blocked (403 or challenge), or null when it is not. */
  let blocked: FetchOutcome | null = null;
  /** The best readable result so far (thin text). */
  let best: Page | null = null;
  let renderFrom = url;

  if (direct.ok) {
    const finalUrl = direct.finalUrl || url;
    const redirected = finalUrl !== url && finalUrl !== new URL(url).href;
    // After any redirect, re-check: a banned domain or a robots-disallowed path drops the text.
    if (isBannedSource(finalUrl)) {
      await record(finalUrl, 'blocked_host', 'direct', direct.status);
      return { failed: 'blocked_host' };
    }
    if (redirected && !(await allows(finalUrl))) {
      await record(finalUrl, 'blocked_robots', 'direct', direct.status);
      return { failed: 'blocked_robots' };
    }
    renderFrom = finalUrl;
    if (looksLikeChallenge(direct.html ?? direct.title)) {
      await record(url, 'challenge', 'direct', direct.status);
      blocked = 'challenge';
    } else if (len(direct.text) >= THIN_TEXT_CHARS) {
      await record(url, 'ok', 'direct', direct.status);
      return { text: direct.text, title: direct.title, finalUrl, via: 'direct' };
    } else {
      await record(url, 'thin_text', 'direct', direct.status);
      best = { text: direct.text, title: direct.title, finalUrl, via: 'direct' };
    }
  } else {
    const outcome = classifyFetch(direct);
    await record(url, outcome, 'direct', direct.status || undefined);
    if (outcome === 'http_403') blocked = outcome;
    else if (ARCHIVE_OUTCOMES.has(outcome)) return fromArchive(url, outcome, ctx, allows, record);
    else return { failed: outcome };
  }

  // 2. The browser: for a blocked or thin page.
  if (ctx.browser) {
    const via: FetchVia = ctx.browser.kind === 'real' ? 'real_browser' : 'browser';
    const r = await renderSafely(ctx.browser, url, renderFrom, ctx, allows);
    if (!r) await record(renderFrom, 'network', via); // tried: declined, dropped or failed
    else {
      const thin = len(r.text) < THIN_TEXT_CHARS;
      const errorStatus = r.status !== undefined && (r.status < 200 || r.status >= 300);
      if (looksLikeChallenge(r.html)) await record(r.finalUrl, 'challenge', via, r.status);
      else if (errorStatus && thin) await record(r.finalUrl, r.status === 403 ? 'http_403' : 'http_4xx', via, r.status);
      else {
        await record(r.finalUrl, thin ? 'thin_text' : 'ok', via, r.status);
        const page: Page = { text: r.text, title: r.title, finalUrl: r.finalUrl, via };
        if (!thin) return page;
        // A thin page that loaded: keep whichever text is longer; a block that cleared to a thin page is not blocked.
        if (!best || len(r.text) > len(best.text)) best = page;
        blocked = null;
      }
    }
  }
  if (!blocked) return best ?? { failed: 'thin_text' };

  // 3. The scraping service: only for a page still blocked.
  const scraped = ctx.scraper ? await scrapeSafely(ctx.scraper, url, ctx) : ({ skipped: 'not_configured' } as const);
  if ('skipped' in scraped) await record(url, 'skipped', 'scraper');
  else if (scraped.ok && isBannedSource(scraped.finalUrl || url)) await record(url, 'blocked_host', 'scraper', scraped.status);
  else if (scraped.ok && looksLikeChallenge(scraped.html ?? scraped.title)) await record(url, 'challenge', 'scraper', scraped.status);
  else if (scraped.ok && len(scraped.text) > 0) {
    await record(url, len(scraped.text) < THIN_TEXT_CHARS ? 'thin_text' : 'ok', 'scraper', scraped.status);
    // The original's address stays the source URL; the provider never becomes a citation.
    return { text: scraped.text, title: scraped.title, finalUrl: url, via: 'scraper' };
  } else await record(url, scraped.ok ? 'thin_text' : classifyFetch(scraped), 'scraper', scraped.status || undefined);

  // 4. The archive.
  return fromArchive(url, blocked, ctx, allows, record);
}

async function fromArchive(
  url: string,
  outcome: FetchOutcome,
  ctx: CollectCtx,
  allows: (u: string) => Promise<boolean>,
  record: (u: string, outcome: FetchOutcome, via: FetchVia, status?: number) => Promise<void>,
): Promise<Collected> {
  const { state } = ctx;
  if (!ctx.archive || state.archiveDisabled) return { failed: outcome };
  const archive = ctx.archive;
  // Archive attempts are logged under the original page's domain (via 'archive'), so the diagnostics show which sites
  // needed the archive instead of ranking archive.org as a failing domain.
  const recordArchive = (o: FetchOutcome, status?: number) => record(url, o, 'archive', status);
  const disable = () => {
    state.archiveDisabled = true;
    ctx.log('archive: rate limited by archive.org, not used for the rest of this mission');
  };
  try {
    const snap = await archive.snapshot(url);
    if (!snap) {
      await recordArchive('http_404', 404); // tried: no usable snapshot
      return { failed: outcome };
    }
    await archive.pace?.();
    if (!(await allows(snap.snapshotUrl))) {
      await recordArchive('blocked_robots');
      return { failed: outcome };
    }
    const page = await archive.fetch(snap);
    const empty = page.ok && page.text.trim() === '';
    await recordArchive(empty ? 'thin_text' : classifyFetch(page), page.status || undefined);
    if (!page.ok || empty) {
      if (page.status === 429) disable();
      return { failed: outcome };
    }
    // The original's address stays the source URL; the archive host never becomes a citation.
    return { text: page.text, title: page.title, finalUrl: url, via: 'archive', snapshotAt: snap.timestamp };
  } catch (e) {
    const limited = e instanceof SourceError && e.code === 'rate_limited';
    if (limited) disable();
    else ctx.log(`archive: ${hostOf(url)} lookup failed`);
    await recordArchive(limited ? 'http_4xx' : 'network', limited ? 429 : undefined);
    return { failed: outcome };
  }
}

async function renderSafely(browser: BrowserRenderer, url: string, finalUrl: string, ctx: CollectCtx, allows: (u: string) => Promise<boolean>) {
  try {
    const r = await browser.render(finalUrl);
    if (!r) return null;
    if (isBannedSource(r.finalUrl) || (r.finalUrl !== finalUrl && !(await allows(r.finalUrl)))) return null;
    const { title, text } = extract(r.html);
    return { text, title, finalUrl: r.finalUrl, html: r.html, status: r.status };
  } catch {
    ctx.log(`browser: ${hostOf(url)} render failed`);
    return null;
  }
}

async function scrapeSafely(scraper: ScraperStep, url: string, ctx: CollectCtx): Promise<PageResult | { skipped: 'not_configured' | 'budget' }> {
  try {
    return await scraper.scrape(url);
  } catch {
    ctx.log(`scraper: ${hostOf(url)} request failed`);
    return { ok: false, status: 0, finalUrl: url, title: '', text: '', reason: 'network' };
  }
}
