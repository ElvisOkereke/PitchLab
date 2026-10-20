import { listLeaderboard, sortLeaderboard } from '@bcg/core/dashboard/leaderboard';
import { LeaderboardTable } from '@/components/leaderboard-table';
import { requireOwner } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';
import { parseLeaderSort } from '@/lib/leaderboard-query';

/** Every case, sortable by totals, title or any criterion (`?key=&by=&dir=`, allow-listed). */
export default async function LeaderboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const sort = parseLeaderSort(await searchParams);
  const rows = sortLeaderboard(await listLeaderboard(getDb()), sort);
  return (
    <main className="leaderboard-page">
      <h1>Leaderboard</h1>
      <p className="muted small">Cells show AI/you. Tap a header to sort; under each criterion pick whose score to sort by.</p>
      <LeaderboardTable rows={rows} sort={sort} />
    </main>
  );
}
