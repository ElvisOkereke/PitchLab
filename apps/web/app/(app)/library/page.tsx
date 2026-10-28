import { backgroundSpendToday, getResearchSettings, listMissions, typicalMissionCost } from '@bcg/core/dashboard/missions';
import { getLibraryItem, libraryCoverage, searchLibrary } from '@bcg/core/library/store';
import { fetchStats } from '@bcg/core/research/fetch-log';
import { LibraryView } from '@/components/library-view';
import { requireOwner } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';
import { libraryFilter, parseLibraryQuery } from '@/lib/library-query';

/** The research library: search, one entry in full, coverage, and research missions. */
export default async function LibraryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const query = parseLibraryQuery(await searchParams);
  const db = getDb();
  const now = new Date();
  const [results, coverage, fetches, item, missions, typicalCost, research, backgroundSpend] = await Promise.all([
    searchLibrary(db, libraryFilter(query)),
    libraryCoverage(db),
    fetchStats(db, { days: 30 }),
    query.item ? getLibraryItem(db, query.item) : Promise.resolve(null),
    listMissions(db, 20),
    typicalMissionCost(db),
    getResearchSettings(db),
    backgroundSpendToday(db, now),
  ]);
  return (
    <LibraryView
      query={query}
      rows={results.rows}
      total={results.total}
      coverage={coverage}
      fetches={fetches}
      item={item}
      missions={missions}
      typicalCost={typicalCost}
      research={research}
      backgroundSpend={backgroundSpend}
      now={now}
    />
  );
}
