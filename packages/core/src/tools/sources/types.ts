export type RawItem = { source: string; url: string; title: string; text: string; publishedAt: Date | null };

export interface SearchOpts {
  limit: number;
  fetchImpl?: typeof fetch;
}

export interface SignalSource {
  id: string;
  search(query: string, opts: SearchOpts): Promise<RawItem[]>;
}

const ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#x27;': "'",
  '&#39;': "'",
};

/** Strip HTML tags and decode common entities (&amp; last to avoid double-decoding). */
export function cleanText(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(lt|gt|quot|#x27|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** ISO/RFC date strings, or unix seconds when given a number. */
export function toDate(v: string | number | null | undefined): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(typeof v === 'number' ? v * 1000 : v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const USER_AGENT = 'BusinessCaseGen/0.1 (research; contact: owner)';

/** GET a URL and return the body text; on any failure warn and return null. Never throws. */
export async function getBody(
  id: string,
  url: string,
  fetchImpl: typeof fetch | undefined,
  headers: Record<string, string> = {},
): Promise<string | null> {
  try {
    const res = await (fetchImpl ?? fetch)(url, { method: 'GET', headers: { 'User-Agent': USER_AGENT, ...headers } });
    if (!res.ok) {
      console.warn(`[source:${id}] HTTP ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (e) {
    console.warn(`[source:${id}] request failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** GET + JSON.parse; warn and return null on any failure. */
export async function getJson(
  id: string,
  url: string,
  fetchImpl: typeof fetch | undefined,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const body = await getBody(id, url, fetchImpl, { Accept: 'application/json', ...headers });
  if (body === null) return null;
  try {
    return JSON.parse(body);
  } catch {
    console.warn(`[source:${id}] bad JSON`);
    return null;
  }
}
