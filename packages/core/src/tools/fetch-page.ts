import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';

export type PageFailure = 'http_error' | 'timeout' | 'too_large' | 'not_html' | 'network' | 'blocked_scheme';
export interface PageResult {
  ok: boolean;
  status: number;
  finalUrl: string;
  title: string;
  text: string;
  reason?: PageFailure;
}
export interface FetchPageOpts {
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

const USER_AGENT = 'BusinessCaseGen/0.1 (research; contact: owner)';
const MAX_REDIRECTS = 5;

const fail = (reason: PageFailure, status: number, finalUrl: string): PageResult => ({
  ok: false, status, finalUrl, title: '', text: '', reason,
});

const isHttp = (u: URL) => u.protocol === 'http:' || u.protocol === 'https:';

class TooLarge extends Error {}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new TooLarge();
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new TooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function extract(html: string): { title: string; text: string } {
  const { document } = parseHTML(/<html[\s>]/i.test(html) ? html : `<html><body>${html}</body></html>`);
  const title = (document.title || document.querySelector('title')?.textContent || '').trim();
  const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0]).parse();
  const text = (article?.textContent ?? (document.body ?? document.documentElement)?.textContent ?? '').trim();
  return { title, text };
}

/** GET-only page fetch. Never throws. */
export async function fetchPage(url: string, opts: FetchPageOpts = {}): Promise<PageResult> {
  const { timeoutMs = 15000, maxBytes = 2_000_000, fetchImpl = fetch } = opts;
  let current = url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let parsed: URL;
      try {
        parsed = new URL(current);
      } catch {
        return fail('blocked_scheme', 0, current);
      }
      if (!isHttp(parsed)) return fail('blocked_scheme', 0, current);

      const res = await fetchImpl(parsed.href, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,text/plain;q=0.9,*/*;q=0.1' },
      });

      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        await res.body?.cancel().catch(() => {});
        try {
          current = new URL(res.headers.get('location')!, parsed).href;
        } catch {
          return fail('network', res.status, parsed.href);
        }
        continue;
      }

      if (res.status < 200 || res.status >= 300) {
        await res.body?.cancel().catch(() => {});
        return fail('http_error', res.status, parsed.href);
      }

      const type = (res.headers.get('content-type') ?? '').toLowerCase();
      const isHtml = type.includes('text/html') || type.includes('application/xhtml+xml');
      const isPlain = type.includes('text/plain');
      if (!isHtml && !isPlain) {
        await res.body?.cancel().catch(() => {});
        return fail('not_html', res.status, parsed.href);
      }

      const body = await readCapped(res, maxBytes);
      const { title, text } = isHtml ? extract(body) : { title: '', text: body.trim() };
      return { ok: true, status: res.status, finalUrl: parsed.href, title, text };
    }
    return fail('network', 0, current); // too many redirects
  } catch (err) {
    if (err instanceof TooLarge) return fail('too_large', 200, current);
    if (controller.signal.aborted) return fail('timeout', 0, current);
    return fail('network', 0, current);
  } finally {
    clearTimeout(timer);
  }
}
