import { describe, expect, it } from 'vitest';
import { safeNext } from '@/lib/auth/safe-next';

describe('safeNext', () => {
  it('safeNext blocks open redirects', () => {
    for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', '/%2F%2Fevil.com', 'javascript:alert(1)', '', 42]) {
      expect(safeNext(bad)).toBe('/');
    }
    expect(safeNext('/cases/a-b?tab=score')).toBe('/cases/a-b?tab=score');
  });

  it('blocks other tricks', () => {
    for (const bad of [
      null, undefined, {}, ['/x'], 'evil.com', '/%5Cevil.com', '/%5C%5Cevil.com', '/\t/evil.com', '/\n/evil.com',
      ' //evil.com', '/%2f%2fevil.com', '\\\\evil.com', '/a\\b', '/%E0%A4%A', `/${'a'.repeat(3000)}`,
    ]) expect(safeNext(bad)).toBe('/');
  });

  it('keeps ordinary relative paths', () => {
    for (const ok of ['/', '/leaderboard', '/cases/x/export.md', '/runs?page=2', '/cases/a#score']) expect(safeNext(ok)).toBe(ok);
  });
});
