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
  minSignals: number;
  dedupeThreshold: number;
};

export function defaultRunConfig(partial: Partial<RunConfig> & Pick<RunConfig, 'seedType'>): RunConfig {
  return {
    marketId: 'ca-us',
    ideaCount: 12,
    advanceCount: 3,
    maxSearchesPerCall: 5,
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
