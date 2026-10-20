// Runs proxy.ts's matcher through Next's own conversion (getMiddlewareMatchers → regexp) and route matcher, so the
// test sees exactly what `next start` decides about which paths the proxy guards (D2-R5 item 3).
import { getMiddlewareRouteMatcher } from 'next/dist/shared/lib/router/utils/middleware-route-matcher';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => import('../helpers/next-mocks').then((m) => m.nextHeadersMock));

// Internal Next API (exported at runtime, not in its .d.ts): the same conversion `next build` applies to the matcher.
const { getMiddlewareMatchers } = (await import('next/dist/build/analysis/get-page-static-info')) as unknown as {
  getMiddlewareMatchers: (matcher: string[], nextConfig: object) => Parameters<typeof getMiddlewareRouteMatcher>[0];
};
const { config } = await import('../../proxy');

const matchers = getMiddlewareMatchers(config.matcher, {});
const guarded = (path: string) => getMiddlewareRouteMatcher(matchers)(path, {} as never, {});

describe('proxy matcher', () => {
  it('guards look-alikes of the excluded static paths', () => {
    for (const p of ['/favicon.ico.evil', '/faviconXico', '/_next/imagefoo', '/_next/static../x', '/_next/staticx', '/_next/image', '/_next/image/x', '/_next/data/x']) {
      expect(guarded(p), p).toBe(true);
    }
  });

  it('guards every app route', () => {
    for (const p of ['/', '/login', '/leaderboard', '/command', '/runs', '/settings', '/cases/x', '/cases/x/export.md']) {
      expect(guarded(p), p).toBe(true);
    }
  });

  it('leaves real static assets unguarded', () => {
    for (const p of ['/_next/static/chunks/a.js', '/_next/static/css/b.css', '/_next/static/media/f.woff2', '/favicon.ico']) {
      expect(guarded(p), p).toBe(false);
    }
  });
});
