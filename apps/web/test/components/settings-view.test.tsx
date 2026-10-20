import { DEFAULT_MODELS } from '@bcg/core/config/models';
import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingsData } from '@/components/settings-view';

vi.mock('@/actions/settings', () => ({ saveSettingsAction: vi.fn(async () => ({})) }));

const { SettingsView } = await import('@/components/settings-view');

afterEach(cleanup);

function data(o: Partial<SettingsData> = {}): SettingsData {
  return {
    values: {
      'sender.name': 'Al <b>Owner</b>', 'sender.company': '', 'sender.address': '1 Main St', 'sender.contact': 'https://al.example', 'sender.email': '',
      'landing.privacyContact': 'privacy@al.example', 'landing.formEndpoint': '',
    },
    worker: { at: '2026-10-20T14:59:50.000Z', providers: { llm: true, github: false, stackexchange: true, places: false }, models: { ...DEFAULT_MODELS, case: 'claude-custom' } },
    database: true,
    lenses: [{ id: 'aggregator', name: 'Sell to the aggregator' }, { id: 'review-gap', name: 'Incumbent review gap' }],
    market: { id: 'ca-us', name: 'Canada + US', sectors: ['HVAC'] },
    ...o,
  };
}

describe('SettingsView', () => {
  it('shows the editable sender and landing settings with labels and current values', () => {
    const { getByTestId } = render(<SettingsView data={data()} />);
    const form = getByTestId('settings-form');
    const inputs = [...form.querySelectorAll('input')].filter((i) => i.type !== 'hidden');
    expect(inputs.map((i) => i.name)).toEqual([
      'sender.name', 'sender.company', 'sender.address', 'sender.contact', 'sender.email', 'landing.privacyContact', 'landing.formEndpoint',
    ]);
    expect(inputs[0]!.value).toBe('Al <b>Owner</b>');
    expect(inputs.every((i) => i.maxLength === 500)).toBe(true);
    for (const i of inputs) expect(form.querySelector(`label[for="${i.id}"]`)).toBeTruthy();
    expect(form.querySelector('b')).toBeNull();
  });

  it('connections show connected / not set badges and never values', () => {
    const { getByTestId } = render(<SettingsView data={data()} />);
    const c = getByTestId('connections');
    const items = Object.fromEntries([...c.querySelectorAll('li')].map((li) => [li.querySelector('.name')!.textContent, li.querySelector('.badge')!.textContent]));
    expect(items).toEqual({ 'LLM API': 'connected', GitHub: 'not set', 'Stack Exchange': 'connected', 'Google Places': 'not set', Database: 'connected' });
    expect(c.textContent).not.toMatch(/postgres|key|secret|:\/\//i);
  });

  it('models come from the worker heartbeat, else the defaults labelled as such', () => {
    const live = render(<SettingsView data={data()} />);
    expect(live.getByTestId('models').textContent).toContain('claude-custom');
    expect(live.getByTestId('models').textContent).not.toContain('defaults (worker not seen)');
    cleanup();
    const none = render(<SettingsView data={data({ worker: null, database: false })} />);
    expect(none.getByTestId('models').textContent).toContain('defaults (worker not seen)');
    expect(none.getByTestId('models').textContent).toContain(DEFAULT_MODELS.case);
    const conn = within(none.getByTestId('connections'));
    expect(conn.getByText('Database').closest('li')!.textContent).toContain('not reachable');
    expect(conn.getByText('LLM API').closest('li')!.textContent).toContain('unknown (worker not seen)');
  });

  it('lists lens and market names and the 8 scoring criteria', () => {
    const { getByTestId } = render(<SettingsView data={data()} />);
    expect(getByTestId('lenses').textContent).toContain('Sell to the aggregator');
    expect(getByTestId('lenses').textContent).toContain('Canada + US');
    const criteria = [...getByTestId('criteria').querySelectorAll('li')].map((li) => li.textContent);
    expect(criteria).toEqual(['Pain severity', 'Buyer ROI clarity', 'Evidence strength', 'Speed to market', 'Autonomy', 'Novelty/non-generic', 'Reachability', 'Your gut']);
  });
});
