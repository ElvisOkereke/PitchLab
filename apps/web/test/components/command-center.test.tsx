import { DEFAULT_MODELS } from '@bcg/core/config/models';
import type { RunListRow } from '@bcg/core/dashboard/runs';
import { defaultRunConfig } from '@bcg/core/pipeline/types';
import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandCenter, type CommandData } from '@/components/command-center';

afterEach(cleanup);

const NOW = new Date('2026-10-20T15:00:00Z');
const ago = (s: number) => new Date(NOW.getTime() - s * 1000);

function run(o: Partial<RunListRow> = {}): RunListRow {
  return {
    id: '55555555-5555-4555-8555-555555555555', config: defaultRunConfig({ seedType: 'sector', marketId: 'ca-us', sectors: ['HVAC', 'plumbing'] }),
    status: 'succeeded', currentStage: 'case', error: null, costUsd: '1.2345', startedAt: ago(600), finishedAt: ago(60), createdAt: ago(700),
    isExample: false, caseCount: 2, stages: [], ...o,
  };
}

function data(o: Partial<CommandData> = {}): CommandData {
  return {
    now: NOW,
    needsYou: [
      { kind: 'score', label: 'Score “Lead flow”', href: '/cases/lead-flow?tab=score', at: ago(3 * 3600) },
      { kind: 'failed_run', label: 'Run failed at ideate: boom', href: '/runs', at: ago(120) },
      { kind: 'reply', label: 'Check your inbox for Acme', href: '/cases/lead-flow?tab=validate', at: ago(4 * 86_400) },
    ],
    spend: { today: { llmUsd: 1.5, dataUsd: 0.25, llmCalls: 12 }, week: { llmUsd: 10, dataUsd: 0, llmCalls: 80 } },
    worker: { at: ago(20).toISOString(), providers: { llm: true, github: false, stackexchange: false, places: false }, models: DEFAULT_MODELS },
    runs: { queued: 2, running: 1, succeeded: 5, failed: 1 },
    recent: [run(), run({ id: '66666666-6666-4666-8666-666666666666', status: 'failed', error: 'boom' })],
    ...o,
  };
}

describe('CommandCenter', () => {
  it('needs-you items link to the right case/run and spend shows two decimals', () => {
    const { getByTestId } = render(<CommandCenter data={data()} />);
    const items = within(getByTestId('needs-you')).getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('a')?.getAttribute('href'))).toEqual(['/cases/lead-flow?tab=score', '/runs', '/cases/lead-flow?tab=validate']);
    expect(items[0]!.textContent).toContain('Score “Lead flow”');
    expect(items[0]!.textContent).toContain('3 h ago');
    expect(items[1]!.textContent).toContain('2 min ago');
    expect(items[2]!.textContent).toContain('4 d ago');

    const spend = getByTestId('spend').textContent!;
    expect(spend).toContain('LLM $1.50 (notional) · data $0.25 · 12 calls');
    expect(spend).toContain('LLM $10.00 (notional) · data $0.00 · 80 calls');
    expect(spend).toContain('No caps configured (Plan 4)');
  });

  it('worker shows "not seen" when the heartbeat is older than 60 s', () => {
    const fresh = render(<CommandCenter data={data()} />);
    expect(fresh.getByTestId('worker').textContent).toContain('last seen 20 s ago');
    expect(fresh.getByTestId('worker').textContent).toContain('2 queued · 1 running');
    cleanup();

    const stale = render(<CommandCenter data={data({ worker: { ...data().worker!, at: ago(61).toISOString() } })} />);
    expect(stale.getByTestId('worker').textContent).toContain('not seen');
    cleanup();

    const never = render(<CommandCenter data={data({ worker: null })} />);
    expect(never.getByTestId('worker').textContent).toContain('not seen');
  });

  it('lists the recent runs and an empty needs-you state', () => {
    const { getByTestId } = render(<CommandCenter data={data({ needsYou: [] })} />);
    expect(getByTestId('needs-you').textContent).toContain('Nothing needs you right now.');
    const recent = within(getByTestId('recent-runs')).getAllByRole('listitem');
    expect(recent).toHaveLength(2);
    expect(recent[0]!.textContent).toContain('sector: HVAC, plumbing');
    expect(recent[0]!.textContent).toContain('$1.23');
    expect(recent[1]!.textContent).toContain('failed');
  });

  it('never renders a needs-you href that leaves the site', () => {
    const { getByTestId } = render(<CommandCenter data={data({ needsYou: [{ kind: 'score', label: '<img src=x onerror=alert(1)>', href: '//evil.com', at: NOW }] })} />);
    const a = getByTestId('needs-you').querySelector('a')!;
    expect(a.getAttribute('href')).toBe('/');
    expect(getByTestId('needs-you').querySelector('img')).toBeNull();
  });
});
