import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { FIND_STATUSES, finds } from '../db/schema';

/** Web-safe: drizzle-orm and the schema only (the Finds page uses it). Bound parameters only. */

export type FindSource = 'telegram' | 'paste';
export type FindStatus = (typeof FIND_STATUSES)[number];
export type FindRow = typeof finds.$inferSelect;
export type FindAddOutcome = 'added' | 'duplicate' | 'invalid';

export const FIND_URL_MAX = 2000;
export const FIND_NOTE_MAX = 500;
/** Most finds one call may add (a paste box or one Telegram message). */
export const FIND_BATCH_MAX = 50;
const LIST_MAX = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Query parameters that only track who shared a link or where it was clicked; they never change what it points to. */
const TRACKING = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid', 'igsh', 'igshid', 'si', 'feature', 'is_from_webapp', 'sender_device',
  'share_id', 'share_app_id', 'mibextid', 'ref', 'ref_src', 'ref_url', 'rdid', 'xmt', 'slof', '_t', '_r',
]);
/** X's `?s=20` / `?t=…` share markers (elsewhere `s` is often a search query, so only on X). */
const X_TRACKING = new Set(['s', 't']);
const isXHost = (host: string) => ['x.com', 'twitter.com'].some((h) => host === h || host.endsWith(`.${h}`));
const isTracking = (k: string, host: string) => TRACKING.has(k.toLowerCase()) || /^utm_/i.test(k) || (isXHost(host) && X_TRACKING.has(k.toLowerCase()));
// Invisible / bidi / control characters (the same set as llm/untrusted, kept local so this file stays web-safe).
const INVISIBLE = /[\p{Cf}͏ᅟᅠ឴឵᠋-᠎ㅤﾠ\u{1D173}-\u{1D17A}\p{Cc}]/gu;

/**
 * One form per link: http(s) only (no credentials), host lowercased, default port, fragment and tracking parameters
 * dropped, the remaining parameters sorted, and a trailing slash removed. Null when it is not a usable link.
 */
export function normalizeFindUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > FIND_URL_MAX) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || !u.hostname) return null;
  u.hash = '';
  const kept = [...u.searchParams.entries()].filter(([k]) => !isTracking(k, u.hostname)).sort(([a, x], [b, y]) => (a === b ? x.localeCompare(y) : a.localeCompare(b)));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  let out = u.toString();
  if (u.pathname === '/' && !u.search) out = out.replace(/\/$/, '');
  return out.length <= FIND_URL_MAX ? out : null;
}

const PLATFORM_HOSTS: [string, string[]][] = [
  ['instagram', ['instagram.com', 'instagr.am']],
  ['tiktok', ['tiktok.com']],
  ['youtube', ['youtube.com', 'youtu.be']],
  ['x', ['x.com', 'twitter.com']],
  ['threads', ['threads.net', 'threads.com']],
  ['linkedin', ['linkedin.com']],
  ['facebook', ['facebook.com', 'fb.watch', 'fb.com']],
];

/** The platform a link is on, from its host (the capture service names it again from what it finds). */
export function findPlatform(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return 'other';
  }
  for (const [name, hosts] of PLATFORM_HOSTS) if (hosts.some((h) => host === h || host.endsWith(`.${h}`))) return name;
  return 'other';
}

const cleanNote = (note: string | undefined): string | null => {
  const n = (note ?? '').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().slice(0, FIND_NOTE_MAX).trim();
  return n || null;
};

/**
 * Queues shared links as finds, one per normalised url. A link already saved (or repeated in the same call) is a
 * duplicate and changes nothing; a link that is not http(s) is invalid. At most FIND_BATCH_MAX items are read.
 */
export async function addFinds(
  db: Db,
  items: { url: string; note?: string; source: FindSource }[],
): Promise<{ added: number; duplicates: number; invalid: number; results: { url: string; outcome: FindAddOutcome; id?: string }[] }> {
  const results: { url: string; outcome: FindAddOutcome; id?: string }[] = [];
  for (const it of items.slice(0, FIND_BATCH_MAX)) {
    const url = normalizeFindUrl(it.url);
    if (!url) {
      results.push({ url: it.url.slice(0, 200), outcome: 'invalid' });
      continue;
    }
    const [row] = await db.insert(finds)
      .values({ url, platform: findPlatform(url), note: cleanNote(it.note), source: it.source })
      .onConflictDoNothing({ target: finds.url })
      .returning({ id: finds.id });
    results.push(row ? { url, outcome: 'added', id: row.id } : { url, outcome: 'duplicate' });
  }
  const count = (o: FindAddOutcome) => results.filter((r) => r.outcome === o).length;
  return { added: count('added'), duplicates: count('duplicate'), invalid: count('invalid'), results };
}

/** Newest first, at most `limit` (default and cap 200), optionally of some statuses. */
export async function listFinds(db: Db, o: { limit?: number; statuses?: FindStatus[] } = {}): Promise<FindRow[]> {
  const limit = Math.min(Math.max(1, Math.floor(o.limit ?? LIST_MAX)), LIST_MAX);
  return db.select().from(finds)
    .where(o.statuses?.length ? inArray(finds.status, o.statuses) : undefined)
    .orderBy(desc(finds.createdAt), desc(finds.id))
    .limit(limit);
}

/** Puts a failed find back in the queue (error and warnings cleared). False when it is not failed or does not exist. */
export async function retryFind(db: Db, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const r = await db.update(finds)
    .set({ status: 'queued', error: null, warnings: [], startedAt: null })
    .where(and(eq(finds.id, id), eq(finds.status, 'failed')))
    .returning({ id: finds.id });
  return r.length > 0;
}

/** Deletes a find (its library entry, if any, stays). False when it does not exist or is being captured right now. */
export async function deleteFind(db: Db, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const r = await db.delete(finds)
    .where(and(eq(finds.id, id), sql`${finds.status} <> 'capturing'`))
    .returning({ id: finds.id });
  return r.length > 0;
}
