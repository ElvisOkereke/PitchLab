// Review Focus 4: every case tab renders hostile case/LLM/web text as inert text nodes.
import type { CaseView } from '@bcg/core/dashboard/case-view';
import { cleanup, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOSTILE, hostileCaseView } from '../helpers/case-fixture';

vi.mock('@/actions/stage', () => ({
  moveStageAction: vi.fn(async () => ({})),
  overturnKillAction: vi.fn(async () => {}),
  rerunGateKillAction: vi.fn(async () => {}),
}));
vi.mock('@/actions/scores', () => ({ saveOwnerScoresAction: vi.fn(async () => ({})) }));

const { SummaryTab } = await import('@/components/tabs/summary');
const { EvidenceTab } = await import('@/components/tabs/evidence');
const { NumbersTab } = await import('@/components/tabs/numbers');
const { CompetitorsTab } = await import('@/components/tabs/competitors');
const { PitchTab } = await import('@/components/tabs/pitch');
const { ScoreTab } = await import('@/components/tabs/score');
const { CaseHeader } = await import('@/components/case-header');

const TABS: Record<string, (p: { view: CaseView }) => ReactElement> = {
  summary: SummaryTab, evidence: EvidenceTab, numbers: NumbersTab, competitors: CompetitorsTab, pitch: PitchTab, score: ScoreTab,
};

function Tab({ name, view }: { name: string; view: CaseView }) {
  const C = TABS[name]!;
  return <C view={view} />;
}

function expectInert(container: HTMLElement) {
  expect(container.querySelector('img, script, iframe, style, object, embed')).toBeNull();
  const anchors = [...container.querySelectorAll('a')];
  expect(anchors.every((a) => /^(https?:|\/)/.test(a.getAttribute('href')!))).toBe(true);
  for (const a of anchors.filter((x) => x.getAttribute('target') === '_blank')) expect(a.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  for (const el of container.querySelectorAll('*')) {
    for (const attr of el.getAttributeNames()) expect(attr.startsWith('on'), `${el.tagName} has ${attr}`).toBe(false);
  }
}

afterEach(cleanup);

describe('hostile case text', () => {
  it.each(['summary', 'evidence', 'numbers', 'competitors', 'pitch', 'score'])('%s tab renders hostile text inertly', (tab) => {
    const { container } = render(<Tab name={tab} view={hostileCaseView()} />);
    expectInert(container);
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('hostile owner score notes stay inside the textarea value, never markup', () => {
    const { container } = render(<ScoreTab view={hostileCaseView()} />);
    expect((container.querySelector('textarea[name="note_gut"]') as HTMLTextAreaElement).value).toBe(HOSTILE);
    expect(container.querySelector('img, script')).toBeNull();
  });

  it('a javascript: or data: URL is shown as text; the one https URL is a link with its payload encoded', () => {
    const { container } = render(<CompetitorsTab view={hostileCaseView()} />);
    expect(container.textContent).toContain('javascript:alert(1)');
    const a = container.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://evil.example/%22onmouseover=alert(1)');
    expect(a.getAttribute('onmouseover')).toBeNull();
  });

  it('the case header (title, lens, kill reason, gate flags) renders hostile text inertly', () => {
    const { container } = render(<CaseHeader view={hostileCaseView()} tab="summary" />);
    expectInert(container);
    expect(container.querySelector('h1')!.textContent).toBe(HOSTILE);
    expect(container.textContent).toContain(`⚠️ Gate flags: ${HOSTILE}`);
    expect(container.textContent).toContain(`Kill reason: ${HOSTILE}`);
  });
});
