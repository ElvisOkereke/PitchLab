import type { KnowledgeDraft } from '../../library/kinds';
import { capField } from '../../llm/untrusted';
import { request, throttle } from '../http';
import { httpOf, type CollectorOpts } from './federalregister';
import { trendDirection, trendPhrase } from './wikipageviews';

/** Not 'hn': story counts are a measurement, kept apart from HN posts (social share, merge rules, rate-limit key). */
export const sourceType = 'hn-trend';
export const MIN_INTERVAL_MS = 300;
export const MIN_TOTAL_STORIES = 20;
export const METRIC = 'Hacker News stories per year';
const HOST = 'hn.algolia.com';

/** Stories per calendar year for the last 4 complete years; the last full year is compared with the one before. */
export async function hnTrend(q: string, opts: CollectorOpts = {}): Promise<KnowledgeDraft | null> {
  const now = (opts.now ?? (() => new Date()))();
  const thisYear = now.getUTCFullYear();
  const years = [thisYear - 4, thisYear - 3, thisYear - 2, thisYear - 1];
  const counts: number[] = [];
  for (const y of years) {
    const start = Math.floor(Date.UTC(y, 0, 1) / 1000);
    const end = Math.floor(Date.UTC(y + 1, 0, 1) / 1000);
    const p = new URLSearchParams({
      query: q,
      tags: 'story',
      hitsPerPage: '0',
      numericFilters: `created_at_i>=${start},created_at_i<${end}`,
    });
    await throttle(HOST, MIN_INTERVAL_MS, { sleep: opts.sleep });
    const json = (await request('hn', `https://${HOST}/api/v1/search_by_date?${p}`, {}, httpOf(opts))) as { nbHits?: unknown } | null;
    const n = json?.nbHits;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
      opts.log?.('hn-trend: response had no story count');
      return null;
    }
    counts.push(n);
  }
  if (counts.reduce((a, b) => a + b, 0) < MIN_TOTAL_STORIES) return null;
  const prev = counts[2]!;
  const last = counts[3]!;
  const direction = trendDirection(prev, last);
  return {
    kind: 'trend',
    title: capField(`Hacker News attention to ${q}`, 200),
    summary: capField(`Hacker News stories about '${q}' ${trendPhrase(direction, prev, last, `${years[3]} vs ${years[2]}`)}`, 300),
    audience: 'both',
    countries: [],
    industries: [],
    voice: 'neutral',
    facts: {
      topic: capField(q, 200),
      direction,
      // Newest year first: the ideation key fact reads evidence[0].
      evidence: years.map((y, i) => ({ metric: METRIC, value: String(counts[i]), period: String(y) })).reverse(),
      window: `${years[0]}–${years[3]}`,
      basis: 'measured',
    },
    source: { url: `https://${HOST}/?type=story&query=${encodeURIComponent(q)}`, domain: HOST, sourceType, quoteVerified: false },
  };
}
