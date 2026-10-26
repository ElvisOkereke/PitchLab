import { describe, expect, it } from 'vitest';
import type { PassRow } from '../../src/bench/passes';
import type { Scorecard } from '../../src/bench/scorecard';
import { METRIC_DEFS } from '../../src/bench/definitions';
import { renderScorecardMarkdown } from '../../src/bench/markdown';

const card = (over: Record<string, { display: string; meets: boolean | null }>): Scorecard => ({
  metrics: METRIC_DEFS.map((d) => {
    const o = over[d.id];
    return o
      ? { id: d.id, value: 1, display: o.display, meets: o.meets, status: 'measured' as const }
      : { id: d.id, value: null, display: 'no data', meets: null, status: 'no_data' as const };
  }),
  extra: { runs: 4, ideas: 48, cases: 12, scoredCases: 2, medianRoi: 3.2, newVsHistory: null },
  notes: ['1 of 4 runs failed'],
});
const pass = (label: string, metrics: Scorecard | null): PassRow => ({
  id: '00000000-0000-4000-8000-000000000001', version: 'bench-v1', label, kind: 'pass', status: 'complete', runIds: [], metrics,
  sourcePassId: null, createdAt: new Date('2026-10-26T00:00:00Z'), completedAt: null,
});

describe('renderScorecardMarkdown', () => {
  it('shows a check, a cross or nothing per cell, and the small-sample note', () => {
    const md = renderScorecardMarkdown([pass('baseline-0', card({ repetition: { display: '0.40', meets: true }, margin: { display: '50%', meets: false } }))]);
    expect(md).toMatch(/\| Repetition \| below 0\.55 \| 0\.40 ✓ \|/);
    expect(md).toMatch(/\| Our margin \| 100% \| 50% ✗ \|/);
    expect(md).toMatch(/\| Buyer variety \| at least 8 per run \| no data \|/);
    expect(md).toContain('Small sample: differences under about 0.05 similarity or one case may be noise.');
    expect(md).toContain('1 of 4 runs failed');
  });

  it('prints the pass id in each pass section', () => {
    const md = renderScorecardMarkdown([pass('baseline-0', card({}))]);
    expect(md).toContain('Id: 00000000-0000-4000-8000-000000000001');
  });

  it('escapes pipes and Markdown in labels and notes', () => {
    const p = pass('a|b\n[x](http://e.com)', card({}));
    const md = renderScorecardMarkdown([p]);
    expect(md).toContain(String.raw`a\|b \[x\](http://e.com)`);
    const header = md.split('\n').find((l) => l.startsWith('| Metric'));
    expect(header).not.toContain('a|b');
  });

  it('handles a pass with no metrics', () => {
    expect(renderScorecardMarkdown([pass('p', null)])).toContain('no data');
  });
});
