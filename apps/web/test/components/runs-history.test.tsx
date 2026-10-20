import type { RunListRow } from '@bcg/core/dashboard/runs';
import { defaultRunConfig } from '@bcg/core/pipeline/types';
import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNS_NOTICES, parseRunsQuery } from '@/lib/runs-query';

vi.mock('@/actions/runs', () => ({ queueRunAction: vi.fn(async () => ({})), requeueRunAction: vi.fn(async () => {}) }));

const { RunsHistory } = await import('@/components/runs-history');

afterEach(cleanup);

const NOW = new Date('2026-10-20T15:00:00Z');
function run(o: Partial<RunListRow> = {}): RunListRow {
  return {
    id: '55555555-5555-4555-8555-555555555555', config: defaultRunConfig({ seedType: 'open', marketId: 'ca-us' }), status: 'succeeded',
    currentStage: 'case', error: null, costUsd: '2.5', startedAt: NOW, finishedAt: NOW, createdAt: NOW, caseCount: 3,
    stages: [{ stage: 'harvest', status: 'done', startedAt: NOW, finishedAt: NOW }, { stage: 'ideate', status: 'done', startedAt: NOW, finishedAt: null }],
    ...o,
  };
}

describe('RunsHistory', () => {
  it('lists runs with seed, status, stage, cost, cases, a cut error, stage details and Resume on failed runs only', () => {
    const failed = run({ id: '66666666-6666-4666-8666-666666666666', status: 'failed', currentStage: 'ideate', error: `<b>boom</b> ${'x'.repeat(300)}` });
    const { getByTestId } = render(<RunsHistory rows={[run(), failed]} total={45} page={2} pageSize={20} />);
    const rows = [...getByTestId('runs').querySelectorAll('tbody tr')];
    expect(rows[0]!.textContent).toContain('open');
    expect(rows[0]!.textContent).toContain('$2.50');
    expect(rows[0]!.querySelector('[data-label="Cases"]')?.textContent).toBe('3');
    expect(rows[0]!.querySelector('details')?.textContent).toContain('harvest');
    expect(rows[0]!.querySelector('form')).toBeNull();

    const err = rows[1]!.querySelector('[data-label="Error"]')!.textContent!;
    expect(err.length).toBeLessThanOrEqual(201);
    expect(err.startsWith('<b>boom</b>')).toBe(true);
    expect(rows[1]!.querySelector('b')).toBeNull();
    const resume = rows[1]!.querySelector('form')!;
    expect(within(resume as HTMLElement).getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(resume.querySelector('input[name="runId"]')?.getAttribute('value')).toBe(failed.id);
    expect(resume.querySelector('input[name="page"]')?.getAttribute('value')).toBe('2');

    const pager = getByTestId('runs-pager');
    expect(pager.textContent).toContain('Page 2 of 3');
    expect([...pager.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['/runs', '/runs?page=3']);
  });

  it('every requeue refusal has an allow-listed notice; anything else is dropped', () => {
    expect(Object.keys(RUNS_NOTICES).sort()).toEqual(['requeue_busy', 'requeue_not_failed', 'requeue_not_found', 'requeued']);
    expect(RUNS_NOTICES.requeue_busy).toMatch(/3 runs are already queued/);
    expect(parseRunsQuery({ notice: 'requeue_busy', page: '3' })).toEqual({ page: 3, notice: 'requeue_busy' });
    expect(parseRunsQuery({ notice: '<script>', page: '-1' })).toEqual({ page: 1 });
  });
});
