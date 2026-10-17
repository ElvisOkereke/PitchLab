export type RawItem = { source: string; url: string; title: string; text: string; publishedAt: Date | null };

import { readCapped, TooLarge } from '../fetch-page';

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
  '&#x2F;': '/',
  '&#47;': '/',
  '&#38;': '&',
  '&nbsp;': ' ',
  '&#160;': ' ',
};
const ENTITY_RE = /&(?:lt|gt|quot|nbsp|#x27|#x2F|#39|#47|#38|#160);/gi;

/** Decode common entities (&amp; last), strip tags, drop stray angle brackets, collapse whitespace. */
export function cleanText(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(ENTITY_RE, (m) => ENTITIES[m] ?? ENTITIES[m.toLowerCase()] ?? ENTITIES[m.replace(/x2f/i, 'x2F')] ?? m)
    .replace(/&amp;/gi, '&')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
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

const GET_TIMEOUT_MS = 15000;
const GET_MAX_BYTES = 2_000_000;

/** GET a URL and return the body text; on any failure warn and return null. Never throws. */
export async function getBody(
  id: string,
  url: string,
  fetchImpl: typeof fetch | undefined,
  headers: Record<string, string> = {},
  limits: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs ?? GET_TIMEOUT_MS);
  try {
    const res = await (fetchImpl ?? fetch)(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, ...headers },
    });
    if (res.status >= 300 && res.status < 400) {
      console.warn(`[source:${id}] unexpected redirect (HTTP ${res.status})`);
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok) {
      console.warn(`[source:${id}] HTTP ${res.status}`);
      return null;
    }
    return await readCapped(res, limits.maxBytes ?? GET_MAX_BYTES);
  } catch (e) {
    if (e instanceof TooLarge) console.warn(`[source:${id}] response too large`);
    else if (controller.signal.aborted) console.warn(`[source:${id}] request timed out`);
    else console.warn(`[source:${id}] request failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** GET + JSON.parse; warn and return null on any failure. */
export async function getJson(
  id: string,
  url: string,
  fetchImpl: typeof fetch | undefined,
  headers: Record<string, string> = {},
  limits: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<unknown> {
  const body = await getBody(id, url, fetchImpl, { Accept: 'application/json', ...headers }, limits);
  if (body === null) return null;
  try {
    return JSON.parse(body);
  } catch {
    console.warn(`[source:${id}] bad JSON`);
    return null;
  }
}
