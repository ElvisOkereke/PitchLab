import type { Db } from '../db/client';
import type { FewShot } from '../pipeline/engine/schema';

/**
 * Few-shot examples for the tournament judge: kept-versus-killed Board pairs from the training split only (spec §4,
 * §5), at most FEWSHOT_PAIRS_MAX. Until judge calibration lands (Task 7) there are none.
 */
export async function fewShotPairs(_db: Db, _n?: number): Promise<FewShot[]> {
  return [];
}
