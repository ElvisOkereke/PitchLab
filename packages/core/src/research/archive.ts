import { fetchPage as realFetchPage, type FetchPageOpts, type PageResult } from '../tools/fetch-page';
import { request, throttle, USER_AGENT, type HttpOpts } from './http';

/**
 * Internet Archive fallback for pages that failed directly. The availability endpoint is a fixed host (through request(),
 * no redirects); snapshot bodies are fetched through the SSRF-guarded fetchPage with the research user agent. Both share
 * one throttle (1 request per second).
 */
export type Snapshot = { snapshotUrl: string; timestamp: Date };

export interface ArchiveClient {
  snapshot(url: string): Promise<Snapshot | null>;
  fetch(snapshot: Snapshot): Promise<PageResult>;
}

const ARCHIVE_HOST = 'web.archive.org';
const THROTTLE_KEY = 'archive.org';
const MIN_INTERVAL_MS = 1000;
const AVAILABLE_URL = 'https://archive.org/wayback/available?url=';
const DAY_MS = 86_400_000;

type Opts = { fetchJson?: (url: string) => Promise<unknown>; now?: () => Date; maxAgeYears?: number; http?: HttpOpts };

function parseTimestamp(ts: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(ts);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The closest snapshot (raw `id_` form: no toolbar or rewritten links) no older than `maxAgeYears`, or null. 429 throws rate_limited. */
export async function archiveSnapshot(url: string, opts: Opts = {}): Promise<Snapshot | null> {
  const { maxAgeYears = 3, now = () => new Date() } = opts;
  await throttle(THROTTLE_KEY, MIN_INTERVAL_MS, opts.http);
  const api = AVAILABLE_URL + encodeURIComponent(url);
  const json = (await (opts.fetchJson ? opts.fetchJson(api) : request('archive', api, {}, opts.http))) as {
    archived_snapshots?: { closest?: { available?: boolean; url?: string; timestamp?: string } };
  } | null;
  const closest = json?.archived_snapshots?.closest;
  if (!closest?.available || typeof closest.url !== 'string' || typeof closest.timestamp !== 'string') return null;
  const timestamp = parseTimestamp(closest.timestamp);
  if (!timestamp) return null;
  if (now().getTime() - timestamp.getTime() > maxAgeYears * 365.25 * DAY_MS) return null;
  let snap: URL;
  try {
    snap = new URL(closest.url);
  } catch {
    return null;
  }
  const m = /^\/web\/(\d{14})(?:id_)?\/(.+)$/.exec(snap.pathname + snap.search);
  if (snap.hostname !== ARCHIVE_HOST || !m) return null;
  return { snapshotUrl: `https://${ARCHIVE_HOST}/web/${m[1]}id_/${m[2]}`, timestamp };
}

const blocked = (url: string): PageResult => ({ ok: false, status: 0, finalUrl: url, title: '', text: '', reason: 'blocked_host' });

/** Fetches a snapshot's text. A snapshot URL or redirect target off web.archive.org is refused (its content is discarded). */
export async function fetchArchived(
  snapshot: Snapshot,
  deps: { fetchPage?: (url: string, opts: FetchPageOpts) => Promise<PageResult>; http?: HttpOpts },
): Promise<PageResult> {
  let host: string;
  try {
    host = new URL(snapshot.snapshotUrl).hostname;
  } catch {
    return blocked(snapshot.snapshotUrl);
  }
  if (host !== ARCHIVE_HOST) return blocked(snapshot.snapshotUrl);
  await throttle(THROTTLE_KEY, MIN_INTERVAL_MS, deps.http);
  const r = await (deps.fetchPage ?? realFetchPage)(snapshot.snapshotUrl, { userAgent: USER_AGENT });
  let finalHost = '';
  try {
    finalHost = new URL(r.finalUrl).hostname;
  } catch {
    // unparseable final URL: refused below
  }
  if (finalHost !== ARCHIVE_HOST) return blocked(r.finalUrl || snapshot.snapshotUrl);
  return r;
}

/** The real client: availability lookups plus guarded snapshot fetches. */
export function createArchiveClient(deps: { fetchPage?: (url: string, opts: FetchPageOpts) => Promise<PageResult>; http?: HttpOpts; now?: () => Date } = {}): ArchiveClient {
  return {
    snapshot: (url) => archiveSnapshot(url, { now: deps.now, http: deps.http }),
    fetch: (snapshot) => fetchArchived(snapshot, deps),
  };
}
