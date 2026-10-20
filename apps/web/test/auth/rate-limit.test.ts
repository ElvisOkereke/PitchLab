import { describe, expect, it, vi } from 'vitest';
import { createRateLimiter } from '@/lib/auth/rate-limit';

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

describe('login rate limiter', () => {
  it('rate limit: 5 failures per key per 10 min', () => {
    const c = clock();
    const rl = createRateLimiter({ now: c.now });
    for (let i = 0; i < 5; i++) {
      expect(rl.check('a').allowed).toBe(true);
      rl.fail('a');
      c.t += 1000;
    }
    const blocked = rl.check('a');
    expect(blocked.allowed).toBe(false);
    // The oldest failure (at start) leaves the window at start + 10 min; now is start + 5 s.
    expect(blocked.retryAfterS).toBe(595);
    expect(rl.check('b')).toEqual({ allowed: true, retryAfterS: 0 });
    c.t = 1_000_000 + 600_000;
    expect(rl.check('a').allowed).toBe(true);
  });

  it('success resets the key', () => {
    const rl = createRateLimiter({ now: clock().now });
    for (let i = 0; i < 5; i++) rl.fail('a');
    expect(rl.check('a').allowed).toBe(false);
    rl.reset('a');
    expect(rl.check('a').allowed).toBe(true);
  });

  it('global cap: 30 failures across all keys block everyone', () => {
    const c = clock();
    const rl = createRateLimiter({ now: c.now });
    for (let i = 0; i < 30; i++) rl.fail(`k${i}`);
    expect(rl.check('fresh').allowed).toBe(false);
    expect(rl.check('fresh').retryAfterS).toBe(600);
    rl.reset('k0');
    expect(rl.check('fresh').allowed).toBe(false);
    c.t += 600_000;
    expect(rl.check('fresh').allowed).toBe(true);
  });

  it('reserve counts the attempt immediately, so parallel attempts cannot exceed the limit', () => {
    const rl = createRateLimiter({ now: clock().now });
    const results = Array.from({ length: 8 }, () => rl.reserve('a'));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.slice(5).every((r) => !r.allowed && r.retryAfterS === 600)).toBe(true);
  });

  it('succeed clears the key and releases the reserved global slot; a failed reservation stays counted', () => {
    const rl = createRateLimiter({ now: clock().now, globalLimit: 3 });
    const a = rl.reserve('a');
    rl.reserve('b');
    rl.reserve('c');
    expect(rl.check('d').allowed).toBe(false); // global full: 3 reserved
    rl.succeed('a', a.token!);
    expect(rl.check('d').allowed).toBe(true); // a's slot released
    expect(rl.check('a').allowed).toBe(true);
    rl.succeed('a', a.token!); // a second release is a no-op
    rl.reserve('d');
    expect(rl.check('e').allowed).toBe(false);
  });

  it('follows a faked Date.now (the default clock is read at call time)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
      const rl = createRateLimiter();
      for (let i = 0; i < 5; i++) rl.reserve('a');
      expect(rl.check('a').allowed).toBe(false);
      vi.setSystemTime(new Date('2026-10-20T00:10:01Z'));
      expect(rl.check('a').allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the number of tracked keys', () => {
    const rl = createRateLimiter({ now: clock().now, maxKeys: 3, globalLimit: 1_000 });
    for (let i = 0; i < 5; i++) rl.fail('first');
    for (const k of ['b', 'c', 'd']) rl.fail(k);
    // 'first' was the oldest key and got evicted when 'd' arrived.
    expect(rl.check('first').allowed).toBe(true);
  });
});
