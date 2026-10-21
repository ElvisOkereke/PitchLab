import { DEFAULT_MODELS } from '@bcg/core/config/models';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { caseViewFixture } from '../helpers/case-fixture';
import { prospectRow, validateViewFixture } from '../helpers/validate-fixture';

vi.mock('@/actions/runs', () => ({ queueRunAction: vi.fn(async () => ({})), requeueRunAction: vi.fn(async () => {}) }));
vi.mock('@/actions/scores', () => ({ saveOwnerScoresAction: vi.fn(async () => ({})) }));
vi.mock('@/actions/outreach', () => ({ markOutreachAction: vi.fn(async () => ({})) }));
vi.mock('@/actions/validation', () => ({ queueValidationAction: vi.fn(async () => ({})) }));

const { QueueRunForm } = await import('@/components/queue-run-form');
const { ScoreTab } = await import('@/components/tabs/score');
const { ValidateTab } = await import('@/components/tabs/validate');
const { CommandCenter } = await import('@/components/command-center');

afterEach(cleanup);

// A help tip is a sibling of its heading, legend or column header, never inside it, so names stay clean.
describe('help tip placement keeps accessible names clean', () => {
  it('queue form groups', () => {
    const { getByRole } = render(<QueueRunForm sectors={['HVAC']} lenses={[{ id: 'a', name: 'A' }]} />);
    expect(getByRole('group', { name: 'Seed' })).toBeTruthy();
    const legends = [...document.querySelectorAll('legend')].map((l) => l.textContent);
    expect(legends).toEqual(['Seed', 'Sectors (for “Sectors”)', 'Lenses (for “Lenses”)', 'Idea (for “Your idea”)']);
  });

  it('score, checklist, CASL and spend', () => {
    const { getByRole } = render(<ScoreTab view={caseViewFixture()} />);
    expect(getByRole('heading', { name: 'AI scores' })).toBeTruthy();
    cleanup();
    const v = render(
      <ValidateTab view={caseViewFixture()} validate={validateViewFixture({ prospects: { rows: [prospectRow()], total: 1 } })} page={1} />,
    );
    expect(v.getByRole('heading', { name: 'Checklist' })).toBeTruthy();
    expect(v.getByRole('columnheader', { name: 'CASL basis' })).toBeTruthy();
    cleanup();
    const now = new Date('2026-10-20T15:00:00Z');
    const c = render(
      <CommandCenter
        data={{
          now, needsYou: [], worker: { at: now.toISOString(), providers: { llm: true, github: false, stackexchange: false, places: false }, models: DEFAULT_MODELS },
          spend: { today: { llmUsd: 0, dataUsd: 0, llmCalls: 0 }, week: { llmUsd: 0, dataUsd: 0, llmCalls: 0 } },
          runs: { queued: 0, running: 0, succeeded: 0, failed: 0 } as never, recent: [],
        }}
      />,
    );
    expect(c.getByRole('heading', { name: 'Spend' })).toBeTruthy();
  });
});
