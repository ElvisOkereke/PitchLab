import { FETCH_OUTCOMES, FETCH_VIAS } from '@bcg/core/db/schema';
import { describe, expect, it } from 'vitest';
import { OUTCOME_LABEL, VIA_LABEL } from '@/lib/fetch-labels';

// Imported here (test only): fetch-labels stays free of core imports so it is web-safe.
describe('fetch labels', () => {
  it('every core fetch outcome has a plain label', () => {
    expect(FETCH_OUTCOMES.filter((o) => !OUTCOME_LABEL[o])).toEqual([]);
  });
  it('every core fetch route has a label', () => {
    expect(FETCH_VIAS.filter((v) => !VIA_LABEL[v])).toEqual([]);
  });
});
