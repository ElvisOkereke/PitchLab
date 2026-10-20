// Ruling D2-R5 item 1: parallel login attempts must not bypass the rate limit, and scrypt work is bounded.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RedirectError, resetRequest, useTestEnv } from '../helpers/next-mocks';

const stats = vi.hoisted(() => ({ calls: 0, inFlight: 0, maxInFlight: 0 }));

vi.mock('next/headers', () => import('../helpers/next-mocks').then((m) => m.nextHeadersMock));
vi.mock('next/navigation', () => import('../helpers/next-mocks').then((m) => m.nextNavigationMock));
vi.mock('@/lib/auth/password', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/password')>();
  return {
    ...actual,
    verifyPassword: async (pw: string, stored: string) => {
      stats.calls += 1;
      stats.inFlight += 1;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      try {
        return await actual.verifyPassword(pw, stored);
      } finally {
        stats.inFlight -= 1;
      }
    },
  };
});

const { hashPassword } = await import('@/lib/auth/password');
const { loginAction } = await import('@/actions/auth');

const PASSWORD = 'correct horse battery staple';
const T0 = new Date('2026-10-20T00:00:00Z').getTime();

function attempt(ip: string, password: string) {
  // Each call reads the headers when it starts, so set them right before (synchronously) for this request.
  resetRequest({ headers: { 'x-forwarded-for': ip } });
  const fd = new FormData();
  fd.set('password', password);
  return loginAction({}, fd).then(
    (r) => (r.error ?? 'ok'),
    (e: unknown) => (e instanceof RedirectError ? `redirect ${e.url}` : `throw ${String(e)}`),
  );
}

const kinds = (results: string[]) => ({
  wrong: results.filter((r) => r === 'Wrong password.').length,
  tooMany: results.filter((r) => r.startsWith('Too many attempts.')).length,
  other: results.filter((r) => r !== 'Wrong password.' && !r.startsWith('Too many attempts.')),
});

beforeAll(async () => {
  useTestEnv({ OWNER_PASSWORD_HASH: await hashPassword(PASSWORD), TRUST_PROXY_HOPS: '1' });
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterAll(() => {
  vi.useRealTimers();
});

describe('loginAction under parallel attempts', () => {
  it('50 parallel wrong logins from one key yield at most 5 "Wrong password." and the rest "Too many attempts"', async () => {
    vi.setSystemTime(T0);
    stats.maxInFlight = 0;
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => attempt('1.1.1.1', `wrong ${i}`)));
    const k = kinds(results);
    expect(k.other).toEqual([]);
    expect(k.wrong).toBeLessThanOrEqual(5);
    expect(k.wrong + k.tooMany).toBe(50);
    expect(stats.maxInFlight).toBeLessThanOrEqual(2);
  });

  it('200 parallel attempts from 200 keys never run more than 30 verifications, at most 2 at a time', async () => {
    vi.setSystemTime(T0 + 3_600_000);
    const before = stats.calls;
    stats.maxInFlight = 0;
    const results = await Promise.all(Array.from({ length: 200 }, (_, i) => attempt(`10.0.${Math.floor(i / 250)}.${i % 250}`, `wrong ${i}`)));
    const k = kinds(results);
    expect(k.other).toEqual([]);
    expect(stats.calls - before).toBeLessThanOrEqual(30);
    expect(k.wrong).toBe(stats.calls - before);
    expect(stats.maxInFlight).toBeLessThanOrEqual(2);
  });

  it('a correct login after the window works as before', async () => {
    vi.setSystemTime(T0 + 2 * 3_600_000);
    expect(await attempt('1.1.1.1', PASSWORD)).toBe('redirect /');
  });
});
