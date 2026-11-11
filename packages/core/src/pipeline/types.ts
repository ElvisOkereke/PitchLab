import type { Db } from '../db/client';
import type { ModelRouter } from '../llm/types';
import type { SignalSource } from '../tools/sources/types';
import type { fetchPage } from '../tools/fetch-page';

export type RunConfig = {
  seedType: 'open' | 'sector' | 'lens' | 'idea' | 'finds';
  sectors?: string[];
  lensIds?: string[];
  ideaText?: string;
  /** Finds seed: the finds (rows of `finds`, captured) the run starts from, in order. Queueing fills in the most recent ones when none are given. */
  findIds?: string[];
  marketId: string;
  ideaCount: number;
  advanceCount: number;
  maxSearchesPerCall: number;
  /** Web searches per sector research call (open/sector seeds). Optional so configs stored before tuning-3 still load; code defaults to 3. */
  researchSearchesPerSector?: number;
  minSignals: number;
  dedupeThreshold: number;
  /** Set when the owner re-runs a gate-killed idea from the dashboard: the idea this run overturns (feedback signal). */
  overturnOfIdeaId?: string;
  /**
   * Which generation engine the run uses. defaultRunConfig sets v2 for every new run; absent (a run stored before engine
   * v2) reads as v1, so a resumed old run keeps its engine (see usesEngineV2).
   */
  engine?: 'v1' | 'v2';
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
    engine: 'v2',
    ...partial,
  };
}

/**
 * True when the run asks for engine v2 (every new run does, via defaultRunConfig) and does not start from an owner idea
 * (which skips sketching and the tournament). A config without the field (stored before engine v2) is v1.
 */
export function usesEngineV2(cfg: RunConfig): boolean {
  return cfg.engine === 'v2' && cfg.seedType !== 'idea';
}

export const STAGES = ['harvest', 'sketch', 'archive', 'tournament', 'evolve', 'ideate', 'dedupe', 'screen', 'gate', 'case', 'verify', 'score'] as const;
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
