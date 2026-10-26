import type { PassRow } from '@bcg/core/bench/passes';
import type { MetricResult, Scorecard } from '@bcg/core/bench/scorecard';
import { METRIC_DEFS } from '@bcg/core/bench/definitions';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/actions/bench', () => ({ runBenchmarkAction: vi.fn(async () => ({})) }));
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
const base = { costNote: COST, running: null, scoreCases: null };

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

  it('renders hostile labels and titles as text', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const { container } = render(
      <ProgressView {...base} passes={[pass({ label: evil })]} scoreCases={{ label: evil, cases: [{ slug: 's', title: evil, gut: null }] }} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain(evil);
  });
});
