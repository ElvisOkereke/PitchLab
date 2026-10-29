import type { KnowledgeDraft } from '../../library/kinds';
import { capField } from '../../llm/untrusted';
import { request, SourceError, throttle } from '../http';
import { httpOf, type CollectorOpts } from './federalregister';

export const sourceType = 'wikipedia';
export const MIN_INTERVAL_MS = 200;
export const MIN_TOTAL_VIEWS = 1000;
export const METRIC = 'Wikipedia monthly views (people, not bots)';
const WIKI = 'en.wikipedia.org';
const METRICS = 'wikimedia.org';

export type TrendDirection = 'rising' | 'falling' | 'steady';

/** At least +20% is rising, at most -20% is falling. From nothing to something is rising; nothing to nothing is steady. */
export function trendDirection(prev: number, last: number): TrendDirection {
  if (prev <= 0) return last > 0 ? 'rising' : 'steady';
  const change = (last - prev) / prev;
  if (change >= 0.2) return 'rising';
  if (change <= -0.2) return 'falling';
  return 'steady';
}

export function percentText(prev: number, last: number): string {
  if (prev <= 0) return last > 0 ? 'up from none' : 'no change';
  const pct = Math.round(((last - prev) / prev) * 100);
  return `${pct > 0 ? '+' : ''}${pct}%`;
}

/** The plain-words summary shared by both trend collectors, e.g. "rose 34% (label)". */
export function trendPhrase(direction: TrendDirection, prev: number, last: number, label: string): string {
  const change = percentText(prev, last);
  if (direction === 'steady') return `held steady (${change}, ${label})`;
  return `${direction === 'rising' ? 'rose' : 'fell'} ${change.replace(/^[+-]/, '')} (${label})`;
}

/** The 36 full calendar months before `now`: first day of the oldest and last day of the newest as YYYYMMDD00. */
export function pageviewWindow(now: Date): { start: string; end: string; startMonth: number } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const startD = new Date(Date.UTC(y, m - 36, 1));
  const endD = new Date(Date.UTC(y, m, 0));
  const f = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}00`;
  return { start: f(startD), end: f(endD), startMonth: startD.getUTCFullYear() * 12 + startD.getUTCMonth() };
}

export async function wikiTrend(topic: string, opts: CollectorOpts = {}): Promise<KnowledgeDraft | null> {
  const now = (opts.now ?? (() => new Date()))();
  await throttle(WIKI, MIN_INTERVAL_MS, { sleep: opts.sleep });
  const found = (await request(
    'wikipedia',
    `https://${WIKI}/w/api.php?action=opensearch&limit=1&namespace=0&format=json&search=${encodeURIComponent(topic)}`,
    {},
    httpOf(opts),
  )) as unknown;
  const title = Array.isArray(found) && Array.isArray(found[1]) && typeof found[1][0] === 'string' ? (found[1][0] as string) : '';
  // A title of only dots would become a "." or ".." path segment in the pageviews url.
  if (!title || /^\.+$/.test(title)) return null;
  if (/\(disambiguation\)\s*$/i.test(title)) {
    opts.log?.(`wikipedia: "${topic}" resolved to a disambiguation page, skipped`);
    return null;
  }
  const w = pageviewWindow(now);
  const article = encodeURIComponent(title.replace(/ /g, '_'));
  await throttle(METRICS, MIN_INTERVAL_MS, { sleep: opts.sleep });
  let json: { items?: unknown } | null;
  try {
    json = (await request(
      'wikipedia',
      `https://${METRICS}/api/rest_v1/metrics/pageviews/per-article/${WIKI}/all-access/user/${article}/monthly/${w.start}/${w.end}`,
      {},
      httpOf(opts),
    )) as { items?: unknown } | null;
  } catch (e) {
    // The metrics API answers 404 for an article with no recorded views.
    if (e instanceof SourceError && e.code === 'http_error' && /HTTP 404/.test(e.message)) return null;
    throw e;
  }
  if (!json || !Array.isArray(json.items)) {
    opts.log?.('wikipedia: pageview response had no items');
    return null;
  }
  let last = 0;
  let prev = 0;
  let total = 0;
  for (const it of json.items as { timestamp?: unknown; views?: unknown }[]) {
    const ts = typeof it?.timestamp === 'string' ? /^(\d{4})(\d{2})/.exec(it.timestamp) : null;
    if (!ts || typeof it.views !== 'number' || !Number.isFinite(it.views) || it.views < 0) continue;
    const idx = Number(ts[1]) * 12 + (Number(ts[2]) - 1) - w.startMonth; // 0..35
    if (idx < 0 || idx > 35) continue;
    total += it.views;
    if (idx >= 24) last += it.views;
    else if (idx >= 12) prev += it.views;
  }
  if (total < MIN_TOTAL_VIEWS) return null;
  const direction = trendDirection(prev, last);
  return {
    kind: 'trend',
    title: capField(`Interest in ${title} (Wikipedia views)`, 200),
    summary: capField(`Wikipedia views of '${title}' ${trendPhrase(direction, prev, last, 'last 12 months vs the 12 before')}`, 300),
    audience: 'both',
    countries: [],
    industries: [],
    voice: 'neutral',
    facts: {
      topic: capField(title, 200),
      direction,
      evidence: [
        { metric: METRIC, value: String(last), period: 'last 12 months' },
        { metric: METRIC, value: String(prev), period: 'the 12 months before' },
      ],
      window: 'last 36 full months',
      basis: 'measured',
    },
    source: { url: `https://${WIKI}/wiki/${article}`, domain: WIKI, sourceType, quoteVerified: false },
  };
}
