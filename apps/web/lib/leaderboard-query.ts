import { LeaderSortSchema, type LeaderSort } from '@bcg/core/dashboard/leaderboard';

const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);

/** `?key=&by=&dir=` through core's allowlist: anything unknown falls back (AI total, descending). */
export function parseLeaderSort(sp: Record<string, string | string[] | undefined>): LeaderSort {
  return LeaderSortSchema.parse({ key: first(sp.key), by: first(sp.by), dir: first(sp.dir) });
}

export function leaderHref(s: LeaderSort): string {
  return `/leaderboard?${new URLSearchParams({ key: s.key, by: s.by, dir: s.dir }).toString()}`;
}
