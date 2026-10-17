import type { Db } from '../db/client';
import { dataCalls } from '../db/schema';

export async function logDataCall(
  db: Db,
  call: { runId: string | null; provider: string; endpoint: string; costUsd?: number; ok: boolean },
): Promise<void> {
  await db.insert(dataCalls).values({
    runId: call.runId,
    provider: call.provider,
    endpoint: call.endpoint,
    costUsd: String(call.costUsd ?? 0),
    ok: call.ok,
  });
}
