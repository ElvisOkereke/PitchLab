// In memory only: it resets when the server restarts and is per instance (one instance for a single owner).

export type RateLimiter = {
  check(key: string): { allowed: boolean; retryAfterS: number };
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
  now = Date.now,
}: { limit?: number; windowMs?: number; globalLimit?: number; maxKeys?: number; now?: () => number } = {}): RateLimiter {
  const byKey = new Map<string, number[]>();
  let global: number[] = [];

  const recent = (ts: number[], t: number) => ts.filter((x) => x > t - windowMs);
  const retryAfter = (oldest: number, t: number) => Math.max(1, Math.ceil((oldest + windowMs - t) / 1000));

  return {
    check(key) {
      const t = now();
      global = recent(global, t);
      if (global.length >= globalLimit) return { allowed: false, retryAfterS: retryAfter(global[global.length - globalLimit]!, t) };
      const mine = recent(byKey.get(key) ?? [], t);
      if (mine.length === 0) byKey.delete(key);
      else byKey.set(key, mine);
      if (mine.length >= limit) return { allowed: false, retryAfterS: retryAfter(mine[mine.length - limit]!, t) };
      return { allowed: true, retryAfterS: 0 };
    },
    fail(key) {
      const t = now();
      global = [...recent(global, t), t].slice(-globalLimit);
      const mine = [...recent(byKey.get(key) ?? [], t), t].slice(-limit);
      byKey.delete(key);
      while (byKey.size >= maxKeys) byKey.delete(byKey.keys().next().value!);
      byKey.set(key, mine);
    },
    reset(key) {
      byKey.delete(key);
    },
  };
}
