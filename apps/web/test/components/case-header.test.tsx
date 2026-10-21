import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { caseViewFixture } from '../helpers/case-fixture';

vi.mock('@/actions/stage', () => ({
  moveStageAction: vi.fn(async () => ({})),
  overturnKillAction: vi.fn(async () => {}),
  rerunGateKillAction: vi.fn(async () => {}),
}));

const { CaseHeader } = await import('@/components/case-header');

afterEach(cleanup);

describe('CaseHeader', () => {
  it('tabs are links with aria-current on the open tab (no JS needed)', () => {
    const { getByRole } = render(<CaseHeader view={caseViewFixture()} tab="numbers" />);
    const nav = getByRole('navigation', { name: 'Case sections' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Summary', '/cases/lead-flow-verification'],
      ['Evidence', '/cases/lead-flow-verification?tab=evidence'],
      ['Numbers', '/cases/lead-flow-verification?tab=numbers'],
      ['Competitors', '/cases/lead-flow-verification?tab=competitors'],
      ['Pitch', '/cases/lead-flow-verification?tab=pitch'],
      ['Validate', '/cases/lead-flow-verification?tab=validate'],
      ['Score', '/cases/lead-flow-verification?tab=score'],
    ]);
    expect(links.filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.textContent)).toEqual(['Numbers']);
  });

  it('shows the stage, an export link and a move form that returns to this case tab', () => {
    const { container, getByRole } = render(<CaseHeader view={caseViewFixture()} tab="numbers" />);
    expect(container.querySelector('.stage-chip')?.textContent).toBe('New');
    expect(getByRole('link', { name: 'Export Markdown' }).getAttribute('href')).toBe('/cases/lead-flow-verification/export.md');
    const form = container.querySelector('[data-testid="move-stage"]')!;
    expect(form.querySelector('input[name="returnTo"]')?.getAttribute('value')).toBe('/cases/lead-flow-verification?tab=numbers');
    expect(container.querySelector('[data-testid="overturn-kill"]')).toBeNull();
    expect(container.textContent).not.toContain('Gate flags');
  });

  it('a killed case shows its kill reason and an Overturn kill button that returns here', () => {
    const view = caseViewFixture({ stage: 'killed', killReason: 'too crowded' });
    view.case.sections.summary.gateFlags = ['evidence', 'generic', 'something-new'];
    const { container } = render(<CaseHeader view={view} tab="summary" notice="overturn_refused" />);
    expect(container.textContent).toContain('Kill reason: too crowded');
    // Readable check labels; an unknown flag shows as stored.
    expect(container.textContent).toContain('⚠️ Gate flags: Evidence, Not generic, something-new');
    const overturn = container.querySelector('[data-testid="overturn-kill"]')!;
    expect(overturn.querySelector('input[name="returnTo"]')?.getAttribute('value')).toBe('/cases/lead-flow-verification');
    expect(container.querySelector('[role="status"]')?.textContent).toBe('That case is no longer killed, so there was nothing to overturn.');
  });

  it('tolerates legacy sections without gate flags', () => {
    const view = caseViewFixture();
    (view.case.sections.summary as { gateFlags?: string[] }).gateFlags = undefined;
    const { container } = render(<CaseHeader view={view} tab="summary" />);
    expect(container.querySelector('h1')?.textContent).toBe(view.case.title);
  });

  it('shows the Example badge and note only on the example', () => {
    const view = caseViewFixture();
    const { queryByText, getByText, rerender } = render(<CaseHeader view={view} tab="summary" />);
    expect(queryByText('Example')).toBeNull();
    expect(queryByText(/built-in example with made-up businesses/)).toBeNull();
    rerender(<CaseHeader view={{ ...view, case: { ...view.case, isExample: true } }} tab="summary" />);
    expect(getByText('Example')).toBeTruthy();
    expect(getByText('This is a built-in example with made-up businesses. Practise freely; Settings can reset or hide it.')).toBeTruthy();
  });
});
