import { listBoard, listGateKills } from '@bcg/core/dashboard/board';
import { listActiveLenses } from '@bcg/core/dashboard/lenses';
import { BoardView } from '@/components/board-view';
import { requireOwner } from '@/lib/auth/require-owner';
import { parseBoardQuery } from '@/lib/board-query';
import { getDb } from '@/lib/db';

export default async function BoardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOwner();
  const query = parseBoardQuery(await searchParams);
  const db = getDb();
  const [board, gateKills, lenses] = await Promise.all([
    listBoard(db, { lensId: query.lens, minAi: query.minAi }),
    listGateKills(db),
    listActiveLenses(db),
  ]);
  return <BoardView board={board} gateKills={gateKills} lenses={lenses} query={query} />;
}
