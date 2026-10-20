// Stand-ins for next/headers, next/navigation and next/cache so Server Actions and auth helpers run under Vitest.
// Usage in a test file:
//   vi.mock('next/headers', () => import('../helpers/next-mocks').then((m) => m.nextHeadersMock));
//   vi.mock('next/navigation', () => import('../helpers/next-mocks').then((m) => m.nextNavigationMock));
//   vi.mock('next/cache', () => import('../helpers/next-mocks').then((m) => m.nextCacheMock));
// then shape the request with `resetRequest({ ... })` and read `request.setCookies` / `request.revalidated`.

export type CookieOptions = Record<string, unknown>;

export const TEST_ORIGIN = 'http://localhost:3000';
export const TEST_HOST = 'localhost:3000';
export const TEST_SECRET = 'test-session-secret-0123456789-abcdefghijkl';

export const request = {
  headers: new Headers(),
  cookies: new Map<string, string>(),
  setCookies: [] as { name: string; value: string; options?: CookieOptions }[],
  revalidated: [] as string[],
};

/** A fresh request: same-origin by default, no cookies. */
export function resetRequest(o: { origin?: string | null; host?: string; headers?: Record<string, string>; cookies?: Record<string, string> } = {}) {
  const h = new Headers({ host: o.host ?? TEST_HOST, ...o.headers });
  const origin = o.origin === undefined ? TEST_ORIGIN : o.origin;
  if (origin !== null) h.set('origin', origin);
  request.headers = h;
  request.cookies = new Map(Object.entries(o.cookies ?? {}));
  request.setCookies = [];
  request.revalidated = [];
}

/** Sets the env the web app reads (webEnv() memoises, so call before the first action in a file). */
export function useTestEnv(extra: Record<string, string> = {}) {
  Object.assign(process.env, {
    DATABASE_URL: 'postgres://test:test@127.0.0.1:1/test',
    OWNER_PASSWORD_HASH: 'scrypt:32768:8:1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA',
    SESSION_SECRET: TEST_SECRET,
    TRUST_PROXY_HOPS: '0',
    ALLOWED_ORIGINS: '',
    COOKIE_SECURE: 'false',
    ...extra,
  });
}

const cookieStore = {
  get: (name: string) => (request.cookies.has(name) ? { name, value: request.cookies.get(name)! } : undefined),
  has: (name: string) => request.cookies.has(name),
  getAll: () => [...request.cookies].map(([name, value]) => ({ name, value })),
  set: (name: string, value: string, options?: CookieOptions) => {
    request.setCookies.push({ name, value, options });
    request.cookies.set(name, value);
  },
  delete: (name: string) => {
    request.setCookies.push({ name, value: '', options: { maxAge: 0 } });
    request.cookies.delete(name);
  },
};

export const nextHeadersMock = {
  headers: async () => request.headers,
  cookies: async () => cookieStore,
};

/** Error shaped like Next's redirect error (message and digest start with NEXT_REDIRECT). */
export class RedirectError extends Error {
  digest: string;
  constructor(public url: string) {
    super(`NEXT_REDIRECT;${url}`);
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

export const nextNavigationMock = {
  redirect: (url: string): never => {
    throw new RedirectError(url);
  },
  notFound: (): never => {
    throw new Error('NEXT_NOT_FOUND');
  },
};

export const nextCacheMock = {
  revalidatePath: (path: string) => {
    request.revalidated.push(path);
  },
};
