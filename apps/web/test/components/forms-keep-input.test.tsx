// D2-R6 items 1–2: React 19 resets a form after a function action, and a <select> ignores a changed defaultValue.
// Every useActionState form must show what was saved after a success and keep the owner's input after an error.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FormState } from '@/lib/form';

const act = vi.hoisted(() => ({ result: {} as FormState, calls: [] as FormData[] }));
const record = async (_prev: FormState, fd: FormData) => {
  act.calls.push(fd);
  // A real Server Action response is a new object every time.
  return structuredClone(act.result);
};

vi.mock('@/actions/scores', () => ({ saveOwnerScoresAction: vi.fn(record) }));
vi.mock('@/actions/runs', () => ({ queueRunAction: vi.fn(record), requeueRunAction: vi.fn(async () => {}) }));
vi.mock('@/actions/settings', () => ({ saveSettingsAction: vi.fn(record) }));
vi.mock('@/actions/outreach', () => ({ markOutreachAction: vi.fn(record) }));
vi.mock('@/actions/stage', () => ({ moveStageAction: vi.fn(record), overturnKillAction: vi.fn(async () => {}), rerunGateKillAction: vi.fn(async () => {}) }));

const { ScoreForm } = await import('@/components/score-form');
const { QueueRunForm } = await import('@/components/queue-run-form');
const { SettingsForm } = await import('@/components/settings-form');
const { MarkOutreachForm } = await import('@/components/mark-outreach-form');
const { StageMoveForm } = await import('@/components/stage-move-form');

const CRITERIA = ['pain', 'roi', 'evidence', 'speed', 'autonomy', 'novelty', 'reach', 'gut'];
const scoreRows = CRITERIA.map((c) => ({ criterion: c, label: c === 'gut' ? 'Your gut' : c, value: c === 'pain' ? 3 : null, note: c === 'pain' ? 'old note' : '' }));
const CASE_ID = '33333333-3333-4333-8333-333333333333';

const el = <T extends Element>(sel: string) => document.querySelector(sel) as unknown as T;
const lastCall = () => act.calls.at(-1)!;

beforeEach(() => {
  act.calls = [];
  act.result = {};
});
afterEach(cleanup);

describe('ScoreForm', () => {
  it('after a save the selects show what was saved, and the next save sends it again', async () => {
    const user = userEvent.setup();
    act.result = { ok: true };
    render(<ScoreForm caseId={CASE_ID} slug="c" rows={scoreRows} />);

    await user.selectOptions(el('select[name="value_gut"]'), '4');
    await user.click(screen.getByRole('button', { name: 'Save my scores' }));
    await screen.findByText('Saved.');
    expect(lastCall().get('value_gut')).toBe('4');
    expect(el<HTMLSelectElement>('select[name="value_gut"]').value).toBe('4');
    expect(el<HTMLSelectElement>('select[name="value_pain"]').value).toBe('3');

    await user.clear(el('textarea[name="note_pain"]'));
    await user.type(el('textarea[name="note_pain"]'), 'new note');
    await user.click(screen.getByRole('button', { name: 'Save my scores' }));
    await waitFor(() => expect(act.calls).toHaveLength(2));
    expect(lastCall().get('value_gut')).toBe('4');
    expect(lastCall().get('value_pain')).toBe('3');
    expect(lastCall().get('note_pain')).toBe('new note');
  });

  it('on a validation error the chosen scores and typed notes are still there', async () => {
    const user = userEvent.setup();
    act.result = { error: 'Scores are whole numbers from 1 to 5.' };
    render(<ScoreForm caseId={CASE_ID} slug="c" rows={scoreRows} />);
    await user.selectOptions(el('select[name="value_roi"]'), '2');
    await user.type(el('textarea[name="note_roi"]'), 'clear ROI');
    await user.type(el('textarea[name="note_gut"]'), 'gut note without score');
    await user.click(screen.getByRole('button', { name: 'Save my scores' }));
    await screen.findByRole('alert');
    expect(el<HTMLSelectElement>('select[name="value_roi"]').value).toBe('2');
    expect(el<HTMLTextAreaElement>('textarea[name="note_roi"]').value).toBe('clear ROI');
    expect(el<HTMLTextAreaElement>('textarea[name="note_gut"]').value).toBe('gut note without score');
    expect(el<HTMLTextAreaElement>('textarea[name="note_pain"]').value).toBe('old note');
  });

  it('shows the values the action returns (as saved, e.g. trimmed)', async () => {
    const user = userEvent.setup();
    act.result = { ok: true, values: { value_gut: '5', note_gut: 'trimmed' } };
    render(<ScoreForm caseId={CASE_ID} slug="c" rows={scoreRows} />);
    await user.selectOptions(el('select[name="value_gut"]'), '5');
    await user.type(el('textarea[name="note_gut"]'), '  trimmed  ');
    await user.click(screen.getByRole('button', { name: 'Save my scores' }));
    await screen.findByText('Saved.');
    expect(el<HTMLTextAreaElement>('textarea[name="note_gut"]').value).toBe('trimmed');
    expect(el<HTMLSelectElement>('select[name="value_gut"]').value).toBe('5');
  });
});

describe('QueueRunForm', () => {
  it('a refused run keeps the seed, the idea text, the ticks and the counts', async () => {
    const user = userEvent.setup();
    act.result = { error: '3 runs are already queued. Wait for the worker.' };
    render(<QueueRunForm sectors={['HVAC', 'plumbing']} lenses={[{ id: 'aggregator', name: 'Sell to the aggregator' }]} />);
    await user.click(screen.getByLabelText('Your idea'));
    const idea = 'A long idea about lead-flow checks for agencies. '.repeat(40);
    await user.click(el('textarea[name="ideaText"]'));
    await user.paste(idea);
    await user.clear(el('input[name="ideaCount"]'));
    await user.type(el('input[name="ideaCount"]'), '7');
    await user.click(screen.getByRole('button', { name: 'Queue run' }));
    await screen.findByRole('alert');
    expect(lastCall().get('ideaText')).toBe(idea);
    expect(el<HTMLTextAreaElement>('textarea[name="ideaText"]').value).toBe(idea);
    expect(el<HTMLInputElement>('input[name="ideaCount"]').value).toBe('7');
    expect(el<HTMLInputElement>('input[name="seedType"][value="idea"]').checked).toBe(true);

    await user.click(screen.getByLabelText('Sectors'));
    await user.click(screen.getByLabelText('plumbing'));
    await user.click(screen.getByRole('button', { name: 'Queue run' }));
    await waitFor(() => expect(act.calls).toHaveLength(2));
    expect(el<HTMLInputElement>('input[name="sectors"][value="plumbing"]').checked).toBe(true);
    expect(el<HTMLInputElement>('input[name="sectors"][value="HVAC"]').checked).toBe(false);
  });
});

describe('SettingsForm', () => {
  it('a refused save keeps every typed value', async () => {
    const user = userEvent.setup();
    act.result = { error: 'Form endpoint: The form endpoint must be an https URL (or empty).' };
    render(<SettingsForm fields={[{ key: 'sender.name', label: 'Your name', value: 'Al' }, { key: 'landing.formEndpoint', label: 'Form endpoint', value: '' }]} />);
    await user.type(el('input[name="sender.name"]'), ' Owner');
    await user.type(el('input[name="landing.formEndpoint"]'), 'http://forms.example');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByRole('alert');
    expect(el<HTMLInputElement>('input[name="sender.name"]').value).toBe('Al Owner');
    expect(el<HTMLInputElement>('input[name="landing.formEndpoint"]').value).toBe('http://forms.example');
  });

  it('after a save the form shows what was saved', async () => {
    const user = userEvent.setup();
    act.result = { ok: true, values: { 'sender.name': 'Al Owner' } };
    render(<SettingsForm fields={[{ key: 'sender.name', label: 'Your name', value: 'Al' }]} />);
    await user.type(el('input[name="sender.name"]'), ' Owner  ');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText('Saved.');
    expect(el<HTMLInputElement>('input[name="sender.name"]').value).toBe('Al Owner');
  });
});

describe('MarkOutreachForm and StageMoveForm', () => {
  it('the outreach note survives an error and clears after a success', async () => {
    const user = userEvent.setup();
    act.result = { error: 'This prospect no longer exists. Refresh.' };
    render(<MarkOutreachForm prospectId="44444444-4444-4444-8444-444444444444" slug="c" />);
    await user.selectOptions(el('select[name="type"]'), 'replied');
    await user.type(el('input[name="note"]'), 'asked for price');
    await user.click(screen.getByRole('button', { name: 'Record' }));
    await screen.findByRole('alert');
    expect(el<HTMLSelectElement>('select[name="type"]').value).toBe('replied');
    expect(el<HTMLInputElement>('input[name="note"]').value).toBe('asked for price');

    act.result = { ok: true };
    await user.click(screen.getByRole('button', { name: 'Record' }));
    await screen.findByText('Recorded.');
    expect(el<HTMLInputElement>('input[name="note"]').value).toBe('');
  });

  it('the stage-move note and target survive a refusal', async () => {
    const user = userEvent.setup();
    act.result = { error: 'This case moved since you loaded the page. Refresh.' };
    render(<StageMoveForm caseId={CASE_ID} slug="c" stage="new" />);
    await user.selectOptions(el('select[name="to"]'), 'killed');
    await user.type(el('input[name="note"]'), 'too crowded');
    await user.click(screen.getByRole('button', { name: 'Move' }));
    await screen.findByRole('alert');
    expect(el<HTMLSelectElement>('select[name="to"]').value).toBe('killed');
    expect(el<HTMLInputElement>('input[name="note"]').value).toBe('too crowded');
  });
});
