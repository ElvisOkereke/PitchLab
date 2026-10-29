import { capField } from '../../llm/untrusted';
import { cleanText, toDate, type RawItem } from '../../tools/sources/types';
import { request, throttle, type HttpOpts } from '../http';

export const sourceType = 'federalregister';
export const MIN_INTERVAL_MS = 500;
export const MAX_RESULTS = 10;
/** Each item's text (title and abstract) is capped before extraction. */
export const MAX_TEXT = 4000;
const HOST = 'www.federalregister.gov';
const URL_DOCS = `https://${HOST}/api/v1/documents.json`;

/** Shared by the Slice B collectors. `now` returns a Date here (HttpOpts.now is a number clock for throttling, not used). */
export type CollectorOpts = Omit<HttpOpts, 'now'> & { now?: () => Date; log?: (message: string) => void };

/** A real YYYY-MM-DD calendar date, or null (missing or malformed dates are stored as null, never guessed). */
export function isoDateOrNull(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
}

/** The transport options only (the Date clock here must not reach request/throttle, which take a number clock). */
export function httpOf(opts: CollectorOpts): HttpOpts {
  return { fetch: opts.fetch, sleep: opts.sleep, onCall: opts.onCall };
}

function monthsAgoIso(now: Date, months: number): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate())).toISOString().slice(0, 10);
}

/** Final and proposed US rules published in the last 24 months, newest first (at most 10). */
export async function federalRegisterSearch(q: string, opts: CollectorOpts = {}): Promise<RawItem[]> {
  const now = (opts.now ?? (() => new Date()))();
  const p = new URLSearchParams();
  p.set('conditions[term]', q);
  p.append('conditions[type][]', 'RULE');
  p.append('conditions[type][]', 'PRORULE');
  p.set('conditions[publication_date][gte]', monthsAgoIso(now, 24));
  p.set('order', 'newest');
  p.set('per_page', String(MAX_RESULTS));
  for (const f of ['title', 'abstract', 'html_url', 'effective_on', 'publication_date', 'type']) p.append('fields[]', f);
  await throttle(HOST, MIN_INTERVAL_MS, { sleep: opts.sleep });
  const json = (await request('federalregister', `${URL_DOCS}?${p}`, {}, httpOf(opts))) as { results?: unknown } | null;
  if (!json || !Array.isArray(json.results)) {
    opts.log?.('federalregister: response had no results list');
    return [];
  }
  const out: RawItem[] = [];
  for (const r of json.results as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue;
    const title = cleanText(typeof r.title === 'string' ? r.title : '');
    const url = typeof r.html_url === 'string' ? r.html_url : '';
    if (!title || !url.startsWith(`https://${HOST}/`)) continue;
    const abstract = cleanText(typeof r.abstract === 'string' ? r.abstract : '');
    const type = typeof r.type === 'string' ? r.type : '';
    const publishedDate = isoDateOrNull(r.publication_date);
    out.push({
      source: sourceType,
      url,
      title,
      text: capField(abstract ? `${title}. ${abstract}` : title, MAX_TEXT),
      publishedAt: toDate(publishedDate),
      hints: {
        effectiveDate: isoDateOrNull(r.effective_on),
        publishedDate,
        status: /pro/i.test(type) ? 'proposed' : 'final',
      },
    });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}
