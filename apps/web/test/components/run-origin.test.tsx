import type { BoardCard } from '@bcg/core/dashboard/board';
import type { RunListRow } from '@bcg/core/dashboard/runs';
import { defaultRunConfig } from '@bcg/core/pipeline/types';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { caseViewFixture } from '../helpers/case-fixture';
import { parseRunsQuery, runLinkHref } from '@/lib/runs-query';

vi.mock('@/actions/stage', () => ({
  moveStageAction: vi.fn(async () => ({})),
  overturnKillAction: vi.fn(async () => {}),
  rerunGateKillAction: vi.fn(async () => {}),
}));
vi.mock('@/actions/runs', () => ({ requeueRunAction: vi.fn(async () => {}) }));
vi.mock('@/actions/ideas', () => ({ rateIdeaAction: vi.fn(async () => ({})) }));

const { CaseHeader } = await import('@/components/case-header');
const { CaseCard } = await import('@/components/case-card');
const { RunsHistory } = await import('@/components/runs-history');

afterEach(cleanup);

const RUN_ID = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-10-20T15:00:00Z');
const origin = (o: Partial<NonNullable<BoardCard['origin']>> = {}) => ({
  runId: RUN_ID, createdAt: NOW, seed: { seedType: 'sector' as const, sectors: ['HVAC'] }, passLabel: 'bench-v3 #1', ...o,
});

describe('run links', () => {
  it('runLinkHref points at the run, and parseRunsQuery accepts only a uuid run', () => {
    expect(runLinkHref(RUN_ID)).toBe(`/runs?run=${RUN_ID}#run-${RUN_ID}`);
    expect(parseRunsQuery({ run: RUN_ID })).toEqual({ page: 1, run: RUN_ID });
    expect(parseRunsQuery({ run: '<script>' })).toEqual({ page: 1 });
  });

  it('the case header says which run and pass the case came from, as a link', () => {
    const view = caseViewFixture();
    view.origin = origin();
    const { container } = render(<CaseHeader view={view} tab="summary" />);
    const from = container.querySelector('[data-testid="case-origin"]')!;
    expect(from.textContent).toContain('From:');
    expect(from.textContent).toContain('sector: HVAC');
    expect(from.textContent).toContain('bench-v3 #1');
    expect(from.querySelector('a')!.getAttribute('href')).toBe(runLinkHref(RUN_ID));
  });

  it('shows nothing when the case has no origin, and renders hostile text as text', () => {
    expect(render(<CaseHeader view={caseViewFixture()} tab="summary" />).container.querySelector('[data-testid="case-origin"]')).toBeNull();
    cleanup();
    const view = caseViewFixture();
    view.origin = origin({ passLabel: '<img src=x onerror=alert(1)>' });
    const { container } = render(<CaseHeader view={view} tab="summary" />);
    expect(container.querySelector('[data-testid="case-origin"] img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('a board card links to its run', () => {
    const card: BoardCard = {
      id: '11111111-1111-4111-8111-111111111111', slug: 's', isExample: false, title: 'T', stage: 'new', aiScore: null, ownerScore: null,
      metric: 'ROI n/a', updatedAt: NOW, origin: origin(),
    };
    const { container } = render(<CaseCard card={card} />);
    const from = container.querySelector('[data-testid="case-origin"]')!;
    expect(from.textContent).toContain('bench-v3 #1');
    expect(from.querySelector('a')!.getAttribute('href')).toBe(runLinkHref(RUN_ID));
  });
});

describe('RunsHistory case and idea links', () => {
  const idea = (o: Partial<RunListRow['ideas'][number]>): RunListRow['ideas'][number] => ({
    id: crypto.randomUUID(), origin: 'generated', title: 'An idea', oneLiner: 'x', status: 'candidate', ownerRating: null, ownerTags: null, caseSlug: null, ...o,
  });
  const row = (o: Partial<RunListRow> = {}): RunListRow => ({
    id: RUN_ID, config: defaultRunConfig({ seedType: 'open', marketId: 'ca-us' }), status: 'succeeded', currentStage: 'case', error: null,
    costUsd: '1', startedAt: NOW, finishedAt: NOW, createdAt: NOW, isExample: false, benchmarkPassId: null, caseCount: 0, stages: [], ideas: [],
    passLabel: null, cases: [], ...o,
  });

  it('adds the pass label to the seed, an anchor to the row, and case title links', () => {
    const { container } = render(<RunsHistory rows={[row({
      passLabel: 'bench-v3 #1', caseCount: 1, cases: [{ id: 'c1', slug: 'dental-recall', title: 'Dental <b>recall</b>' }],
    })]} total={1} page={1} pageSize={20} />);
    const tr = container.querySelector('tbody tr')!;
    expect(tr.id).toBe(`run-${RUN_ID}`);
    expect(tr.querySelector('[data-label="Seed"]')!.textContent).toBe('open · bench-v3 #1');
    const a = tr.querySelector('[data-label="Cases"] a')!;
    expect(a.getAttribute('href')).toBe('/cases/dental-recall');
    expect(a.textContent).toBe('Dental <b>recall</b>');
    expect(tr.querySelector('[data-label="Cases"] b')).toBeNull();
  });

  it('shows none when there are no cases, and no pass suffix on plain runs', () => {
    const { container } = render(<RunsHistory rows={[row()]} total={1} page={1} pageSize={20} />);
    expect(container.querySelector('[data-label="Cases"]')!.textContent).toBe('none');
    expect(container.querySelector('[data-label="Seed"]')!.textContent).toBe('open');
  });

  it('tags each idea with its outcome', () => {
    const ideas = [
      idea({ title: 'A', status: 'advanced', caseSlug: 'a-case' }),
      idea({ title: 'B', status: 'gated_out' }),
      idea({ title: 'C', status: 'screened_out' }),
      idea({ title: 'D', status: 'duplicate' }),
      idea({ title: 'E', status: 'candidate' }),
    ];
    const { container } = render(<RunsHistory rows={[row({ ideas })]} total={1} page={1} pageSize={20} />);
    const tags = [...container.querySelectorAll('[data-label="Ideas"] li')].map((li) => li.querySelector('[data-testid="idea-outcome"]')!.textContent);
    expect(tags).toEqual(['case', 'gate killed', 'not shortlisted', 'duplicate', 'candidate']);
    const link = container.querySelector('[data-label="Ideas"] li [data-testid="idea-outcome"] a')!;
    expect(link.getAttribute('href')).toBe('/cases/a-case');
  });
});
