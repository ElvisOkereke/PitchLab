import type { Db } from '../db/client';
import { BANNED_DOMAINS, isBannedSource } from '../tools/banned-sources';
import { extract, type FetchPageOpts, type PageResult } from '../tools/fetch-page';
import type { ArchiveClient } from './archive';
import { classifyFetch, recordFetch, type FetchOutcome, type FetchVia } from './fetch-log';
import { SourceError, USER_AGENT } from './http';

/** Readable text under this many characters means a page that probably renders client-side. */
export const THIN_TEXT_CHARS = 800;

/** Renders a page in a real browser (Task 3). Null means it declined or could not. */
export type BrowserRenderer = { render(url: string): Promise<{ html: string; finalUrl: string } | null> };

export type CollectCtx = {
  db: Db;
  fetchPage: (url: string, opts: FetchPageOpts) => Promise<PageResult>;
  robotsAllows: (url: string) => Promise<boolean>;
  archive?: ArchiveClient;
  browser?: BrowserRenderer | null;
  missionId?: string;
  log: (message: string) => void;
  state: { archiveDisabled: boolean };
};

export type Collected =
  | { text: string; title: string; finalUrl: string; via: FetchVia; snapshotAt?: Date }
  | { failed: FetchOutcome };

/** Failures worth an archive lookup: the page is gone, forbidden or down, not a client or content problem. */
const ARCHIVE_OUTCOMES: ReadonlySet<FetchOutcome> = new Set(['http_403', 'http_404', 'http_410', 'http_5xx', 'timeout']);

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/**
 * One web page, politely: robots.txt, then a direct guarded fetch; a thin result goes to the browser (if any); a gone or
 * blocked page goes to the Internet Archive (if robots allows the snapshot). Every attempt is logged; never throws.
 */
export async function collectPage(url: string, ctx: CollectCtx): Promise<Collected> {
  const { db, missionId, state } = ctx;
  const record = (u: string, outcome: FetchOutcome, via: FetchVia, status?: number) => recordFetch(db, { url: u, outcome, via, status, missionId });

  if (!(await ctx.robotsAllows(url))) {
    await record(url, 'blocked_robots', 'direct');
    return { failed: 'blocked_robots' };
  }
  const direct = await ctx.fetchPage(url, { userAgent: USER_AGENT, blockHosts: BANNED_DOMAINS });

  if (direct.ok) {
    const finalUrl = direct.finalUrl || url;
    const redirected = finalUrl !== url && finalUrl !== new URL(url).href;
    // After any redirect, re-check: a banned domain or a robots-disallowed path drops the text.
    if (isBannedSource(finalUrl)) {
      await record(finalUrl, 'blocked_host', 'direct', direct.status);
      return { failed: 'blocked_host' };
    }
    if (redirected && !(await ctx.robotsAllows(finalUrl))) {
      await record(finalUrl, 'blocked_robots', 'direct', direct.status);
      return { failed: 'blocked_robots' };
    }
    if (direct.text.trim().length >= THIN_TEXT_CHARS) {
      await record(url, 'ok', 'direct', direct.status);
      return { text: direct.text, title: direct.title, finalUrl, via: 'direct' };
    }
    await record(url, 'thin_text', 'direct', direct.status);
    const rendered = ctx.browser ? await renderSafely(ctx.browser, url, finalUrl, ctx) : null;
    if (ctx.browser && !rendered) await record(finalUrl, 'network', 'browser'); // tried: declined or dropped
    if (rendered) {
      const thin = rendered.text.trim().length < THIN_TEXT_CHARS;
      await record(rendered.finalUrl, thin ? 'thin_text' : 'ok', 'browser');
      if (rendered.text.trim().length > direct.text.trim().length) return { ...rendered, via: 'browser' };
    }
    return { text: direct.text, title: direct.title, finalUrl, via: 'direct' };
  }

  const outcome = classifyFetch(direct);
  await record(url, outcome, 'direct', direct.status || undefined);
  if (!ARCHIVE_OUTCOMES.has(outcome) || !ctx.archive || state.archiveDisabled) return { failed: outcome };

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
    if (!(await ctx.robotsAllows(snap.snapshotUrl))) {
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

async function renderSafely(browser: BrowserRenderer, url: string, finalUrl: string, ctx: CollectCtx) {
  try {
    const r = await browser.render(finalUrl);
    if (!r) return null;
    if (isBannedSource(r.finalUrl) || (r.finalUrl !== finalUrl && !(await ctx.robotsAllows(r.finalUrl)))) return null;
    const { title, text } = extract(r.html);
    return { text, title, finalUrl: r.finalUrl };
  } catch {
    ctx.log(`browser: ${hostOf(url)} render failed`);
    return null;
  }
}
