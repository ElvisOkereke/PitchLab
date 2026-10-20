import { needsYou, spendSince, torontoDayStart, torontoWeekStart } from '@bcg/core/dashboard/command';
import { countRunsByStatus, listRuns } from '@bcg/core/dashboard/runs';
import { readWorkerStatus } from '@bcg/core/dashboard/settings';
import { CommandCenter } from '@/components/command-center';
import { requireOwner } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';

const RECENT_RUNS = 5;

/** What needs the owner, spend today/this week (Toronto days), generator status and the latest runs. */
export default async function CommandPage() {
  await requireOwner();
  const db = getDb();
  const now = new Date();
  const [items, today, week, worker, runs, recent] = await Promise.all([
    needsYou(db, now),
    spendSince(db, torontoDayStart(now)),
    spendSince(db, torontoWeekStart(now)),
    readWorkerStatus(db),
    countRunsByStatus(db),
    listRuns(db, { page: 1, pageSize: RECENT_RUNS }),
  ]);
  return <CommandCenter data={{ now, needsYou: items, spend: { today, week }, worker, runs, recent: recent.rows }} />;
}
