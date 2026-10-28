import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { computeNumbers } from '@bcg/core/calc/numbers';
import { NumbersTab } from '@/components/tabs/numbers';
import { SummaryTab } from '@/components/tabs/summary';
import { caseViewFixture, sectionsFixture } from '../helpers/case-fixture';

afterEach(cleanup);

const a = (value: number) => ({ value, assumption: 'test' });

function modelView() {
  const sections = sectionsFixture();
  sections.numbers.inputs = {
    ...sections.numbers.inputs,
    businessModel: 'usage',
    revenue: { model: 'usage', unitPrice: a(2), unitsPerBuyerPerYear: a(1000) },
    valueToUserPerYear: a(5000),
  };
  sections.numbers.results = computeNumbers(sections.numbers.inputs);
  sections.summary = {
    ...sections.summary,
    audience: 'consumer', businessModel: 'usage',
    valueToUser: { kind: 'save', amountPerYear: 5000, basis: '<b>saved</b> leads' },
    barriers: { toStart: 2, toStartWhy: 'easy to start', toCopy: 4, toCopyWhy: 'hard to copy', soloBuildable: true },
  };
  return caseViewFixture({ sections });
}

describe('business-model display', () => {
  it('Numbers tab shows model, revenue formula and value multiple, as text', () => {
    const { container } = render(<NumbersTab view={modelView()} />);
    const text = container.textContent ?? '';
    expect(text).toContain('Business model');
    expect(text).toContain('usage');
    expect(text).toContain('Revenue formula');
    expect(text).toContain('$2 per unit × 1000 units = $2,000');
    expect(text).toContain('Value multiple');
    expect(text).toContain('2.5×');
  });
  it('Summary tab shows audience, business model, value to user and barriers, escaped', () => {
    const { container } = render(<SummaryTab view={modelView()} />);
    const text = container.textContent ?? '';
    expect(text).toContain('Audience');
    expect(text).toContain('consumer');
    expect(text).toContain('Business model');
    expect(text).toContain('Value to the user');
    expect(text).toContain('<b>saved</b> leads');
    expect(container.querySelector('b')).toBeNull();
    expect(text).toContain('easy to start');
    expect(text).toContain('hard to copy');
  });
  it('old cases show none of the new rows', () => {
    const n = render(<NumbersTab view={caseViewFixture()} />).container.textContent ?? '';
    expect(n).not.toMatch(/Business model|Revenue formula|Value multiple/);
    cleanup();
    const s = render(<SummaryTab view={caseViewFixture()} />).container.textContent ?? '';
    expect(s).not.toMatch(/Audience|Business model|Value to the user|Barriers/);
  });
});

describe('business-model display details', () => {
  it('hides problem-cost and savings rows when a value to the user is given, and marks price rows not used for revenue', () => {
    const { container } = render(<NumbersTab view={modelView()} />);
    const text = container.textContent ?? '';
    expect(text).not.toContain('Annual problem cost per buyer');
    expect(text).not.toContain('Annual savings per buyer');
    expect(text).toContain('Annual value to the user');
    expect(text).toContain('price.amount (not used for revenue)');
  });
  it('labels rows per user for ads and freemium, and shows the note when the multiple is n/a', () => {
    const sections = sectionsFixture();
    sections.numbers.inputs = {
      ...sections.numbers.inputs,
      businessModel: 'ads',
      revenue: { model: 'ads', impressionsPerUserPerYear: a(1000), cpm: a(5) },
      valueToUserPerYear: a(100),
    };
    sections.numbers.results = computeNumbers(sections.numbers.inputs);
    const { container } = render(<NumbersTab view={caseViewFixture({ sections })} />);
    const text = container.textContent ?? '';
    expect(text).toContain('Annual revenue per user');
    expect(text).toContain('Users');
    expect(text).toContain('Breakeven users');
    expect(text).toContain('user pays nothing (ad/affiliate funded)');
  });
  it('shows the setup fee for service plus software', () => {
    const sections = sectionsFixture();
    sections.numbers.inputs = {
      ...sections.numbers.inputs,
      revenue: { model: 'service_plus_software', subscriptionPerYear: a(1200), setupFee: a(800) },
    };
    sections.numbers.results = computeNumbers(sections.numbers.inputs);
    const text = render(<NumbersTab view={caseViewFixture({ sections })} />).container.textContent ?? '';
    expect(text).toContain('Setup fee per buyer (year 1 only)');
  });
});
