import { DEFAULT_MODELS } from '@bcg/core/config/models';
import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingsData } from '@/components/settings-view';

vi.mock('@/actions/settings', () => ({ saveSettingsAction: vi.fn(async () => ({})), saveHoldoutAction: vi.fn(async () => ({})) }));
vi.mock('@/actions/library', () => ({ saveResearchSettingsAction: vi.fn(async () => ({})) }));
vi.mock('@/actions/example', () => ({ hideExampleAction: vi.fn(async () => {}), resetExampleAction: vi.fn(async () => {}) }));

const { SettingsView } = await import('@/components/settings-view');

afterEach(cleanup);

function data(o: Partial<SettingsData> = {}): SettingsData {
  return {
    values: {
      'sender.name': 'Al <b>Owner</b>', 'sender.company': '', 'sender.address': '1 Main St', 'sender.contact': 'https://al.example', 'sender.email': '',
      'landing.privacyContact': 'privacy@al.example', 'landing.formEndpoint': '',
    },
    worker: { at: '2026-10-20T14:59:50.000Z', providers: { llm: true, github: false, stackexchange: true, places: false, producthunt: false, youtube: false, browser: false }, models: { ...DEFAULT_MODELS, case: 'claude-custom' } },
    database: true,
    example: { hidden: false },
    research: { background: false, dailyCapUsd: 5 },
    holdout: [],
    lenses: [{ id: 'aggregator', name: 'Sell to the aggregator' }, { id: 'review-gap', name: 'Incumbent review gap' }],
    market: { id: 'ca-us', name: 'Canada + US', sectors: ['HVAC'] },
    ...o,
  };
}

describe('SettingsView markup', () => {
  it('no details element sits inside a paragraph or heading (the parser would close it early)', () => {
    const { container } = render(<SettingsView data={data()} />);
    expect(container.querySelectorAll('p details, h1 details, h2 details')).toHaveLength(0);
  });
});

describe('SettingsView research card', () => {
  it('shows the Background research checkbox and the daily cap as saved, with a save button', () => {
    const { getByTestId } = render(<SettingsView data={data({ research: { background: true, dailyCapUsd: 7.5 } })} />);
    const f = getByTestId('research-settings');
    const box = f.querySelector<HTMLInputElement>('input[name="background"]')!;
    const cap = f.querySelector<HTMLInputElement>('input[name="dailyCapUsd"]')!;
    expect(box.type).toBe('checkbox');
    expect(box.checked).toBe(true);
    expect(cap.value).toBe('7.5');
    expect(f.querySelector(`label[for="${box.id}"]`)!.textContent).toBe('Background research');
    expect(f.querySelector(`label[for="${cap.id}"]`)).toBeTruthy();
    expect(within(f).getByRole('button', { name: 'Save research settings' })).toBeTruthy();
  });

  it('says a cap below $1 stops background research, and not otherwise', () => {
    const low = render(<SettingsView data={data({ research: { background: true, dailyCapUsd: 0.5 } })} />);
    expect(low.getByTestId('research-cap-note').textContent).toBe('Background research needs a cap of at least $1.');
    low.unmount();
    const ok = render(<SettingsView data={data({ research: { background: true, dailyCapUsd: 1 } })} />);
    expect(ok.queryByTestId('research-cap-note')).toBeNull();
  });

  it('is unchecked by default', () => {
    const { getByTestId } = render(<SettingsView data={data()} />);
    expect(getByTestId('research-settings').querySelector<HTMLInputElement>('input[name="background"]')!.checked).toBe(false);
  });
});

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
    expect(items).toEqual({ 'LLM API': 'connected', GitHub: 'not set', 'Stack Exchange': 'connected', 'Google Places': 'not set', 'Product Hunt': 'not set', YouTube: 'not set', 'Local browser (Chromium)': 'not installed', Database: 'connected' });
    expect(c.textContent).not.toMatch(/reddit/i);
    expect([...c.querySelectorAll('.badge')].map((b) => b.textContent).join(' ')).not.toMatch(/postgres|key|secret|:\/\//i);
  });

  it('the whole Connections section holds no secret-shaped text in any state (variable names are fine)', () => {
    const w = data().worker!;
    const allOn = Object.fromEntries(Object.keys(w.providers).map((k) => [k, true])) as typeof w.providers;
    const secretShaped = /postgres(ql)?:|:\/\/[^\s]*@|AIza[0-9A-Za-z_-]{10,}|sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|Bearer\s/;
    for (const d of [data(), data({ worker: { ...w, providers: allOn } }), data({ worker: null, database: false })]) {
      const { getByTestId, unmount } = render(<SettingsView data={d} />);
      const t = getByTestId('connections').textContent!;
      expect(t).not.toMatch(secretShaped);
      unmount();
    }
    const off = render(<SettingsView data={data()} />);
    expect(off.getByTestId('connections').textContent).toContain('YOUTUBE_API_KEY');
  });

  it('YouTube: connected when the worker says so, otherwise how to add the key (the name only, never a value)', () => {
    const w = data().worker!;
    const on = render(<SettingsView data={data({ worker: { ...w, providers: { ...w.providers, youtube: true } } })} />);
    expect(within(on.getByTestId('conn-youtube')).getByText('connected')).toBeTruthy();
    expect(on.getByTestId('conn-youtube').textContent).not.toContain('YOUTUBE_API_KEY');
    on.unmount();
    const off = render(<SettingsView data={data()} />);
    const t = off.getByTestId('conn-youtube').textContent!;
    expect(t).toContain('not set');
    expect(t).toContain('YOUTUBE_API_KEY');
    expect(t).toMatch(/\.env/);
    expect(t).toMatch(/restart/i);
  });

  it('Local browser: installed, or not installed with the install command and where to run it', () => {
    const w = data().worker!;
    const on = render(<SettingsView data={data({ worker: { ...w, providers: { ...w.providers, browser: true } } })} />);
    const ton = on.getByTestId('conn-browser').textContent!;
    expect(ton).toContain('installed');
    expect(ton).not.toContain('not installed');
    expect(ton).not.toContain('npx playwright');
    on.unmount();
    const off = render(<SettingsView data={data()} />);
    const t = off.getByTestId('conn-browser').textContent!;
    expect(t).toContain('not installed');
    expect(t).toContain('npx playwright-core install chromium');
    expect(t).toContain('packages/core');
  });

  it('shows no setup hints before the worker has been seen', () => {
    const { getByTestId } = render(<SettingsView data={data({ worker: null })} />);
    expect(getByTestId('conn-youtube').textContent).toContain('unknown');
    expect(getByTestId('conn-youtube').textContent).not.toContain('YOUTUBE_API_KEY');
    expect(getByTestId('conn-browser').textContent).not.toContain('npx playwright');
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

  it('example section: Hide and Reset when shown, only Reset when hidden', () => {
    const shown = render(<SettingsView data={data()} />);
    const sec = shown.container.querySelector('[data-tour="settings-example"]') as HTMLElement;
    expect(sec.textContent).toContain('Shown');
    expect(within(sec).getByRole('button', { name: 'Hide example case' })).toBeTruthy();
    expect(within(sec).getByRole('button', { name: 'Reset example case' })).toBeTruthy();
    expect(sec.textContent).toContain('your practice scores and notes on it are removed');
    cleanup();
    const hidden = render(<SettingsView data={data({ example: { hidden: true } })} />);
    const sec2 = hidden.container.querySelector('[data-tour="settings-example"]') as HTMLElement;
    expect(sec2.textContent).toContain('Hidden');
    expect(within(sec2).queryByRole('button', { name: 'Hide example case' })).toBeNull();
    expect(within(sec2).getByRole('button', { name: 'Reset example case' })).toBeTruthy();
  });

  it('renders an allow-listed notice', () => {
    const { getByRole } = render(<SettingsView data={data()} notice="example_hidden" />);
    expect(getByRole('status').textContent).toContain('hidden');
  });
});

describe('SettingsView holdout card', () => {
  it('shows the saved examples one per line in a text box, as text', () => {
    const { getByTestId } = render(<SettingsView data={data({ holdout: ['An AI <b>bookkeeper</b>', 'A marketplace'] })} />);
    const f = getByTestId('holdout-form');
    const box = f.querySelector<HTMLTextAreaElement>('textarea[name="holdout"]')!;
    expect(box.value).toBe('An AI <b>bookkeeper</b>\nA marketplace');
    expect(f.querySelector('b')).toBeNull();
    expect(within(f).getByRole('button', { name: 'Save holdout examples' })).toBeTruthy();
  });

  it('starts empty with no examples', () => {
    const { getByTestId } = render(<SettingsView data={data()} />);
    expect(getByTestId('holdout-form').querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('');
  });
});

describe('SettingsView feeds', () => {
  const feeds = {
    at: '2026-11-08T12:00:00.000Z',
    spentUsd: 0.4,
    sources: [
      { name: 'reddit' as const, label: 'Reddit', items: 42, added: 7, errors: [] },
      { name: 'bluesky' as const, label: 'Bluesky', items: 0, added: 0, errors: ['search needs sign-in (set BLUESKY_HANDLE and BLUESKY_APP_PASSWORD)', 'rate limited'] },
    ],
  };

  it('lists each source in Connections with its last run, items, added and errors as text', () => {
    const { getByTestId } = render(<SettingsView data={data({ feeds })} />);
    const conn = getByTestId('connections');
    expect(within(conn).getByTestId('feeds')).toBeTruthy();
    const reddit = getByTestId('feed-reddit').textContent!;
    expect(reddit).toContain('Reddit');
    expect(reddit).toContain('42 items');
    expect(reddit).toContain('7 added');
    expect(reddit).toContain('no errors');
    const bsky = getByTestId('feed-bluesky').textContent!;
    expect(bsky).toContain('0 items');
    expect(bsky).toContain('errors: search needs sign-in (set BLUESKY_HANDLE and BLUESKY_APP_PASSWORD); rate limited');
  });

  it('says the feeds have not run before the first run, and escapes error text', () => {
    const none = render(<SettingsView data={data({ feeds: null })} />);
    expect(none.getByTestId('feeds').textContent).toContain('have not run yet');
    none.unmount();
    const bad = { ...feeds, sources: [{ name: 'reddit' as const, label: 'Reddit', items: 1, added: 0, errors: ['<img src=x onerror=alert(1)>'] }] };
    const { getByTestId } = render(<SettingsView data={data({ feeds: bad })} />);
    expect(getByTestId('feed-reddit').querySelector('img')).toBeNull();
    expect(getByTestId('feed-reddit').textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
