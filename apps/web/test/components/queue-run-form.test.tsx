import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock('@/actions/runs', () => ({ queueRunAction: vi.fn(async () => ({})), requeueRunAction: vi.fn(async () => {}) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: nav.refresh }) }));

const { QueueRunForm } = await import('@/components/queue-run-form');
const { AutoRefresh } = await import('@/components/auto-refresh');

const props = { sectors: ['HVAC', 'plumbing'], lenses: [{ id: 'aggregator', name: 'Sell to the aggregator' }] };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const visible = (el: Element | null) => el !== null && el.closest('[hidden]') === null;

describe('QueueRunForm', () => {
  it('queue form shows the idea textarea only for seed idea (no-JS fallback: all fields shown, server validates)', () => {
    // Without JS (server HTML, no effects): every seed's fields are present and enabled.
    const html = renderToString(<QueueRunForm {...props} />);
    expect(html).toContain('name="ideaText"');
    expect(html).toContain('value="HVAC"');
    expect(html).toContain('value="aggregator"');
    expect(html).not.toMatch(/<fieldset[^>]*\shidden/);
    expect(html).not.toMatch(/<fieldset[^>]*\sdisabled/);

    // With JS: only the chosen seed's fields.
    const { container, getByLabelText } = render(<QueueRunForm {...props} />);
    const idea = container.querySelector('textarea[name="ideaText"]');
    expect(visible(idea)).toBe(false);
    expect(visible(container.querySelector('input[name="sectors"]'))).toBe(false);
    fireEvent.click(getByLabelText('Your idea'));
    expect(visible(container.querySelector('textarea[name="ideaText"]'))).toBe(true);
    expect(visible(container.querySelector('input[name="lensIds"]'))).toBe(false);
    fireEvent.click(getByLabelText('Sectors'));
    expect(visible(container.querySelector('input[name="sectors"]'))).toBe(true);
    expect(visible(container.querySelector('textarea[name="ideaText"]'))).toBe(false);
  });

  it('mirrors the server limits in HTML (the server still decides)', () => {
    const { container } = render(<QueueRunForm {...props} />);
    const ideas = container.querySelector('input[name="ideaCount"]')!;
    expect([ideas.getAttribute('type'), ideas.getAttribute('min'), ideas.getAttribute('max'), (ideas as HTMLInputElement).value]).toEqual(['number', '1', '30', '12']);
    const adv = container.querySelector('input[name="advanceCount"]')!;
    expect([adv.getAttribute('min'), adv.getAttribute('max'), (adv as HTMLInputElement).value]).toEqual(['1', '10', '3']);
    expect(container.querySelector('textarea[name="ideaText"]')!.getAttribute('maxlength')).toBe('20000');
    expect(container.querySelectorAll('input[name="seedType"]')).toHaveLength(4);
    expect((container.querySelector('input[name="seedType"][value="open"]') as HTMLInputElement).checked).toBe(true);
    for (const el of container.querySelectorAll('input:not([type="hidden"]), textarea')) {
      expect(el.id && container.querySelector(`label[for="${el.id}"]`), `${el.getAttribute('name')} has a label`).toBeTruthy();
    }
  });
});

describe('AutoRefresh', () => {
  it('refreshes the route on the interval and stops when unmounted', () => {
    vi.useFakeTimers();
    nav.refresh.mockClear();
    const { unmount } = render(<AutoRefresh everyMs={10_000} />);
    act(() => vi.advanceTimersByTime(25_000));
    expect(nav.refresh).toHaveBeenCalledTimes(2);
    unmount();
    act(() => vi.advanceTimersByTime(30_000));
    expect(nav.refresh).toHaveBeenCalledTimes(2);
  });
});
