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
    const after = render(<SummaryTab view={{ ...caseViewFixture(), edge: null, scale: null, scaleEstimate: null, scaleResult: null }} />).container.innerHTML;
    expect(after).toBe(before);
    expect(before).not.toMatch(/Idea's edge|Idea's scale|Idea&#x27;s edge|paying buyers/);
  });
});

/** ideate.v13: the scale estimate's steps and the result worked out in code, shown as text. */
describe('Summary tab scale estimate', () => {
  const scaleEstimate = {
    buyerUnit: 'businesses' as const,
    population: { count: 2_000_000, basis: '<b>Census</b> count of firms', source: LIB },
    shareWithProblem: { pct: 50, basis: 'Assumption: half have it' },
    shareWillingToPay: { pct: 30, basis: 'Assumption: a survey' },
    shareReachable: { pct: 12.5, basis: 'Through accountants' },
  };
  const scaleResult = { payingBuyers: 18_750, annualPrice: 1200, revenueCeiling: 22_500_000, band: 4 as const, capped: ['shareWillingToPay'], allAssumed: false };

  it('shows each step, the paying buyers, the revenue ceiling and the caps, escaped', () => {
    const { container } = render(<SummaryTab view={{ ...caseViewFixture(), scaleEstimate, scaleResult }} />);
    const text = container.textContent ?? '';
    expect(text).toContain('Realistic paying buyers');
    expect(text).toContain('18,750 businesses would realistically pay. Revenue ceiling: $22,500,000 a year.');
    expect(text).toContain('Population: 2,000,000 businesses. <b>Census</b> count of firms');
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector(`a[href*="${LIB}"]`)).not.toBeNull();
    expect(text).toContain('With the problem: 50%. Assumption: half have it');
    expect(text).toContain('Willing to pay: 30%. Assumption: a survey');
    expect(text).toContain('Reachable in 3 years: 12.5%. Through accountants');
    expect(text).toContain('Cut to the cap because it had no source: willing to pay.');
    expect(text).not.toContain('Every step is an assumption');
  });

  it('says when the price cannot be made yearly and when every step is an assumption', () => {
    const view = {
      ...caseViewFixture(),
      scaleEstimate: { ...scaleEstimate, buyerUnit: 'individuals' as const, population: { count: 900, basis: 'Assumption: few' } },
      scaleResult: { ...scaleResult, payingBuyers: 3.4, annualPrice: null, revenueCeiling: null, band: 2 as const, capped: [], allAssumed: true },
    };
    const text = render(<SummaryTab view={view} />).container.textContent ?? '';
    expect(text).toContain('3 individuals would realistically pay. Revenue ceiling: unknown, because the price cannot be made yearly.');
    expect(text).toContain('Every step is an assumption.');
    expect(text).not.toContain('Cut to the cap');
  });

  it('says when the scale band was limited to 3 because the population has no source', () => {
    const capped = render(<SummaryTab view={{ ...caseViewFixture(), scaleEstimate, scaleResult: { ...scaleResult, band: 3 as const, bandCapped: true } }} />);
    expect(capped.container.textContent).toContain('Scale band limited to 3: the population has no source.');
    capped.unmount();
    const plain = render(<SummaryTab view={{ ...caseViewFixture(), scaleEstimate, scaleResult }} />);
    expect(plain.container.textContent).not.toContain('band limited');
  });
});
