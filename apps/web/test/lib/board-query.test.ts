import { describe, expect, it } from 'vitest';
import { boardHref, parseBoardQuery, selectedStage } from '@/lib/board-query';

const zero = { new: 0, validating: 0, pilot: 0, live: 0, killed: 0 };

describe('board query', () => {
  it('parses valid params and drops invalid ones', () => {
    expect(parseBoardQuery({ stage: 'pilot', lens: 'aggregator', minAi: '3.5', notice: 'rerun_queued' }))
      .toEqual({ stage: 'pilot', lens: 'aggregator', minAi: 3.5, notice: 'rerun_queued' });
    expect(parseBoardQuery({ stage: 'archived', lens: 'x;drop table', minAi: '9', notice: '<script>' }))
      .toEqual({ stage: undefined, lens: undefined, minAi: undefined, notice: undefined });
    expect(parseBoardQuery({ minAi: 'abc' }).minAi).toBeUndefined();
    expect(parseBoardQuery({ minAi: '' }).minAi).toBeUndefined();
    expect(parseBoardQuery({ stage: ['live', 'new'] }).stage).toBe('live');
    expect(parseBoardQuery({})).toEqual({ stage: undefined, lens: undefined, minAi: undefined, notice: undefined });
  });

  it('defaults the phone column to the first non-empty stage', () => {
    expect(selectedStage(undefined, { ...zero, pilot: 2, killed: 1 })).toBe('pilot');
    expect(selectedStage(undefined, zero)).toBe('new');
    expect(selectedStage('killed', { ...zero, new: 3 })).toBe('killed');
  });

  it('builds hrefs that keep filters', () => {
    expect(boardHref({})).toBe('/');
    expect(boardHref({ stage: 'live', lens: 'aggregator', minAi: 3 })).toBe('/?stage=live&lens=aggregator&minAi=3');
  });
});
