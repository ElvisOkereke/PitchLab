import type { CaseStage } from '@bcg/core/db/schema';

// A literal copy so client components do not pull core's Drizzle schema into the browser bundle. The type check below
// fails the typecheck if core's stage enum gains or loses a stage.
export const STAGES = ['new', 'validating', 'pilot', 'live', 'killed'] as const satisfies readonly CaseStage[];
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _sameStages: Same<(typeof STAGES)[number], CaseStage> = true;
void _sameStages;

export const STAGE_LABEL: Record<CaseStage, string> = {
  new: 'New',
  validating: 'Validating',
  pilot: 'Pilot',
  live: 'Live',
  killed: 'Killed',
};

/** A 1-dp score or an en dash when there is none. */
export function formatScore(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(1);
}

/** Plain-English names for the engine v2 run stages; the older stages keep their own names. */
const RUN_STAGE_LABEL: Record<string, string> = {
  sketch: 'sketch ideas',
  archive: 'filter repeats',
  tournament: 'rank ideas',
  evolve: 'improve top ideas',
};

export function runStageLabel(stage: string): string {
  return RUN_STAGE_LABEL[stage] ?? stage;
}
