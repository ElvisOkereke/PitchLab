import { OWNER_IDEA_TAGS } from '@bcg/core/audit/owner-tags';
import type { RunListRow } from '@bcg/core/dashboard/runs';
import { defaultRunConfig } from '@bcg/core/pipeline/types';
import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GLOSSARY } from '@/lib/glossary';

vi.mock('@/actions/runs', () => ({ requeueRunAction: vi.fn(async () => {}) }));
vi.mock('@/actions/ideas', () => ({ rateIdeaAction: vi.fn(async () => ({})) }));

const { RunsHistory } = await import('@/components/runs-history');

afterEach(cleanup);

const NOW = new Date('2026-10-20T15:00:00Z');
const idea = (o: Partial<RunListRow['ideas'][number]> = {}): RunListRow['ideas'][number] => ({
  id: '11111111-1111-4111-8111-111111111111', origin: 'generated', title: 'Dispatch bot', oneLiner: 'Routes jobs', status: 'advanced',
  ownerRating: null, ownerTags: null, ...o,
});
function run(ideas: RunListRow['ideas']): RunListRow {
  return {
    id: '55555555-5555-4555-8555-555555555555', config: defaultRunConfig({ seedType: 'open', marketId: 'ca-us' }), status: 'succeeded',
    currentStage: 'case', error: null, costUsd: '2.5', startedAt: NOW, finishedAt: NOW, createdAt: NOW, isExample: false, benchmarkPassId: null, caseCount: 1,
    stages: [], ideas,
  };
}

describe('idea rating controls', () => {
  it('generated ideas get thumbs, clear and every tag chip as plain form buttons; owner ideas get none', () => {
    const owner = idea({ id: '22222222-2222-4222-8222-222222222222', origin: 'owner', title: 'My own idea' });
    const { getAllByTestId, getByText } = render(<RunsHistory rows={[run([idea(), owner])]} total={1} page={1} pageSize={20} />);
    const forms = getAllByTestId('rate-idea');
    expect(forms).toHaveLength(1);
    const f = forms[0]!;
    expect(f.querySelector('input[name="ideaId"]')?.getAttribute('value')).toBe('11111111-1111-4111-8111-111111111111');
    for (const name of ['Thumbs up', 'Thumbs down', 'Clear rating']) expect(within(f).getByRole('button', { name })).toBeTruthy();
    for (const t of OWNER_IDEA_TAGS) expect(within(f).getByRole('button', { name: t })).toBeTruthy();
    expect(f.querySelectorAll('button[type="submit"]').length).toBe(3 + OWNER_IDEA_TAGS.length);
    expect(getByText('My own idea')).toBeTruthy();
  });

  it('shows the current rating and tags as pressed buttons and carries them in hidden fields', () => {
    const rated = idea({ ownerRating: 1, ownerTags: ['love it', 'boring'] });
    const { getByTestId } = render(<RunsHistory rows={[run([rated])]} total={1} page={1} pageSize={20} />);
    const f = getByTestId('rate-idea');
    expect(within(f).getByRole('button', { name: 'Thumbs up' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(f).getByRole('button', { name: 'Thumbs down' }).getAttribute('aria-pressed')).toBe('false');
    expect(within(f).getByRole('button', { name: 'love it' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(f).getByRole('button', { name: 'too niche' }).getAttribute('aria-pressed')).toBe('false');
    expect(f.querySelector('input[name="rating"]')?.getAttribute('value')).toBe('1');
    expect([...f.querySelectorAll('input[name="tags"]')].map((i) => i.getAttribute('value'))).toEqual(['love it', 'boring']);
  });

  it('has the help tip text from the owner', () => {
    expect(GLOSSARY.rateIdeas.text).toBe(
      'Rate ideas so PitchLab can tell whether changes make them better. Your ratings are never shown to the idea generator.',
    );
    const { container } = render(<RunsHistory rows={[run([idea()])]} total={1} page={1} pageSize={20} />);
    expect(container.querySelector('.help-tip')).toBeTruthy();
  });
});
