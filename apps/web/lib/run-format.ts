import type { RunConfig } from '@bcg/core/pipeline/types';
import { usd } from './time';

const IDEA_SHOWN = 80;

/** How a run was seeded, in a few words: `open`, `sector: HVAC, plumbing`, `lens: aggregator`, `idea: Daily test…`. */
export function seedSummary(config: Partial<RunConfig> | null | undefined): string {
  const c = config ?? {};
  switch (c.seedType) {
    case 'sector':
      return `sector: ${(c.sectors ?? []).join(', ')}`;
    case 'lens':
      return `lens: ${(c.lensIds ?? []).join(', ')}`;
    case 'idea': {
      const text = (c.ideaText ?? '').replace(/\s+/g, ' ').trim();
      return `idea: ${text.length > IDEA_SHOWN ? `${text.slice(0, IDEA_SHOWN)}…` : text}`;
    }
    case 'open':
      return 'open';
    default:
      return 'unknown';
  }
}

/** The stored numeric cost (a string) as `$1.23`. */
export function runCost(costUsd: string | number | null | undefined): string {
  return usd(Number(costUsd ?? 0));
}
