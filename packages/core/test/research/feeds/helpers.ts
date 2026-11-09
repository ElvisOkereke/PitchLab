import type { FeedOpts } from '../../../src/research/feeds/common';

export type Call = { url: URL; init: RequestInit };

/** A scripted fetch: the handler gets each request's url and init, and answers with a Response. */
export function mockFetch(handler: (u: URL, init: RequestInit, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (u: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(u));
    calls.push({ url, init });
    return handler(url, init, calls.length - 1);
  }) as typeof fetch;
  return { impl, calls };
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const text = (body: string, status = 200, type = 'text/plain') => new Response(body, { status, headers: { 'content-type': type } });

export function opts(f: typeof fetch, sleeps: number[] = []): FeedOpts {
  return { fetch: f, sleep: async (ms: number) => { sleeps.push(ms); } };
}

export const header = (init: RequestInit, name: string): string | undefined => (init.headers as Record<string, string>)[name];
