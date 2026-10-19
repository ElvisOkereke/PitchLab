import type { Db } from '../db/client';
import type { ModelRouter } from '../llm/types';
import type { SignalSource } from '../tools/sources/types';
import type { fetchPage } from '../tools/fetch-page';

export type RunConfig = {
  seedType: 'open' | 'sector' | 'lens' | 'idea';
  sectors?: string[];
  lensIds?: string[];
  ideaText?: string;
  marketId: string;
  ideaCount: number;
  advanceCount: number;
  maxSearchesPerCall: number;
  /** Web searches per sector research call (open/sector seeds). Optional so configs stored before tuning-3 still load; code defaults to 3. */
  researchSearchesPerSector?: number;
  minSignals: number;
  dedupeThreshold: number;
};

export function defaultRunConfig(partial: Partial<RunConfig> & Pick<RunConfig, 'seedType'>): RunConfig {
  return {
    marketId: 'ca-us',
    ideaCount: 12,
    advanceCount: 3,
    maxSearchesPerCall: 5,
    researchSearchesPerSector: 3,
    minSignals: 3,
    dedupeThreshold: 0.88,
    ...partial,
  };
}

export const STAGES = ['harvest', 'ideate', 'dedupe', 'screen', 'gate', 'case', 'verify', 'score'] as const;
export type Stage = (typeof STAGES)[number];

export type StageDeps = {
  db: Db;
  router: ModelRouter;
  sources: SignalSource[];
  fetchPage: typeof fetchPage;
  log: (msg: string) => void;
};

/**
 * One pipeline stage as the orchestrator calls it: it receives the previous stage's output
 * (undefined for harvest) and returns a JSON-serialisable object that is stored in `run_stages.output`.
 * `input` is `any` because each stage takes a different shape and the orchestrator only chains them.
 */
export type StageFn = (deps: StageDeps, run: { id: string; config: RunConfig }, input: any) => Promise<object>;
