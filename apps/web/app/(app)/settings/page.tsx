import { listActiveLenses } from '@bcg/core/dashboard/lenses';
import { getMarket } from '@bcg/core/dashboard/markets';
import { QUEUE_MARKET_ID } from '@bcg/core/dashboard/runs';
import { databaseReachable, readEditableSettings, readWorkerStatus } from '@bcg/core/dashboard/settings';
import { SettingsView } from '@/components/settings-view';
import { requireOwner } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';

/** Sender/landing settings (editable) and read-only connections, models, lenses, market and criteria. */
export default async function SettingsPage() {
  await requireOwner();
  const db = getDb();
  const [values, worker, database, lenses, market] = await Promise.all([
    readEditableSettings(db),
    readWorkerStatus(db),
    databaseReachable(db),
    listActiveLenses(db),
    getMarket(db, QUEUE_MARKET_ID),
  ]);
  return <SettingsView data={{ values, worker, database, lenses, market }} />;
}
