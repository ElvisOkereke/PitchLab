import { listActiveLenses } from '@bcg/core/dashboard/lenses';
import { getMarket } from '@bcg/core/dashboard/markets';
import { QUEUE_MARKET_ID } from '@bcg/core/dashboard/runs';
import { databaseReachable, readEditableSettings, readWorkerStatus } from '@bcg/core/dashboard/settings';
import { exampleState } from '@bcg/core/example/example';
import { SettingsView } from '@/components/settings-view';
import { requireOwner } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';
import { parseSettingsNotice } from '@/lib/settings-query';

/** Sender/landing settings (editable) and read-only connections, models, lenses, market and criteria. */
export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const notice = parseSettingsNotice(await searchParams);
  const db = getDb();
  const [values, worker, database, lenses, market, example] = await Promise.all([
    readEditableSettings(db),
    readWorkerStatus(db),
    databaseReachable(db),
    listActiveLenses(db),
    getMarket(db, QUEUE_MARKET_ID),
    exampleState(db),
  ]);
  return <SettingsView data={{ values, worker, database, lenses, market, example: { hidden: example.hidden } }} notice={notice} />;
}
