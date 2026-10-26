import { readCapped, TooLarge } from '../tools/fetch-page';

/** Raised by research collectors; `code` lets the mission runner record a per-source warning. Messages never carry credentials. */
export type SourceErrorCode = 'rate_limited' | 'auth' | 'http_error' | 'network' | 'bad_response';
export class SourceError extends Error {
  constructor(
    public code: SourceErrorCode,
    public source: string,
    message?: string,
  ) {
    super(message ?? `${source}: ${code}`);
    this.name = 'SourceError';
  }
}

/** Optional hook so the mission runner can log each outbound call (cost attribution happens there). */
export type CallHook = (call: { provider: string; endpoint: string; ok: boolean }) => void | Promise<void>;

export interface HttpOpts {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onCall?: CallHook;
}

/** One identity for every research request. Task 4's page fetches should send this too (fetchPage currently has a fixed UA). */
export const USER_AGENT = 'pitchlab-research/0.1';
/** Product token matched against robots.txt `User-agent` groups. */
export const ROBOTS_TOKEN = 'pitchlab-research';

const lastHit = new Map<string, number>();
const chains = new Map<string, Promise<void>>();

/** Serialised per host: wait until at least minIntervalMs has passed since the previous request to this host. */
export function throttle(host: string, minIntervalMs: number, opts: HttpOpts = {}): Promise<void> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const prev = chains.get(host) ?? Promise.resolve();
  const mine = prev.then(async () => {
    const last = lastHit.get(host);
    if (last !== undefined) {
      const wait = last + minIntervalMs - now();
      if (wait > 0) await sleep(wait);
    }
    lastHit.set(host, now());
  });
  chains.set(
    host,
    mine.catch(() => {}),
  );
  return mine;
}

export function resetThrottle(): void {
  lastHit.clear();
  chains.clear();
}

async function notify(opts: HttpOpts, call: Parameters<CallHook>[0]): Promise<void> {
  try {
    await opts.onCall?.(call);
  } catch {
    // a failing logger must never replace the real result or error
  }
}

/** One request, no redirects, capped body, timeout. Maps 429 to rate_limited, 401/403 to auth. */
export async function request(
  source: string,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; maxBytes?: number },
  opts: HttpOpts = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 15000);
  const endpoint = new URL(url).pathname;
  let ok = false;
  try {
    const res = await (opts.fetch ?? fetch)(url, {
      method: init.method ?? 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...init.headers },
      body: init.body,
    });
    if (res.status >= 300) {
      await res.body?.cancel().catch(() => {});
      if (res.status === 429) throw new SourceError('rate_limited', source);
      if (res.status === 401 || res.status === 403) throw new SourceError('auth', source, `${source}: HTTP ${res.status}`);
      throw new SourceError('http_error', source, `${source}: HTTP ${res.status}`);
    }
    const text = await readCapped(res, init.maxBytes ?? 2_000_000);
    try {
      const json = JSON.parse(text);
      ok = true;
      return json;
    } catch {
      throw new SourceError('bad_response', source);
    }
  } catch (e) {
    if (e instanceof SourceError) throw e;
    if (e instanceof TooLarge) throw new SourceError('bad_response', source, `${source}: response too large`);
    throw new SourceError('network', source, `${source}: ${controller.signal.aborted ? 'timed out' : 'request failed'}`);
  } finally {
    clearTimeout(timer);
    await notify(opts, { provider: source, endpoint, ok });
  }
}
