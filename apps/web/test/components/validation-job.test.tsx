import type { ValidationJobView } from '@bcg/core/dashboard/validation-jobs';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOSTILE, caseViewFixture } from '../helpers/case-fixture';
import { validateViewFixture } from '../helpers/validate-fixture';

vi.mock('@/actions/outreach', () => ({ markOutreachAction: vi.fn(async () => ({})) }));
vi.mock('@/actions/validation', () => ({ queueValidationAction: vi.fn(async () => ({})) }));

const { ValidateTab } = await import('@/components/tabs/validate');
const { ValidationJobStatus } = await import('@/components/validation-job-status');

afterEach(cleanup);

const NOW = new Date('2026-10-19T12:00:00Z');
const job = (o: Partial<ValidationJobView> = {}): ValidationJobView => ({
  id: 'j1', status: 'queued', options: { prospects: 25, skipProspects: false, refresh: false, redraft: false },
  steps: null, error: null, costUsd: 0, createdAt: NOW, startedAt: null, finishedAt: null, ...o,
});
const tab = (o: { job?: ValidationJobView | null; senderMissing?: string[]; example?: boolean; pack?: boolean } = {}) => {
  const view = caseViewFixture();
  if (o.example) view.case = { ...view.case, isExample: true };
  return render(
    <ValidateTab
      view={view}
      validate={validateViewFixture(o.pack === false ? { pack: null, checklist: null } : {})}
      page={1}
      job={o.job ?? null}
      senderMissing={o.senderMissing ?? []}
    />,
  );
};

describe('validation job panel', () => {
  it('offers "Generate validation pack" without a pack, and "Run validation again" with one', () => {
    const a = tab({ pack: false });
    expect(a.getByRole('button', { name: 'Generate validation pack' }).getAttribute('data-tour')).toBe('validate-generate');
    expect(a.container.textContent).toContain('Uses about $0.60–1.50 of model calls');
    expect(a.container.textContent).toContain('npm run worker');
    expect(a.container.textContent).toContain('output/validation/lead-flow-verification/');
    expect(a.container.textContent).not.toContain('npm run gen -- validate');
    cleanup();
    const b = tab();
    expect(b.getByRole('button', { name: 'Run validation again' })).toBeTruthy();
  });

  it('replaces the form on the example', () => {
    const { container, queryByRole } = tab({ example: true });
    expect(container.textContent).toContain('Example data: already generated.');
    expect(queryByRole('button', { name: /validation/i })).toBeNull();
  });

  it('replaces the form with a settings link when the sender is missing', () => {
    const { container, queryByRole, getByRole } = tab({ senderMissing: ['sender.name'] });
    expect(container.textContent).toContain('Set your name, mailing address and contact in Settings first. Every email must include them.');
    expect(getByRole('link', { name: /settings/i }).getAttribute('href')).toBe('/settings');
    expect(queryByRole('button', { name: /validation/i })).toBeNull();
  });

  it('shows no status block without a job', () => {
    expect(tab().container.querySelector('[data-tour="validate-status"]')).toBeNull();
  });

  it('queued, running (with stale hint), succeeded and failed renderings', () => {
    const q = render(<ValidationJobStatus job={job()} now={NOW} />);
    expect(q.container.textContent).toContain('Waiting for the worker');
    expect(q.container.querySelector('[data-tour="validate-status"]')).toBeTruthy();
    cleanup();

    const fresh = render(<ValidationJobStatus job={job({ status: 'running', startedAt: new Date(NOW.getTime() - 60_000) })} now={NOW} />);
    expect(fresh.container.textContent).toContain('Running since');
    expect(fresh.container.textContent).not.toContain('start it again');
    cleanup();

    const stale = render(<ValidationJobStatus job={job({ status: 'running', startedAt: new Date(NOW.getTime() - 3 * 3_600_000) })} now={NOW} />);
    expect(stale.container.textContent).toContain('If the worker stopped, start it again and press the validation button above again');
    cleanup();

    const ok = render(
      <ValidationJobStatus
        job={job({ status: 'succeeded', costUsd: 0.87, steps: [{ step: 'pack', status: 'ok', detail: 'written' }, { step: 'prospects', status: 'skipped', detail: 'no search' }] })}
        now={NOW}
      />,
    );
    expect(ok.container.textContent).toContain('pack · ok · written');
    expect(ok.container.textContent).toContain('prospects · skipped · no search');
    expect(ok.container.textContent).toContain('$0.87');
    cleanup();

    const bad = render(<ValidationJobStatus job={job({ status: 'failed', error: 'search exploded' })} now={NOW} />);
    expect(bad.container.textContent).toContain('search exploded');
  });

  it('renders a hostile error as text', () => {
    const { container } = render(<ValidationJobStatus job={job({ status: 'failed', error: `<img src=x onerror=alert(1)>${HOSTILE}` })} now={NOW} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
