import type { PassRow } from '@bcg/core/bench/passes';

export const MAX_PASS_COLUMNS = 5;

/** The passes the Progress scorecard shows, left to right: the oldest baseline (the canonical one), then the newest finished passes, oldest first. `passes` is newest first. */
export function progressColumns(passes: PassRow[]): PassRow[] {
  const baseline = passes.filter((p) => p.kind === 'baseline').at(-1) ?? null;
  const recent = passes.filter((p) => p.kind !== 'baseline' && p.status !== 'running').slice(0, MAX_PASS_COLUMNS).reverse();
  return baseline ? [baseline, ...recent] : recent;
}
