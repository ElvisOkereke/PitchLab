import type { PassRow } from '@bcg/core/bench/passes';
import type { MetricResult, Scorecard } from '@bcg/core/bench/scorecard';
import { METRIC_DEFS } from '@bcg/core/bench/definitions';
import type { PassAuditView } from '@/lib/audit-query';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/actions/bench', () => ({ runBenchmarkAction: vi.fn(async () => ({})), recomputePassAction: vi.fn(async () => ({})) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { ProgressView } = await import('@/components/progress-view');

afterEach(cleanup);

const COST = 'about $12–28 in model calls (4 runs at about $3–7 each)';
const metric = (o: Partial<MetricResult>): Partial<MetricResult> => ({ value: null, display: '–', meets: null, status: 'no_data', ...o });
const card = (over: Record<string, Partial<MetricResult>> = {}): Scorecard =>
  ({ metrics: Object.entries(over).map(([id, m]) => ({ id, ...m })), notes: [] }) as unknown as Scorecard;
const pass = (o: Partial<PassRow>): PassRow => ({
  id: 'p', version: 'bench-v1', label: 'bench-v1 #1', kind: 'pass', status: 'complete', runIds: [], metrics: card(),
  sourcePassId: null, createdAt: new Date('2026-10-20T12:00:00Z'), completedAt: new Date('2026-10-20T13:00:00Z'), ...o,
});
const emptyAudit = (): PassAuditView => ({
  audit: { signals: { total: 0, byVoice: {}, bySource: {}, topDomains: [] }, lenses: [], gateKills: {}, dropReasons: {}, demandShare: null, nicheShare: null, flags: [] },
  holdoutItems: 0, holdout: null,
});
const base = { costNote: COST, runCount: 5, running: null, scoreCases: null };

describe('ProgressView', () => {
  it('shows a row per metric with its target, and the baseline-missing text', () => {
    const { container } = render(<ProgressView {...base} passes={[]} />);
    expect(container.querySelector('[data-tour="progress-scorecard"]')).not.toBeNull();
    expect(container.querySelectorAll('tbody tr')).toHaveLength(METRIC_DEFS.length);
    expect(container.textContent).toContain('below 0.55');
    expect(container.textContent).toContain('No baseline yet. Run: npm run gen -- bench baseline');
    expect(container.textContent).toContain('Small sample: differences under about 0.05 similarity or one case may be noise.');
  });

  it('renders ok, bad and muted cells and the incomplete badge', () => {
    const passes = [
      pass({ id: 'b', kind: 'baseline', label: 'baseline-0', version: 'baseline', metrics: card({
        repetition: metric({ value: 0.7, display: '0.70', meets: false, status: 'measured' }),
        nearDuplicates: metric({ value: 0.05, display: '5%', meets: true, status: 'measured' }),
        buyerVariety: metric({ status: 'no_data', display: 'no data' }),
        consumerShare: metric({ status: 'not_measured', display: 'not measured yet' }),
      }) }),
      pass({ id: 'q', status: 'incomplete' }),
    ];
    const { container } = render(<ProgressView {...base} passes={passes} />);
    const rep = container.querySelector('tr[data-metric="repetition"]')!;
    expect(rep.querySelector('.badge-bad')).not.toBeNull();
    expect(container.querySelector('tr[data-metric="nearDuplicates"] .badge-ok')).not.toBeNull();
    const muted = container.querySelector('tr[data-metric="buyerVariety"] td')!;
    expect(muted.querySelector('.badge-ok, .badge-bad')).toBeNull();
    expect(muted.textContent).toContain('no data');
    expect(container.querySelector('tr[data-metric="consumerShare"]')?.textContent).toContain('not measured yet');
    expect(container.querySelector('thead .badge-warn')?.textContent).toBe('incomplete');
    expect(container.textContent).not.toContain('No baseline yet');
    expect(container.textContent).toContain('2026-10-20');
  });

  it('lists a pass\'s notes as text under the table', () => {
    const m = { ...card(), notes: ['1 of 4 runs failed', '<b>x</b>'] } as Scorecard;
    const { container } = render(<ProgressView {...base} passes={[pass({ status: 'incomplete', metrics: m })]} />);
    const li = [...container.querySelectorAll('section[aria-label="Notes on each column"] li')].map((e) => e.textContent);
    expect(li).toEqual(['1 of 4 runs failed', '<b>x</b>']);
    expect(container.querySelector('section b')).toBeNull();
  });

  it('renders demand evidence as a measured row, not "not measured yet"', () => {
    const passes = [pass({ metrics: card({ demandEvidence: metric({ value: 0.75, display: '75% (3 of 4)', meets: false, status: 'measured' }) }) })];
    const { container } = render(<ProgressView {...base} passes={passes} />);
    const row = container.querySelector('tr[data-metric="demandEvidence"]')!;
    expect(row.textContent).toContain('75% (3 of 4)');
    expect(row.textContent).not.toContain('not measured yet');
    expect(row.textContent).toContain('at least 80%');
  });

  it('shows at most 5 passes after the baseline', () => {
    const passes = [pass({ id: 'b', kind: 'baseline', label: 'baseline-0' }),
      ...Array.from({ length: 7 }, (_, i) => pass({ id: `x${i}`, label: `bench-v1 #${7 - i}` }))];
    const { container } = render(<ProgressView {...base} passes={passes} />);
    expect(container.querySelectorAll('thead th')).toHaveLength(1 + 1 + 5);
  });

  it('shows the running line and hides the button while a pass is running', () => {
    const { container, queryByRole } = render(
      <ProgressView {...base} passes={[pass({ status: 'running', label: 'bench-v1 #2' })]} running={{ label: 'bench-v1 #2', done: 1, total: 4 }} />,
    );
    expect(container.textContent).toContain('bench-v1 #2 running: 1 of 4 runs finished');
    expect(container.querySelector('a[href="/runs"]')).not.toBeNull();
    expect(queryByRole('button', { name: 'Run benchmark' })).toBeNull();
  });

  it('shows the button, cost note and worker line when idle', () => {
    const { container, getByRole } = render(<ProgressView {...base} passes={[]} />);
    expect(getByRole('button', { name: 'Run benchmark' })).toBeTruthy();
    expect(container.textContent).toContain(COST);
    expect(container.textContent).toContain('Runs execute when npm run worker is running.');
  });

  it('links each case to its score tab with the gut score or not scored', () => {
    const { container } = render(
      <ProgressView {...base} passes={[pass({})]} scoreCases={{ label: 'bench-v1 #1', cases: [{ slug: 'a-b', title: 'A', gut: 4 }, { slug: 'c-d', title: 'C', gut: null }] }} />,
    );
    expect(container.querySelector('a[href="/cases/a-b?tab=score"]')).not.toBeNull();
    expect(container.querySelector('a[href="/cases/c-d?tab=score"]')).not.toBeNull();
    expect(container.textContent).toContain('Your gut: 4');
    expect(container.textContent).toContain('not scored');
  });

  it('uses the oldest baseline, and shows pass ids, Recompute buttons and metric reasons', () => {
    const passes = [
      pass({ id: 'newbaseline-id', kind: 'baseline', label: 'baseline-1' }),
      pass({ id: '12345678-aaaa-bbbb-cccc-ddddeeeeffff', label: 'bench-v1 #1', metrics: card({
        realNeed: metric({ status: 'no_data', display: 'no data', note: 'No generated idea in this set cites a signal.' }),
      }) }),
      pass({ id: 'oldbaseline-id', kind: 'baseline', label: 'baseline-0' }),
    ];
    const { container, getAllByRole } = render(<ProgressView {...base} passes={passes} />);
    const heads = [...container.querySelectorAll('thead th')].map((e) => e.textContent);
    expect(heads[1]).toContain('baseline-0');
    expect(container.textContent).not.toContain('baseline-1');
    expect(container.textContent).toContain('Id 12345678');
    expect(getAllByRole('button', { name: 'Recompute' })).toHaveLength(2);
    expect(container.querySelector('tr[data-metric="realNeed"]')?.textContent).toContain('No generated idea in this set cites a signal.');
  });

  it('renders hostile labels and titles as text', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const { container } = render(
      <ProgressView {...base} passes={[pass({ label: evil })]} scoreCases={{ label: evil, cases: [{ slug: 's', title: evil, gut: null }] }} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain(evil);
  });

  describe('audit under each pass', () => {
    it('an empty audit says no data and has no NaN, no flags and no holdout', () => {
      const { container } = render(<ProgressView {...base} passes={[pass({ id: 'a1' })]} audits={{ a1: emptyAudit() }} />);
      const t = container.querySelector('[data-testid="pass-audit"]')!.textContent!;
      expect(t).toContain('Evidence: no data');
      expect(t).toContain('Lens yield: no data');
      expect(t).toContain('Gate kills by check: no data');
      expect(t).toContain('Niche share (idea reviewer): no data');
      expect(t).toContain('None set. Add some on the Settings page.');
      expect(t).not.toMatch(/NaN|Infinity|undefined/);
      expect(container.querySelector('[data-testid="audit-flags"]')).toBeNull();
    });

    it('renders every field, the flags and the stored holdout comparison as text', () => {
      const v = emptyAudit();
      v.audit = {
        signals: { total: 20, byVoice: { operator: 15, vendor: 5 }, bySource: { reddit: 20 }, topDomains: [{ domain: 'wordpress.org', share: 0.18 }] },
        lenses: [{ lensId: 'aggregator', ideas: 8, screenedIn: 5, advanced: 2, cases: 2 }],
        gateKills: { control: 3 }, dropReasons: { 'too vague': 4 }, demandShare: 0.5, nicheShare: 0.25,
        flags: ['wordpress.org supplied 18% of the evidence (limit 15%)'],
      };
      v.holdoutItems = 1;
      v.holdout = { items: [{ text: 'my <i>idea</i>', bestIdeaTitle: '<b>Best</b>', similarity: 0.612 }], median: 0.612, computedAt: '2026-11-04T00:00:00Z' };
      const { container } = render(<ProgressView {...base} passes={[pass({ id: 'a1', label: 'bench-v3 #1' })]} audits={{ a1: v }} />);
      const t = container.querySelector('[data-testid="pass-audit"]')!.textContent!;
      expect(t).toContain('Audit of bench-v3 #1');
      expect(t).toContain('Evidence: 20 signals');
      expect(t).toContain('Voices: operator 15, vendor 5');
      expect(t).toContain('Top domains: wordpress.org 18%');
      expect(t).toContain('aggregator: 8 ideas, 5 reached the gate, 2 advanced, 2 cases');
      expect(t).toContain('Gate kills by check: control 3');
      expect(t).toContain('Ideas dropped by ideate: too vague 4');
      expect(t).toContain('Ideas resting on a trend, rule change or market: 50%');
      expect(t).toContain('Niche share (idea reviewer): 25%');
      expect(container.querySelector('[data-testid="audit-flags"]')!.textContent).toBe('wordpress.org supplied 18% of the evidence (limit 15%)');
      expect(t).toContain('Median similarity: 0.61');
      expect(t).toContain('my <i>idea</i>: closest idea <b>Best</b> (0.61)');
      expect(container.querySelector('[data-testid="pass-audit"] b, [data-testid="pass-audit"] i')).toBeNull();
    });

    it('says when examples exist but the pass has no stored comparison', () => {
      const v = emptyAudit();
      v.holdoutItems = 3;
      const { container } = render(<ProgressView {...base} passes={[pass({ id: 'a1' })]} audits={{ a1: v }} />);
      expect(container.querySelector('[data-testid="pass-audit"]')!.textContent).toContain('3 set. No comparison for this pass yet');
    });

    it('shows no audit section for a pass without one (an old or running pass)', () => {
      const { container } = render(<ProgressView {...base} passes={[pass({ id: 'a1' })]} />);
      expect(container.querySelector('[data-testid="pass-audit"]')).toBeNull();
    });

    it('puts a help tip on the owner likes and niche share rows', () => {
      const { container } = render(<ProgressView {...base} passes={[]} />);
      expect(container.querySelector('tr[data-metric="ownerLikes"] details.help-tip')).not.toBeNull();
      expect(container.querySelector('tr[data-metric="nicheShare"] details.help-tip')).not.toBeNull();
    });
  });
});
