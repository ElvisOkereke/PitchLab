import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedirectError, TEST_SECRET, request, resetRequest, useTestEnv } from '../helpers/next-mocks';

vi.mock('next/headers', () => import('../helpers/next-mocks').then((m) => m.nextHeadersMock));
vi.mock('next/navigation', () => import('../helpers/next-mocks').then((m) => m.nextNavigationMock));

const { hashPassword } = await import('@/lib/auth/password');
const { verifySession } = await import('@/lib/auth/session');
const { loginAction, logoutAction } = await import('@/actions/auth');

const PASSWORD = 'correct horse battery staple';
let logged: string[] = [];

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** A request from client IP `ip` (TRUST_PROXY_HOPS=1 in this file, so each test can use its own bucket). */
function from(ip: string, o: { origin?: string | null } = {}) {
  resetRequest({ ...o, headers: { 'x-forwarded-for': `6.6.6.6, ${ip}` } });
}

async function redirectOf(p: Promise<unknown>): Promise<string> {
  const e = await p.then(() => null, (err: unknown) => err);
  if (!(e instanceof RedirectError)) throw new Error(`expected a redirect, got ${String(e)}`);
  return e.url;
}

beforeAll(async () => {
  useTestEnv({ OWNER_PASSWORD_HASH: await hashPassword(PASSWORD), TRUST_PROXY_HOPS: '1' });
});

beforeEach(() => {
  logged = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loginAction', () => {
  it('a wrong password returns a message, sets no cookie and logs only the bucket', async () => {
    from('1.1.1.1');
    expect(await loginAction({}, form({ password: 'not the password', next: '/' }))).toEqual({ error: 'Wrong password.' });
    expect(request.setCookies).toEqual([]);
    expect(logged).toEqual(['login failed (bucket 1.1.1.1)']);
  });

  it('loginAction never logs the password and sets a fresh cookie on success', async () => {
    from('2.2.2.2');
    expect(await redirectOf(loginAction({}, form({ password: PASSWORD, next: '/cases/a-b?tab=score' })))).toBe('/cases/a-b?tab=score');
    expect(request.setCookies).toHaveLength(1);
    const [c] = request.setCookies;
    expect(c!.name).toBe('bcg_session');
    expect(c!.options).toEqual({ httpOnly: true, secure: false, sameSite: 'lax', path: '/', maxAge: 604_800 });
    expect(await verifySession(c!.value, TEST_SECRET)).toMatchObject({ sub: 'owner' });

    from('2.2.2.2');
    await redirectOf(loginAction({}, form({ password: PASSWORD })));
    expect(request.setCookies[0]!.value).not.toBe(c!.value);
    expect(logged.join('\n')).not.toContain(PASSWORD);
  });

  it('sends an open-redirect next to /', async () => {
    from('3.3.3.3');
    expect(await redirectOf(loginAction({}, form({ password: PASSWORD, next: '//evil.com' })))).toBe('/');
    from('3.3.3.3');
    expect(await redirectOf(loginAction({}, form({ password: PASSWORD, next: 'https://evil.com/x' })))).toBe('/');
  });

  it('rejects a missing or foreign Origin before checking anything', async () => {
    for (const origin of [null, 'https://evil.com', 'null']) {
      from('4.4.4.4', { origin });
      await expect(loginAction({}, form({ password: PASSWORD }))).rejects.toThrow('Forbidden');
      expect(request.setCookies).toEqual([]);
    }
  });

  it('rejects a missing, empty or oversized password as a failed attempt', async () => {
    for (const fd of [form({}), form({ password: '' }), form({ password: 'x'.repeat(2000) })]) {
      from('5.5.5.5');
      expect(await loginAction({}, fd)).toEqual({ error: 'Wrong password.' });
    }
    expect(request.setCookies).toEqual([]);
  });

  it('blocks a bucket after 5 failures, even with the right password; other buckets still work', async () => {
    for (let i = 0; i < 5; i++) {
      from('7.7.7.7');
      expect(await loginAction({}, form({ password: `wrong ${i}` }))).toEqual({ error: 'Wrong password.' });
    }
    from('7.7.7.7');
    expect(await loginAction({}, form({ password: PASSWORD }))).toEqual({ error: 'Too many attempts. Try again in 10 minutes.' });
    expect(request.setCookies).toEqual([]);
    from('8.8.8.8');
    expect(await redirectOf(loginAction({}, form({ password: PASSWORD })))).toBe('/');
  });
});

describe('logoutAction', () => {
  it('expires the cookie (Max-Age=0) and redirects to /login', async () => {
    resetRequest({ cookies: { bcg_session: 'x' } });
    expect(await redirectOf(logoutAction())).toBe('/login');
    expect(request.setCookies).toEqual([
      { name: 'bcg_session', value: '', options: expect.objectContaining({ maxAge: 0, httpOnly: true, path: '/', sameSite: 'lax' }) },
    ]);
  });

  it('rejects a foreign Origin', async () => {
    resetRequest({ origin: 'https://evil.com', cookies: { bcg_session: 'x' } });
    await expect(logoutAction()).rejects.toThrow('Forbidden');
    expect(request.setCookies).toEqual([]);
  });
});
