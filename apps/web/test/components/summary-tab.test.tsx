import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SummaryTab } from '@/components/tabs/summary';
import { caseViewFixture } from '../helpers/case-fixture';

afterEach(cleanup);

const LIB = '0b8f8c52-6a3e-4c55-9d0e-3f2a1b4c5d6e';

/** ideate.v12: the idea's edge and scale, shown as text on the Summary tab. */
describe('Summary tab edge and scale', () => {
  it('shows the edge (kind, claim, today\'s option, why now) and the scale as text, escaped', () => {
    const view = {
      ...caseViewFixture(),
      edge: { kind: 'new_capability' as const, claim: '<b>Reads</b> every payout line', versus: 'A bookkeeper spot-checks by hand', whyNow: 'Models got cheap in 2025' },
      scale: { buyers: 'About 40,000 property managers', basis: 'Census count of firms', source: LIB },
    };
    const { container } = render(<SummaryTab view={view} />);
    const text = container.textContent ?? '';
    expect(text).toContain("Idea's edge");
    expect(text).toContain('new capability: <b>Reads</b> every payout line');
    expect(container.querySelector('b')).toBeNull();
    expect(text).toContain("Versus today's option: A bookkeeper spot-checks by hand");
    expect(text).toContain('Why now: Models got cheap in 2025');
    expect(text).toContain("Idea's scale");
    expect(text).toContain('About 40,000 property managers');
    expect(text).toContain('Basis: Census count of firms');
    expect(container.querySelector(`a[href*="${LIB}"]`)).not.toBeNull();
  });

  it('shows a scale without a source, and either field on its own', () => {
    const view = { ...caseViewFixture(), edge: null, scale: { buyers: 'Renters', basis: 'Assumption: half of all renters' } };
    const text = render(<SummaryTab view={view} />).container.textContent ?? '';
    expect(text).not.toContain("Idea's edge");
    expect(text).toContain('Basis: Assumption: half of all renters');
    expect(text).not.toContain('Source:');
  });

  it('old cases (no edge or scale) render exactly as before', () => {
    const before = render(<SummaryTab view={caseViewFixture()} />).container.innerHTML;
    cleanup();
    const after = render(<SummaryTab view={{ ...caseViewFixture(), edge: null, scale: null }} />).container.innerHTML;
    expect(after).toBe(before);
    expect(before).not.toMatch(/Idea's edge|Idea's scale|Idea&#x27;s edge/);
  });
});
