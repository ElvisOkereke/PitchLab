import { sortLeaderboard, type LeaderRow, type LeaderSort } from '@bcg/core/dashboard/leaderboard';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LeaderboardTable } from '@/components/leaderboard-table';
import { leaderHref, parseLeaderSort } from '@/lib/leaderboard-query';

afterEach(cleanup);

const row = (slug: string, o: Partial<LeaderRow> = {}): LeaderRow => ({
  slug, title: slug.toUpperCase(), stage: 'new', ai: {}, owner: {}, aiTotal: null, ownerTotal: null, ...o,
});
const rows = [
  row('alpha', { aiTotal: 3.2, ownerTotal: 4, ai: { pain: 4, roi: 2 }, owner: { pain: 5, gut: 3 } }),
  row('bravo', { aiTotal: null, ownerTotal: null }),
  row('charlie', { aiTotal: 4.1, ai: { pain: 2 }, stage: 'pilot' }),
];
const headerLink = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll('thead a')].find((a) => a.textContent?.replace(/[▲▼]/g, '').trim() === name)!;

describe('LeaderboardTable', () => {
  it('sort links toggle direction and keep by', () => {
    const sort: LeaderSort = { key: 'pain', by: 'owner', dir: 'desc' };
    const { container } = render(<LeaderboardTable rows={sortLeaderboard(rows, sort)} sort={sort} />);
    expect(headerLink(container, 'Pain severity').getAttribute('href')).toBe('/leaderboard?key=pain&by=owner&dir=asc');
    expect(headerLink(container, 'Title').getAttribute('href')).toBe('/leaderboard?key=title&by=owner&dir=asc');
    expect(headerLink(container, 'AI').getAttribute('href')).toBe('/leaderboard?key=ai&by=owner&dir=desc');
    expect(container.querySelector('th[aria-sort="descending"]')?.textContent).toContain('Pain severity');

    // Under each criterion header: AI | You, keeping the direction; gut has the owner's value only.
    const toggles = [...container.querySelectorAll('thead [data-criterion="roi"] .by-toggle a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(toggles).toEqual([['AI', '/leaderboard?key=roi&by=ai&dir=desc'], ['You', '/leaderboard?key=roi&by=owner&dir=desc']]);
    expect(container.querySelector('thead [data-criterion="gut"] .by-toggle')).toBeNull();
    expect(container.querySelector('thead [data-criterion="pain"] .by-toggle a[aria-current="true"]')?.textContent).toBe('You');
  });

  it('null scores show – and sort last', () => {
    for (const dir of ['asc', 'desc'] as const) {
      const sort: LeaderSort = { key: 'ai', by: 'ai', dir };
      const { container } = render(<LeaderboardTable rows={sortLeaderboard(rows, sort)} sort={sort} />);
      const body = [...container.querySelectorAll('tbody tr')];
      expect(body.map((r) => r.getAttribute('data-slug'))).toEqual(dir === 'desc' ? ['charlie', 'alpha', 'bravo'] : ['alpha', 'charlie', 'bravo']);
      const bravo = body.at(-1)!;
      expect(bravo.querySelector('[data-col="ai"]')?.textContent).toBe('–');
      expect(bravo.querySelector('[data-col="owner"]')?.textContent).toBe('–');
      cleanup();
    }
  });

  it('cells show ai/owner per criterion (gut owner only) and link the title', () => {
    const sort: LeaderSort = { key: 'ai', by: 'ai', dir: 'desc' };
    const { container } = render(<LeaderboardTable rows={rows} sort={sort} />);
    const alpha = container.querySelector('tr[data-slug="alpha"]')!;
    expect(alpha.querySelector('[data-col="pain"]')?.textContent).toBe('4/5');
    expect(alpha.querySelector('[data-col="roi"]')?.textContent).toBe('2/–');
    expect(alpha.querySelector('[data-col="gut"]')?.textContent).toBe('3');
    expect(alpha.querySelector('[data-col="ai"]')?.textContent).toBe('3.2');
    expect(alpha.querySelector('a')?.getAttribute('href')).toBe('/cases/alpha');
    expect(container.querySelector('table')?.parentElement?.classList.contains('scroll-x')).toBe(true);
  });

  it('renders hostile titles as text', () => {
    const { container } = render(<LeaderboardTable rows={[row('x', { title: '<img src=x onerror=alert(1)>' })]} sort={{ key: 'ai', by: 'ai', dir: 'desc' }} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('leaderboard query', () => {
  it('parses through the allowlist and builds links', () => {
    expect(parseLeaderSort({ key: 'title;drop table cases', by: 'x', dir: ['asc', 'desc'] })).toEqual({ key: 'ai', by: 'ai', dir: 'asc' });
    expect(parseLeaderSort({ key: 'gut', by: 'owner', dir: 'asc' })).toEqual({ key: 'gut', by: 'owner', dir: 'asc' });
    expect(leaderHref({ key: 'title', by: 'ai', dir: 'asc' })).toBe('/leaderboard?key=title&by=ai&dir=asc');
  });
});
