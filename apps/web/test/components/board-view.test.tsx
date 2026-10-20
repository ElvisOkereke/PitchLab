import type { BoardCard, GateKill } from '@bcg/core/dashboard/board';
import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/actions/stage', () => ({
  moveStageAction: vi.fn(async () => ({})),
  overturnKillAction: vi.fn(async () => {}),
  rerunGateKillAction: vi.fn(async () => {}),
}));

const { BoardView } = await import('@/components/board-view');

const card = (i: number, stage: BoardCard['stage']): BoardCard => ({
  id: `11111111-1111-4111-8111-11111111111${i}`, slug: `case-${i}`, title: `Case ${i}`, stage,
  aiScore: 3, ownerScore: null, metric: 'ROI n/a', updatedAt: new Date(),
});

const board = {
  columns: { new: [], validating: [card(1, 'validating'), card(2, 'validating')], pilot: [], live: [], killed: [card(3, 'killed')] },
  counts: { new: 0, validating: 2, pilot: 0, live: 0, killed: 1 },
};
const kills: GateKill[] = [{
  ideaId: '22222222-2222-4222-8222-222222222222', title: '<b>bad</b> idea', oneLiner: 'x', createdAt: new Date(),
  failed: [{ check: 'reachability', reasoning: 'no reachable buyer <script>alert(1)</script>' }],
}];

afterEach(cleanup);

describe('BoardView', () => {
  it('renders five columns with data-stage/data-count and selects the first non-empty stage', () => {
    const { container } = render(<BoardView board={board} gateKills={kills} lenses={[]} query={{}} />);
    const cols = [...container.querySelectorAll('[data-stage]')];
    expect(cols.map((c) => [c.getAttribute('data-stage'), c.getAttribute('data-count')])).toEqual([
      ['new', '0'], ['validating', '2'], ['pilot', '0'], ['live', '0'], ['killed', '1'],
    ]);
    expect(container.querySelector('[data-selected="true"]')?.getAttribute('data-stage')).toBe('validating');
    const current = container.querySelector('.board-switcher [aria-current="page"]');
    expect(current?.textContent).toContain('Validating');
  });

  it('keeps filters in the stage switcher links and honours ?stage=', () => {
    const { container } = render(<BoardView board={board} gateKills={[]} lenses={[{ id: 'aggregator', name: 'Sell to the aggregator' }]} query={{ stage: 'live', lens: 'aggregator', minAi: 3 }} />);
    expect(container.querySelector('[data-selected="true"]')?.getAttribute('data-stage')).toBe('live');
    const hrefs = [...container.querySelectorAll('.board-switcher a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/?stage=killed&lens=aggregator&minAi=3');
  });

  it('lists gate kills under Killed with reasons and a re-run button, as inert text', () => {
    const { container } = render(<BoardView board={board} gateKills={kills} lenses={[]} query={{ notice: 'rerun_busy' }} />);
    const killed = container.querySelector('[data-stage="killed"]') as HTMLElement;
    const details = within(killed).getByTestId('gate-kills');
    expect(details.querySelector('summary')?.textContent).toBe('Gate kills (1)');
    expect(details.textContent).toContain('Reachability');
    expect(details.textContent).toContain('no reachable buyer <script>alert(1)</script>');
    expect(within(details).getByRole('button', { name: 'Re-run as owner idea' })).toBeTruthy();
    expect(details.querySelector('input[name="ideaId"]')?.getAttribute('value')).toBe(kills[0]!.ideaId);
    expect(container.querySelector('script, b')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('3 runs are already queued');
  });
});
