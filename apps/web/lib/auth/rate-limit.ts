// In memory only: it resets when the server restarts and is per instance (one instance for a single owner).

export type RateDecision = { allowed: boolean; retryAfterS: number };

export type RateLimiter = {
  /** Would an attempt for `key` be allowed now? Records nothing. */
  check(key: string): RateDecision;
  /**
   * Check and, when allowed, count the attempt against the key and the global bucket at once (before the slow password
   * check), so parallel attempts cannot all pass `check`. The token releases the global slot via `succeed`.
   */
  reserve(key: string): RateDecision & { token?: number };
  /** A successful login: clears the key and releases the global slot its reservation took. */
  succeed(key: string, token: number): void;
  fail(key: string): void;
  reset(key: string): void;
};

/**
 * Sliding-window failure counter: at most `limit` failures per key and `globalLimit` failures overall per `windowMs`.
 * At most `maxKeys` keys are tracked (the oldest is dropped first), so spoofed keys cannot grow memory without bound;
 * the global ceiling still applies to dropped keys.
 */
export function createRateLimiter({
  limit = 5,
  windowMs = 600_000,
  globalLimit = 30,
  maxKeys = 10_000,
  now = () => Date.now(),
}: { limit?: number; windowMs?: number; globalLimit?: number; maxKeys?: number; now?: () => number } = {}): RateLimiter {
  const byKey = new Map<string, number[]>();
  /** Global failures, oldest first; the token lets a successful login release exactly its own slot. */
  let global: { t: number; token: number }[] = [];
  let seq = 0;

  const retryAfter = (oldest: number, t: number) => Math.max(1, Math.ceil((oldest + windowMs - t) / 1000));
  const pruneGlobal = (t: number) => {
    global = global.filter((g) => g.t > t - windowMs);
  };

  function check(key: string): RateDecision {
    const t = now();
    pruneGlobal(t);
    if (global.length >= globalLimit) return { allowed: false, retryAfterS: retryAfter(global[global.length - globalLimit]!.t, t) };
    const mine = (byKey.get(key) ?? []).filter((x) => x > t - windowMs);
    if (mine.length === 0) byKey.delete(key);
    else byKey.set(key, mine);
    if (mine.length >= limit) return { allowed: false, retryAfterS: retryAfter(mine[mine.length - limit]!, t) };
    return { allowed: true, retryAfterS: 0 };
  }

  function record(key: string): number {
    const t = now();
    pruneGlobal(t);
    seq += 1;
    global = [...global, { t, token: seq }].slice(-globalLimit);
    const mine = [...(byKey.get(key) ?? []).filter((x) => x > t - windowMs), t].slice(-limit);
    byKey.delete(key);
    while (byKey.size >= maxKeys) byKey.delete(byKey.keys().next().value!);
    byKey.set(key, mine);
    return seq;
  }

  return {
    check,
    reserve(key) {
      const d = check(key);
      return d.allowed ? { ...d, token: record(key) } : d;
    },
    succeed(key, token) {
      byKey.delete(key);
      global = global.filter((g) => g.token !== token);
    },
    fail(key) {
      record(key);
    },
    reset(key) {
      byKey.delete(key);
    },
  };
}
