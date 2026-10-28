import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CompetitorsTab } from '@/components/tabs/competitors';
import { EvidenceTab } from '@/components/tabs/evidence';
import { NumbersTab } from '@/components/tabs/numbers';
import { PitchTab } from '@/components/tabs/pitch';
import { SummaryTab } from '@/components/tabs/summary';
import { caseViewFixture, claimRow, gateRow } from '../helpers/case-fixture';

afterEach(cleanup);

describe('SummaryTab', () => {
  it('summary shows "For you to check" items merged with counts, and failed gate checks first', () => {
    const view = caseViewFixture({
      claims: [
        claimRow('unreachable', { text: 'Claim A', sourceUrl: 'https://down.example/x' }),
        claimRow('unreachable', { text: 'Claim B', sourceUrl: 'https://down.example/x' }),
        claimRow('verified', { text: 'Claim C' }),
      ],
    });
    view.gate = [gateRow('generic', true, 'specific enough'), gateRow('reachability', false, 'no reachable buyer')];
    const { container, getByText } = render(<SummaryTab view={view} />);

    expect(getByText(/Daily synthetic test leads/)).toBeTruthy();
    expect(container.textContent).toContain('$8 per site per month');

    const gate = within(container.querySelector('[data-testid="gate-verdicts"]') as HTMLElement).getAllByRole('listitem');
    expect(gate.map((li) => li.textContent)).toEqual([
      expect.stringMatching(/^❌ Reachability: no reachable buyer/),
      expect.stringMatching(/^✅ Not generic: specific enough/),
    ]);

    const forYou = container.querySelector('[data-testid="for-you"]') as HTMLElement;
    const merged = within(forYou).getAllByRole('listitem').find((li) => li.textContent?.includes('Claim A'))!;
    expect(merged.textContent).toContain('page could not be loaded by the checker — open it yourself');
    expect(merged.textContent).toContain('(2 claims)');
    expect(merged.querySelector('a')?.getAttribute('href')).toBe('https://down.example/x');
    expect(forYou.textContent).not.toContain('Claim C');
  });

  it('says so when the case has no claim rows', () => {
    const { container } = render(<SummaryTab view={caseViewFixture({ claims: [] })} />);
    expect(container.querySelector('[data-testid="for-you"]')!.textContent)
      .toContain('This case has no checked sources — verify everything yourself.');
  });
});

describe('EvidenceTab', () => {
  it('evidence shows one chip per claim status (✅ ❌ ⚠️ 🔍 ⏳)', () => {
    const view = caseViewFixture({
      claims: [
        claimRow('verified'), claimRow('unsupported'), claimRow('unreachable'), claimRow('needs_review'),
        claimRow('unverified', { section: 'numbers' }),
        claimRow('verified', { section: 'signal', text: 'Our forms die after plugin updates', sourceUrl: 'https://news.example/item/1', quote: 'Our forms die after plugin updates' }),
      ],
    });
    const { container } = render(<EvidenceTab view={view} />);
    const claims = container.querySelector('[data-testid="claims"]') as HTMLElement;
    expect([...claims.querySelectorAll('.chip')].map((c) => c.textContent)).toEqual([
      '✅ verified', '❌ unsupported', '⚠️ unreachable', '🔍 needs review', '⏳ unverified',
    ]);
    const signals = within(container.querySelector('[data-testid="signals"]') as HTMLElement).getAllByRole('listitem');
    expect(signals[0]!.querySelector('.chip')?.textContent).toBe('✅ verified');
    expect(signals[0]!.textContent).toContain('voice: operator');
    // Legacy entity-encoded quotes are decoded (cleanQuote) and still shown as text; an unchecked signal says so.
    expect(signals[1]!.textContent).toContain('Leads vanish ’silently’');
    expect(signals[1]!.textContent).toContain('not checked');
  });
});

describe('NumbersTab', () => {
  it('numbers shows formulas and "assumption: …" for unsourced inputs', () => {
    const { container } = render(<NumbersTab view={caseViewFixture()} />);
    expect(container.textContent).toContain('Annual price = $8 × 40 × 12 = $3,840');
    const rows = [...container.querySelectorAll('[data-testid="inputs"] tbody tr')];
    const price = rows.find((r) => r.textContent?.startsWith('price.amount'))!;
    expect(price.textContent).toContain('assumption: Our proposed price per monitored site per month');
    const units = rows.find((r) => r.textContent?.startsWith('price.unitsPerBuyer'))!;
    expect(units.querySelector('a')?.getAttribute('href')).toBe('https://agency-benchmarks.example/2026-small-agency-report');
    expect(container.querySelector('[data-testid="scenarios"] tbody tr')).toBeTruthy();
    for (const table of container.querySelectorAll('table')) expect(table.parentElement?.classList.contains('scroll-x')).toBe(true);
  });
});

describe('CompetitorsTab', () => {
  it('shows each competitor with its product and pricing checks, then the levels', () => {
    const url = 'https://uptime-tool.example/pricing';
    const view = caseViewFixture({ claims: [claimRow('verified', { section: 'competitor', text: 'Generic uptime monitor', sourceUrl: url, quote: null })] });
    const { container } = render(<CompetitorsTab view={view} />);
    const rows = [...container.querySelectorAll('[data-testid="competitors"] tbody tr')];
    expect(rows[0]!.textContent).toContain('Generic uptime monitor');
    expect(rows[0]!.querySelector('[data-label="Product"]')?.textContent).toBe('✅ verified');
    expect(rows[0]!.querySelector('[data-label="Pricing check"]')?.textContent).toBe('not checked');
    expect(rows[0]!.querySelector('a')?.getAttribute('href')).toBe(url);
    expect(container.querySelectorAll('[data-testid="levels"] tbody tr').length).toBeGreaterThanOrEqual(2);
  });
});

describe('PitchTab', () => {
  it('shows the elevator pitch, 3 emails, 2 follow-ups, call script, objections and pricing copy as text blocks', () => {
    const view = caseViewFixture();
    const { container } = render(<PitchTab view={view} />);
    const p = view.case.sections.pitch;
    for (const e of [...p.emails, ...p.followUps]) expect(container.textContent).toContain(e.subject);
    expect(container.querySelectorAll('[data-testid="email"]')).toHaveLength(5);
    const blocks = [...container.querySelectorAll('p.pre')].map((b) => b.textContent);
    expect(blocks).toContain(p.elevator);
    expect(blocks).toContain(p.emails[0]!.body);
    expect(blocks).toContain(p.callScript);
    expect(blocks).toContain(p.pricingCopy);
    expect(container.textContent).toContain(p.objections[0]!.objection);
    expect(container.textContent).not.toMatch(/Channels|Landing copy/);
  });

  it('renders a consumer pitch without emails: channels and landing copy instead, as text', () => {
    const view = caseViewFixture();
    view.case.sections.pitch = {
      ...view.case.sections.pitch, emails: [], followUps: [],
      channels: [{ channel: 'Communities', plan: 'Answer <b>renters</b> in tenant forums' }],
      landingCopy: 'Never pay a late rent fee again.',
    };
    const { container } = render(<PitchTab view={view} />);
    const headings = [...container.querySelectorAll('h2')].map((h) => h.textContent);
    expect(headings).not.toContain('Emails');
    expect(headings).not.toContain('Follow-ups');
    expect(headings).toEqual(expect.arrayContaining(['Elevator pitch', 'Channels', 'Landing copy', 'Call script', 'Objections', 'Pricing copy']));
    expect(container.querySelectorAll('[data-testid="email"]')).toHaveLength(0);
    expect(container.textContent).toContain('Answer <b>renters</b> in tenant forums');
    expect(container.querySelector('b')).toBeNull();
    expect([...container.querySelectorAll('p.pre')].map((b) => b.textContent)).toContain('Never pay a late rent fee again.');
  });
});
