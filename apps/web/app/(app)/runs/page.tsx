import { listActiveLenses } from '@bcg/core/dashboard/lenses';
import { getMarket } from '@bcg/core/dashboard/markets';
import { missionRunning } from '@bcg/core/dashboard/missions';
import { QUEUE_MARKET_ID, countRunsByStatus, listRuns } from '@bcg/core/dashboard/runs';
import { AutoRefresh } from '@/components/auto-refresh';
import { QueueRunForm } from '@/components/queue-run-form';
import { RunsHistory } from '@/components/runs-history';
import { requireOwner } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';
import { RUNS_NOTICES, parseRunsQuery } from '@/lib/runs-query';

const PAGE_SIZE = 20;
const REFRESH_MS = 10_000;

/** Queue a run and follow the history (`?page=`); refreshes itself while a run is queued or running. */
export default async function RunsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const query = parseRunsQuery(await searchParams);
  const db = getDb();
  const [history, counts, lenses, market, missionBusy] = await Promise.all([
    listRuns(db, { page: query.page, pageSize: PAGE_SIZE }),
    countRunsByStatus(db),
    listActiveLenses(db),
    getMarket(db, QUEUE_MARKET_ID),
    missionRunning(db),
  ]);
  const busy = counts.queued + counts.running > 0;
  return (
    <main className="runs-page">
      <h1>Runs</h1>
      {query.notice ? (
        <p className="notice card" role="status">
          {RUNS_NOTICES[query.notice]}
        </p>
      ) : null}
      <section aria-labelledby="queue-title" className="card">
        <h2 id="queue-title">Queue a run</h2>
        <QueueRunForm sectors={market?.sectors ?? []} lenses={lenses} />
        <p className="muted small">
          Runs execute when <code>npm run worker</code> is running.
        </p>
        {missionBusy ? (
          <p className="muted small" data-testid="mission-busy-note">
            The worker is busy with a research mission; queued runs start after it.
          </p>
        ) : null}
      </section>
      <p>
        {counts.queued} queued · {counts.running} running
        {busy ? <span className="muted small"> · this page refreshes every 10 s</span> : null}
      </p>
      <RunsHistory rows={history.rows} total={history.total} page={query.page} pageSize={PAGE_SIZE} />
      {busy ? <AutoRefresh everyMs={REFRESH_MS} /> : null}
    </main>
  );
}
