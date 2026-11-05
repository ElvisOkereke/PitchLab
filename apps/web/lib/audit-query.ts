import { holdoutList, holdoutStoredResult, type StoredHoldoutResult } from '@bcg/core/audit/holdout';
import { computePassAudit, type PassAudit } from '@bcg/core/audit/pass-audit';
import type { PassRow } from '@bcg/core/bench/passes';
import type { Db } from '@bcg/core/db/client';

export type PassAuditView = { audit: PassAudit; holdoutItems: number; holdout: StoredHoldoutResult | null };

/**
 * The audit of each given finished pass, plus the holdout comparison last stored for it by `gen bench report` (nothing is
 * embedded or sent to a model here). Passes still running are skipped.
 */
export async function loadAuditViews(db: Db, passes: PassRow[]): Promise<Record<string, PassAuditView>> {
  const examples = await holdoutList(db);
  const views: Record<string, PassAuditView> = {};
  for (const p of passes) {
    if (p.status === 'running') continue;
    views[p.id] = {
      audit: await computePassAudit(db, p.id),
      holdoutItems: examples.length,
      holdout: examples.length === 0 ? null : await holdoutStoredResult(db, p.id),
    };
  }
  return views;
}
