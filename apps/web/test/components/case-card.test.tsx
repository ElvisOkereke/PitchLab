import type { BoardCard } from '@bcg/core/dashboard/board';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/actions/stage', () => ({
  moveStageAction: vi.fn(async () => ({})),
  overturnKillAction: vi.fn(async () => {}),
  rerunGateKillAction: vi.fn(async () => {}),
}));

const { CaseCard } = await import('@/components/case-card');

const card: BoardCard = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'dental-recall-monitor',
  isExample: false,
  title: 'Dental recall monitor',
  stage: 'new',
  aiScore: 3.4,
  ownerScore: null,
  metric: 'ROI 1.07×',
  updatedAt: new Date('2026-10-19T12:00:00Z'),
};

afterEach(cleanup);

describe('CaseCard', () => {
  it('renders scores, metric and a move form with the other four stages', () => {
    const { container } = render(<CaseCard card={card} />);
    const link = screen.getByRole('link', { name: 'Dental recall monitor' });
    expect(link.getAttribute('href')).toBe('/cases/dental-recall-monitor');
    expect(screen.getByText('3.4')).toBeTruthy();
    expect(screen.getByText('–')).toBeTruthy();
    expect(screen.getByText('ROI 1.07×')).toBeTruthy();

    const formEl = screen.getByTestId('move-stage');
    const options = [...within(formEl).getByRole('combobox').querySelectorAll('option')].map((o) => o.getAttribute('value'));
    expect(options).toEqual(['validating', 'pilot', 'live', 'killed']);
    const hidden = Object.fromEntries([...formEl.querySelectorAll('input[type="hidden"]')].map((i) => [i.getAttribute('name'), i.getAttribute('value')]));
    expect(hidden).toMatchObject({ caseId: card.id, from: 'new', slug: card.slug });
    expect(within(formEl).getByRole('textbox').getAttribute('maxlength')).toBe('500');
    expect(container.querySelector('[data-testid="overturn-kill"]')).toBeNull();
  });

  it('shows the owner score and an Overturn kill button on a killed card', () => {
    render(<CaseCard card={{ ...card, stage: 'killed', ownerScore: 4.5, aiScore: null }} />);
    expect(screen.getByText('4.5')).toBeTruthy();
    expect(screen.getByText('–')).toBeTruthy();
    const options = [...screen.getByRole('combobox').querySelectorAll('option')].map((o) => o.getAttribute('value'));
    expect(options).toEqual(['new', 'validating', 'pilot', 'live']);
    const overturn = screen.getByTestId('overturn-kill');
    expect(within(overturn).getByRole('button', { name: 'Overturn kill' })).toBeTruthy();
    expect(overturn.querySelector('input[name="caseId"]')?.getAttribute('value')).toBe(card.id);
  });

  it('renders hostile titles and metrics as text', () => {
    const evil = '<img src=x onerror=alert(1)><script>alert(1)</script>';
    const { container } = render(<CaseCard card={{ ...card, title: evil, metric: evil }} />);
    expect(container.querySelector('img, script')).toBeNull();
    expect(container.textContent).toContain(evil);
  });

  it('shows the Example badge only on the example', () => {
    const { rerender } = render(<CaseCard card={card} />);
    expect(screen.queryByText('Example')).toBeNull();
    rerender(<CaseCard card={{ ...card, isExample: true }} />);
    expect(screen.getByText('Example').getAttribute('title')).toBe('Built-in example with made-up data');
  });
});
