import { describe, expect, it } from 'vitest';
import type { PassRow } from '../../src/bench/passes';
import type { Scorecard } from '../../src/bench/scorecard';
import { METRIC_DEFS } from '../../src/bench/definitions';
import { renderScorecardMarkdown, type AuditView } from '../../src/bench/markdown';

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

const emptyAudit = (): AuditView => ({
  audit: { signals: { total: 0, byVoice: {}, bySource: {}, topDomains: [] }, lenses: [], gateKills: {}, dropReasons: {}, demandShare: null, nicheShare: null, flags: [] },
  holdoutItems: 0, holdout: null,
});

describe('audit section', () => {
  const id = '00000000-0000-4000-8000-000000000001';

  it('an empty audit reads no data without NaN or Infinity', () => {
    const md = renderScorecardMarkdown([pass('p', card({}))], { [id]: emptyAudit() });
    expect(md).toContain('### Audit');
    expect(md).toContain('- Evidence: no data');
    expect(md).toContain('- Lens yield: no data');
    expect(md).toContain('- Gate kills by check: no data');
    expect(md).toContain('- Ideas resting on a trend, rule change or market: no data');
    expect(md).toContain('- Niche share (idea reviewer): no data');
    expect(md).toContain('- Audit flags: none');
    expect(md).toContain('- Holdout examples: none set');
    expect(md).not.toMatch(/NaN|Infinity|undefined/);
  });

  it('shows every field, the flags and the holdout comparison, escaping text', () => {
    const v = emptyAudit();
    v.audit = {
      signals: { total: 20, byVoice: { operator: 15, vendor: 5 }, bySource: { reddit: 20 }, topDomains: [{ domain: 'wordpress.org', share: 0.18 }] },
      lenses: [{ lensId: 'aggregator', ideas: 8, screenedIn: 5, advanced: 2, cases: 2 }],
      gateKills: { control: 3 }, dropReasons: { 'too vague': 4 }, demandShare: 0.5, nicheShare: 0.25,
      flags: ['wordpress.org supplied 18% of the evidence (limit 15%)'],
    };
    v.holdoutItems = 2;
    v.holdout = { items: [{ text: 'my [idea](http://x.com)', bestIdeaTitle: 'Best | idea', similarity: 0.612 }], median: 0.612 };
    const md = renderScorecardMarkdown([pass('p', card({}))], { [id]: v });
    expect(md).toContain('- Evidence: 20 signals');
    expect(md).toContain('- Voices: operator 15, vendor 5');
    expect(md).toContain('- Top domains: wordpress.org 18%');
    expect(md).toContain('  - aggregator: 8 ideas, 5 reached the gate, 2 advanced, 2 cases');
    expect(md).toContain('- Gate kills by check: control 3');
    expect(md).toContain('- Ideas dropped by ideate: too vague 4');
    expect(md).toContain('- Ideas resting on a trend, rule change or market: 50%');
    expect(md).toContain('- Niche share (idea reviewer): 25%');
    expect(md).toContain('  - wordpress.org supplied 18% of the evidence (limit 15%)');
    expect(md).toContain('median similarity 0.61');
    expect(md).toContain(String.raw`my \[idea\](http://x.com): closest idea Best | idea (0.61)`);
  });

  it('says when examples exist but this pass has no comparison', () => {
    const v = emptyAudit();
    v.holdoutItems = 3;
    expect(renderScorecardMarkdown([pass('p', card({}))], { [id]: v })).toContain('- Holdout examples: 3 set, no comparison for this pass');
  });

  it('without audits the report is unchanged', () => {
    expect(renderScorecardMarkdown([pass('p', card({}))])).not.toContain('### Audit');
  });
});

