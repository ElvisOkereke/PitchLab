// Defence in depth (Review Focus 1): every page, layout and route handler under app/(app) calls requireOwner() before
// it reads anything. Modules added later are picked up automatically.
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ calls: 0 }));

vi.mock('@/lib/auth/require-owner', () => ({
  requireOwner: async () => {
    state.calls += 1;
    throw new Error('REQUIRE_OWNER_REFUSED');
  },
  requireOwnerAction: async () => {
    throw new Error('REQUIRE_OWNER_ACTION_REFUSED');
  },
}));
vi.mock('@/lib/db', () => ({
  getDb: () => {
    throw new Error('DB read before requireOwner');
  },
}));
vi.mock('next/headers', () => import('../helpers/next-mocks').then((m) => m.nextHeadersMock));
vi.mock('next/navigation', () => import('../helpers/next-mocks').then((m) => ({ ...m.nextNavigationMock, usePathname: () => '/', useRouter: () => ({ refresh() {} }) })));
vi.mock('next/cache', () => import('../helpers/next-mocks').then((m) => m.nextCacheMock));

const appDir = fileURLToPath(new URL('../../app/(app)/', import.meta.url));

function modules(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return modules(full);
    return /^(page|layout|route)\.tsx?$/.test(e.name) ? [full] : [];
  });
}

const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const props = { params: Promise.resolve({ slug: 'some-case' }), searchParams: Promise.resolve({}), children: null };

describe('every page under app/(app) requires the owner', () => {
  const files = modules(appDir);

  it('finds the pages', () => {
    const names = files.map((f) => relative(appDir, f).replaceAll('\\', '/'));
    expect(names).toEqual(expect.arrayContaining([
      'layout.tsx', 'page.tsx', 'cases/[slug]/page.tsx', 'cases/[slug]/export.md/route.ts', 'leaderboard/page.tsx', 'command/page.tsx',
      'runs/page.tsx', 'settings/page.tsx',
    ]));
  });

  it.each(files.map((f) => [relative(appDir, f).replaceAll('\\', '/'), f]))('%s calls requireOwner() first', async (name, file) => {
    const mod = (await import(/* @vite-ignore */ `../../app/(app)/${name}`)) as Record<string, unknown>;
    const entries = /route\.tsx?$/.test(file)
      ? HTTP_METHODS.filter((m) => typeof mod[m] === 'function').map((m) => mod[m] as (...a: unknown[]) => Promise<unknown>)
      : [mod.default as (...a: unknown[]) => Promise<unknown>];
    expect(entries.length).toBeGreaterThan(0);
    for (const fn of entries) {
      const before = state.calls;
      const args = /route\.tsx?$/.test(file) ? [new Request('http://localhost:3000/x'), props] : [props];
      await expect(fn(...args)).rejects.toThrow('REQUIRE_OWNER_REFUSED');
      expect(state.calls).toBe(before + 1);
    }
  });
});
