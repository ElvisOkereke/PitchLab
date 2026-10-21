import { TOUR_CHAPTERS, TOUR_VERSION } from '@bcg/core/dashboard/tour';
import type { TourState } from '@bcg/core/dashboard/tour';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chapters, TourStep } from '@/lib/tour/machine';

type Popover = {
  title?: string; description?: string; showButtons?: string[]; disableButtons?: string[];
  onNextClick?: () => void; onPrevClick?: () => void; onCloseClick?: () => void;
  onPopoverRender?: (dom: { wrapper: HTMLElement; footer: HTMLElement }, opts: unknown) => void;
};
type HighlightArg = { element?: string; popover: Popover };

const drv = vi.hoisted(() => ({
  instance: {
    highlight: vi.fn(),
    destroy: vi.fn(),
    isActive: vi.fn(() => true),
    refresh: vi.fn(),
  },
  config: undefined as undefined | { onDestroyStarted?: () => void },
}));
const nav = vi.hoisted(() => ({ pathname: '/', search: '', push: vi.fn() }));

vi.mock('driver.js', () => ({
  driver: vi.fn((config: typeof drv.config) => {
    drv.config = config;
    return drv.instance;
  }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: nav.push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/actions/tour', () => ({ saveTourStateAction: vi.fn(async () => ({ ok: true })) }));

const { driver } = await import('driver.js');
const { saveTourStateAction } = await import('@/actions/tour');
const { TourProvider } = await import('@/components/tour/tour-provider');
const { TourButton } = await import('@/components/tour/tour-button');

const save = vi.mocked(saveTourStateAction);
const step = (o: Partial<TourStep> = {}): TourStep => ({ id: 's', route: '/', title: 'T', body: 'B', kind: 'info', ...o });

function chaptersWith(setup: TourStep[], generate?: TourStep[]): Chapters {
  const all = Object.fromEntries(TOUR_CHAPTERS.map((id) => [id, { title: `Chapter ${id}`, steps: [step({ id: `${id}-0`, title: `${id} start` })] }])) as Chapters;
  all.setup = { title: 'Set up', steps: setup };
  if (generate) all.generate = { title: 'Generate', steps: generate };
  return all;
}

const WELCOME = step({ id: 'welcome', route: '/', target: 'first', title: 'Welcome', body: 'Hello there.' });
const SECOND = step({ id: 'second', route: '/', target: 'second', title: 'Second', body: 'Next one.' });

function mount(o: { initial?: TourState | null; chapters?: Chapters; children?: ReactNode; caseSlug?: string | null } = {}) {
  return render(
    <TourProvider initial={o.initial === undefined ? null : o.initial} caseSlug={o.caseSlug ?? null} chapters={o.chapters ?? chaptersWith([WELCOME, SECOND])}>
      {o.children ?? (
        <>
          <TourButton />
          <div data-tour="first">first</div>
          <div data-tour="second">second</div>
        </>
      )}
    </TourProvider>,
  );
}

const highlights = () => drv.instance.highlight.mock.calls.map((c) => c[0] as HighlightArg);
const lastHighlight = () => highlights().at(-1)!;
const lastSaved = () => save.mock.calls.at(-1)?.[0] as TourState | undefined;
const STATE: TourState = { version: TOUR_VERSION, completed: [], current: null, dismissed: false };

/** Runs driver's onPopoverRender against a real popover-shaped DOM and returns that wrapper. */
function renderPopover(p: Popover): HTMLElement {
  const wrapper = document.createElement('div');
  const footer = document.createElement('footer');
  wrapper.appendChild(footer);
  document.body.appendChild(wrapper);
  p.onPopoverRender?.({ wrapper, footer }, {});
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  nav.pathname = '/';
  nav.search = '';
  drv.config = undefined;
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('TourProvider', () => {
  it('auto-starts when there is no saved state and highlights the first step by its data-tour selector', async () => {
    mount();
    await waitFor(() => expect(drv.instance.highlight).toHaveBeenCalled());
    expect(driver).toHaveBeenCalledTimes(1);
    const h = lastHighlight();
    expect(h.element).toBe('[data-tour="first"]');
    expect(h.popover.title).toBe('Welcome');
    expect(h.popover.description).toBe('Hello there.');
    await waitFor(() => expect(lastSaved()).toEqual({ version: TOUR_VERSION, completed: [], current: { chapter: 'setup', step: 0 }, dismissed: false }), { timeout: 2000 });
  });

  it('does not start by itself when a state is saved and the tour is not in progress', async () => {
    mount({ initial: { ...STATE, completed: ['setup'] } });
    await new Promise((r) => setTimeout(r, 50));
    expect(drv.instance.highlight).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('resumes a tour in progress from the saved position', async () => {
    mount({ initial: { ...STATE, current: { chapter: 'setup', step: 1 } } });
    await waitFor(() => expect(lastHighlight()?.element).toBe('[data-tour="second"]'));
  });

  it('Next advances, and finishing a chapter marks it completed and moves to the next chapter', async () => {
    mount();
    await waitFor(() => expect(drv.instance.highlight).toHaveBeenCalled());
    act(() => lastHighlight().popover.onNextClick!());
    await waitFor(() => expect(lastHighlight().popover.title).toBe('Second'));
    act(() => lastHighlight().popover.onNextClick!());
    await waitFor(() => expect(lastHighlight().popover.title).toBe('generate start'));
    await waitFor(() => expect(lastSaved()).toMatchObject({ completed: ['setup'], current: { chapter: 'generate', step: 0 } }), { timeout: 2000 });
  });

  it('Back at step 0 stays put (the button is disabled there)', async () => {
    mount();
    await waitFor(() => expect(drv.instance.highlight).toHaveBeenCalled());
    expect(lastHighlight().popover.disableButtons).toContain('previous');
  });

  it('"Exit" (the close button) saves dismissed: true and closes driver', async () => {
    mount();
    await waitFor(() => expect(drv.instance.highlight).toHaveBeenCalled());
    act(() => lastHighlight().popover.onCloseClick!());
    expect(drv.instance.destroy).toHaveBeenCalled();
    await waitFor(() => expect(lastSaved()).toMatchObject({ dismissed: true, current: { chapter: 'setup', step: 0 } }), { timeout: 2000 });
  });

  it('Escape (driver asks before closing) exits the same way', async () => {
    mount();
    await waitFor(() => expect(drv.instance.highlight).toHaveBeenCalled());
    act(() => drv.config!.onDestroyStarted!());
    expect(drv.instance.destroy).toHaveBeenCalled();
    await waitFor(() => expect(lastSaved()).toMatchObject({ dismissed: true }), { timeout: 2000 });
  });

  it('a missing target produces a centred popover (element undefined)', async () => {
    mount({ chapters: chaptersWith([step({ id: 'gone', route: '/', target: 'not-on-page', title: 'Gone' })]) });
    await waitFor(() => expect(drv.instance.highlight).toHaveBeenCalled());
    expect(lastHighlight().element).toBeUndefined();
    expect(lastHighlight().popover.title).toBe('Gone');
  });

  it('a step on another page offers "Take me there", which pushes the route', async () => {
    mount({ chapters: chaptersWith([step({ id: 'runs', route: '/runs', target: 'first', title: 'Runs' })]) });
    await waitFor(() => expect(drv.instance.highlight).toHaveBeenCalled());
    expect(lastHighlight().element).toBeUndefined();
    const popover = renderPopover(lastHighlight().popover);
    fireEvent.click(within(popover).getByRole('button', { name: 'Take me there' }));
    expect(nav.push).toHaveBeenCalledWith('/runs');
  });

  it('a case step with no case to show is centred, never "Take me there"', async () => {
    mount({ chapters: chaptersWith([step({ id: 'c', route: (c) => (c.caseSlug ? `/cases/${c.caseSlug}` : null), target: 'first' })]) });
    await waitFor(() => expect(drv.instance.highlight).toHaveBeenCalled());
    expect(lastHighlight().element).toBeUndefined();
    expect(within(renderPopover(lastHighlight().popover)).queryByRole('button', { name: 'Take me there' })).toBeNull();
  });

  it('the popover adds a labelled "Skip chapter" button that moves to the next chapter', async () => {
    mount();
    await waitFor(() => expect(drv.instance.highlight).toHaveBeenCalled());
    const popover = renderPopover(lastHighlight().popover);
    fireEvent.click(within(popover).getByRole('button', { name: 'Skip chapter' }));
    await waitFor(() => expect(lastHighlight().popover.title).toBe('generate start'));
    await waitFor(() => expect(lastSaved()).toMatchObject({ completed: [], current: { chapter: 'generate', step: 0 } }), { timeout: 2000 });
  });

  it('an action step advances when the user clicks the target', async () => {
    const chapters = chaptersWith([step({ id: 'a', target: 'first', kind: 'action', advanceOn: { click: true } }), SECOND]);
    const { getByText } = mount({ chapters });
    await waitFor(() => expect(lastHighlight()?.element).toBe('[data-tour="first"]'));
    expect(lastHighlight().popover.showButtons).toContain('next');
    fireEvent.click(getByText('first'));
    await waitFor(() => expect(lastHighlight().element).toBe('[data-tour="second"]'));
  });

  it('an action step advances when the expected element appears', async () => {
    const chapters = chaptersWith([step({ id: 'a', target: 'first', kind: 'action', advanceOn: { appears: 'queued' } }), step({ id: 'b', title: 'After' })]);
    const { container } = mount({ chapters });
    await waitFor(() => expect(lastHighlight()?.element).toBe('[data-tour="first"]'));
    const ok = document.createElement('p');
    ok.setAttribute('data-tour', 'queued');
    act(() => {
      container.appendChild(ok);
    });
    await waitFor(() => expect(lastHighlight().popover.title).toBe('After'));
  });

  it('an action step advances when the route changes to the expected path', async () => {
    const chapters = chaptersWith([step({ id: 'a', target: 'first', kind: 'action', advanceOn: { path: /^\/runs/ } }), step({ id: 'b', route: '/runs', title: 'On runs' })]);
    const view = mount({ chapters });
    await waitFor(() => expect(lastHighlight()?.element).toBe('[data-tour="first"]'));
    nav.pathname = '/runs';
    view.rerender(
      <TourProvider initial={null} caseSlug={null} chapters={chapters}>
        <div data-tour="first">first</div>
      </TourProvider>,
    );
    await waitFor(() => expect(lastHighlight().popover.title).toBe('On runs'));
  });

  it('the last step of the last chapter finishes the tour: current cleared, driver closed', async () => {
    mount({ initial: { ...STATE, current: { chapter: 'decide', step: 0 } } });
    await waitFor(() => expect(lastHighlight()?.popover.title).toBe('decide start'));
    act(() => lastHighlight().popover.onNextClick!());
    expect(drv.instance.destroy).toHaveBeenCalled();
    await waitFor(() => expect(lastSaved()).toMatchObject({ completed: ['decide'], current: null, dismissed: false }), { timeout: 2000 });
  });
});

describe('TourButton and ChapterPicker', () => {
  it('the button opens the picker: 8 chapters with ✓ on completed ones, start and continue', async () => {
    const view = mount({ initial: { ...STATE, completed: ['generate'], current: { chapter: 'setup', step: 1 }, dismissed: true } });
    expect(drv.instance.highlight).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: /Take the tour/ }));
    const dialog = view.getByRole('dialog', { name: 'Take the tour' });
    const items = within(dialog).getAllByRole('listitem');
    expect(items).toHaveLength(8);
    expect(items[0]!.textContent).toContain('Set up');
    expect(items[1]!.textContent).toContain('✓');
    expect(items[0]!.textContent).not.toContain('✓');
    expect(within(dialog).getByRole('button', { name: 'Start from the beginning' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue where you left off' }));
    expect(view.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(lastHighlight()?.element).toBe('[data-tour="second"]'));
  });

  it('no "Continue" without a saved position; "Start from the beginning" starts at the first step', async () => {
    const view = mount({ initial: STATE });
    fireEvent.click(view.getByRole('button', { name: /Take the tour/ }));
    const dialog = view.getByRole('dialog', { name: 'Take the tour' });
    expect(within(dialog).queryByRole('button', { name: 'Continue where you left off' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start from the beginning' }));
    await waitFor(() => expect(lastHighlight()?.element).toBe('[data-tour="first"]'));
    await waitFor(() => expect(lastSaved()).toMatchObject({ current: { chapter: 'setup', step: 0 }, dismissed: false }), { timeout: 2000 });
  });

  it('picking one chapter runs only that chapter', async () => {
    const view = mount({ initial: STATE });
    fireEvent.click(view.getByRole('button', { name: /Take the tour/ }));
    fireEvent.click(within(view.getByRole('dialog')).getByRole('button', { name: /Chapter score/ }));
    await waitFor(() => expect(lastHighlight()?.popover.title).toBe('score start'));
    act(() => lastHighlight().popover.onNextClick!());
    expect(drv.instance.destroy).toHaveBeenCalled();
    await waitFor(() => expect(lastSaved()).toMatchObject({ completed: ['score'], current: null }), { timeout: 2000 });
  });

  it('Escape closes the picker', () => {
    const view = mount({ initial: STATE });
    fireEvent.click(view.getByRole('button', { name: /Take the tour/ }));
    fireEvent.keyDown(view.getByRole('dialog'), { key: 'Escape' });
    expect(view.queryByRole('dialog')).toBeNull();
  });
});
