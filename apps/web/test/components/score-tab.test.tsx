import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { caseViewFixture, scoreRow } from '../helpers/case-fixture';

vi.mock('@/actions/scores', () => ({ saveOwnerScoresAction: vi.fn(async () => ({})) }));

const { ScoreTab } = await import('@/components/tabs/score');

afterEach(cleanup);

describe('ScoreTab', () => {
  it('shows AI scores read-only and an 8-row owner form pre-filled with the latest owner values', () => {
    const view = caseViewFixture();
    view.scores = [
      scoreRow('pain', 4, 'ai', 'painful'),
      scoreRow('roi', 3, 'ai', 'ok roi'),
      scoreRow('gut', 2, 'owner', 'meh'),
      scoreRow('pain', 5, 'owner', 'really painful'),
    ];
    const { container, getByTestId } = render(<ScoreTab view={view} />);

    const ai = getByTestId('ai-scores');
    const aiRows = [...ai.querySelectorAll('tbody tr')].map((r) => [...r.querySelectorAll('td, th')].map((c) => c.textContent));
    expect(aiRows).toContainEqual(['Pain severity', '4', 'painful']);
    expect(aiRows).toContainEqual(['Buyer ROI clarity', '3', 'ok roi']);
    expect(ai.querySelector('select, input, textarea')).toBeNull();
    expect(container.textContent).toContain('AI mean: 3.5');
    expect(container.textContent).toContain('Your mean: 3.5');

    const form = getByTestId('score-form');
    const selects = [...form.querySelectorAll('select')];
    expect(selects.map((s) => s.getAttribute('name'))).toEqual([
      'value_pain', 'value_roi', 'value_evidence', 'value_speed', 'value_autonomy', 'value_novelty', 'value_reach', 'value_gut',
    ]);
    expect([...selects[0]!.querySelectorAll('option')].map((o) => o.getAttribute('value'))).toEqual(['', '1', '2', '3', '4', '5']);
    expect((selects[0] as HTMLSelectElement).value).toBe('5');
    expect((selects[7] as HTMLSelectElement).value).toBe('2');
    expect((selects[1] as HTMLSelectElement).value).toBe('');
    const notes = [...form.querySelectorAll('textarea')];
    expect(notes).toHaveLength(8);
    expect(notes.every((t) => t.getAttribute('maxlength') === '1000')).toBe(true);
    expect((form.querySelector('textarea[name="note_gut"]') as HTMLTextAreaElement).value).toBe('meh');
    expect(form.querySelector('input[name="caseId"]')?.getAttribute('value')).toBe(view.case.id);
    expect(within(form).getByText('Your gut')).toBeTruthy();
    // Every control has a label.
    for (const el of form.querySelectorAll('select, textarea')) expect(form.querySelector(`label[for="${el.id}"]`)).toBeTruthy();
  });

  it('says so when the AI has not scored the case', () => {
    const { getByTestId } = render(<ScoreTab view={caseViewFixture()} />);
    expect(getByTestId('ai-scores').textContent).toContain('Not scored yet.');
  });
});
