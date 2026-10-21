'use client';

// The guided tour engine. One driver.js instance shows one step at a time; the step machine (lib/tour/machine.ts)
// decides whether to highlight the target, centre the popover, or offer "Take me there". Progress is saved to the
// database (debounced) on every position change, finish or exit.
//
// driver.js writes popover title/description with innerHTML: only the step's own string literals from
// lib/tour/chapters.ts are passed to it. Extra buttons are built with DOM APIs and textContent.
import 'driver.js/dist/driver.css';
import type { TourChapterId, TourState } from '@bcg/core/dashboard/tour';
import { TOUR_CHAPTERS, TOUR_VERSION } from '@bcg/core/dashboard/tour-ids';
import { driver as createDriver } from 'driver.js';
import type { Driver, PopoverDOM } from 'driver.js';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { Suspense, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { saveTourStateAction } from '@/actions/tour';
import { CHAPTERS } from '@/lib/tour/chapters';
import type { Chapters, Position } from '@/lib/tour/machine';
import { chapterAfter, hasNewSteps, next, resolve, back as stepBack, shouldAutoStart } from '@/lib/tour/machine';
import { ChapterPicker } from './chapter-picker';

const SAVE_DELAY_MS = 500;
type Mode = 'all' | 'chapter';

type TourContextValue = {
  state: TourState | null;
  newSteps: boolean;
  openPicker: () => void;
};

const TourContext = createContext<TourContextValue | null>(null);

/** The tour controls for components inside TourProvider (the header button). */
export function useTour(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error('useTour must be used inside TourProvider');
  return ctx;
}

const selector = (id: string) => `[data-tour="${id}"]`;

/** Reports the current path + query. In its own Suspense boundary so useSearchParams never suspends the page. */
function LocationWatcher({ onChange }: { onChange: (location: string) => void }) {
  const pathname = usePathname() ?? '/';
  const search = useSearchParams()?.toString() ?? '';
  const location = search ? `${pathname}?${search}` : pathname;
  useEffect(() => onChange(location), [location, onChange]);
  return null;
}

type Props = {
  /** The saved state (null: never saved, so the tour starts by itself). */
  initial: TourState | null;
  /** The case the case-page steps use (newest real case, else the example). */
  caseSlug: string | null;
  /** Defaults to the real chapters; tests pass fixtures. */
  chapters?: Chapters;
  children: ReactNode;
};

export function TourProvider({ initial, caseSlug, chapters = CHAPTERS, children }: Props) {
  const router = useRouter();
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  }, [router]);
  const auto = shouldAutoStart(initial);
  const [tour, setTour] = useState<TourState | null>(() =>
    auto ? { version: TOUR_VERSION, completed: [], current: { chapter: TOUR_CHAPTERS[0], step: 0 }, dismissed: false } : initial);
  const [mode, setMode] = useState<Mode | null>(() => (auto || (initial?.current && !initial.dismissed) ? 'all' : null));
  const [location, setLocation] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [recheck, setRecheck] = useState(0);

  const tourRef = useRef(tour);
  const modeRef = useRef(mode);
  const driverRef = useRef<Driver | null>(null);
  const initialRef = useRef(initial);
  const pendingSave = useRef<TourState | null>(null);
  const stepStart = useRef<{ key: string; location: string } | null>(null);

  const commit = useCallback((s: TourState, m: Mode | null) => {
    const saved = { ...s, version: TOUR_VERSION };
    tourRef.current = saved;
    modeRef.current = m;
    setTour(saved);
    setMode(m);
  }, []);

  const closeDriver = useCallback(() => {
    driverRef.current?.destroy();
  }, []);

  /** Closes the tour and remembers the place; `dismissed` hides the "new steps" hint. */
  const exit = useCallback(() => {
    const t = tourRef.current;
    closeDriver();
    if (t) commit({ ...t, dismissed: true }, null);
  }, [closeDriver, commit]);

  const finish = useCallback((completed: TourChapterId[]) => {
    const t = tourRef.current;
    closeDriver();
    if (t) commit({ ...t, completed, current: null, dismissed: false }, null);
  }, [closeDriver, commit]);

  const goTo = useCallback((pos: Position) => {
    const t = tourRef.current;
    if (t) commit({ ...t, current: pos, dismissed: false }, modeRef.current);
  }, [commit]);

  const goNext = useCallback(() => {
    const t = tourRef.current;
    if (!t?.current) return;
    const n = next(t.current, chapters);
    if (!('done' in n)) return goTo(n);
    const completed = TOUR_CHAPTERS.filter((c) => c === n.done || t.completed.includes(c));
    const after = modeRef.current === 'all' ? chapterAfter(n.done) : null;
    if (after) commit({ ...t, completed, current: { chapter: after, step: 0 }, dismissed: false }, 'all');
    else finish(completed);
  }, [chapters, commit, finish, goTo]);

  const goBack = useCallback(() => {
    const t = tourRef.current;
    if (t?.current) goTo(stepBack(t.current, chapters));
  }, [chapters, goTo]);

  const skipChapter = useCallback(() => {
    const t = tourRef.current;
    if (!t?.current) return;
    const after = modeRef.current === 'all' ? chapterAfter(t.current.chapter) : null;
    if (after) goTo({ chapter: after, step: 0 });
    else finish(t.completed);
  }, [finish, goTo]);

  const getDriver = useCallback((): Driver => {
    if (!driverRef.current) {
      driverRef.current = createDriver({
        animate: true,
        allowClose: true,
        overlayClickBehavior: 'none',
        smoothScroll: true,
        stagePadding: 6,
        stageRadius: 8,
        popoverClass: 'tour-popover',
        // Escape asks before closing: treat it as Exit (which saves the place) and close ourselves.
        onDestroyStarted: () => exit(),
      });
    }
    return driverRef.current;
  }, [exit]);

  // Show the current step whenever the position, the page or the case changes.
  useEffect(() => {
    const pos = tour?.current;
    if (!mode || !pos || location === null) return;
    const chapter = chapters[pos.chapter];
    const step = chapter.steps[pos.step];
    if (!step) {
      // A saved position the chapters no longer have: restart the chapter, or skip it when it is empty.
      if (chapter.steps.length > 0) goTo({ chapter: pos.chapter, step: 0 });
      else skipChapter();
      return;
    }

    const key = `${pos.chapter}:${pos.step}`;
    if (stepStart.current?.key !== key) stepStart.current = { key, location };
    else if (step.kind === 'action' && step.advanceOn?.path && location !== stepStart.current.location && step.advanceOn.path.test(location)) {
      goNext();
      return;
    }

    const targetSel = step.target ? selector(step.target) : undefined;
    const targetEl = targetSel ? document.querySelector(targetSel) : null;
    const how = resolve(step, { caseSlug }, location, targetEl !== null);
    const done = next(pos, chapters);
    const last = 'done' in done && (mode === 'chapter' || chapterAfter(pos.chapter) === null);

    const addExtras = (dom: PopoverDOM) => {
      const row = document.createElement('div');
      row.className = 'tour-extra';
      const add = (label: string, secondary: boolean, onClick: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = secondary ? 'tour-extra-btn secondary' : 'tour-extra-btn';
        b.textContent = label;
        b.addEventListener('click', onClick);
        row.appendChild(b);
      };
      if (how.show === 'go-there' && how.href) {
        const href = how.href;
        add('Take me there', false, () => routerRef.current.push(href));
      }
      if (step.wait) add('I’ll come back later', true, exit);
      add('Skip chapter', true, skipChapter);
      dom.wrapper.insertBefore(row, dom.footer);
    };

    getDriver().highlight({
      element: how.show === 'highlight' ? targetSel : undefined,
      popover: {
        title: step.title,
        description: step.body,
        showButtons: ['next', 'previous', 'close'],
        disableButtons: pos.step === 0 ? ['previous'] : [],
        nextBtnText: last ? 'Finish' : 'Next',
        prevBtnText: 'Back',
        closeBtnLabel: 'Exit tour',
        onNextClick: () => goNext(),
        onPrevClick: () => goBack(),
        onCloseClick: () => exit(),
        onPopoverRender: (dom) => addExtras(dom),
      },
    });

    const cleanups: (() => void)[] = [];
    if (step.kind === 'action' && step.advanceOn?.click && how.show === 'highlight' && targetEl) {
      const onClick = () => goNext();
      targetEl.addEventListener('click', onClick);
      cleanups.push(() => targetEl.removeEventListener('click', onClick));
    }
    // Wait for the "appears" element (action steps) and, when the target is missing on the right page, for the
    // target to show up so the centred popover can turn into a highlight.
    const appearsSel = step.kind === 'action' && step.advanceOn?.appears ? selector(step.advanceOn.appears) : undefined;
    const waitForTarget = how.show === 'centred' && targetSel !== undefined && targetEl === null;
    if (how.show !== 'go-there' && (appearsSel || waitForTarget)) {
      const before = appearsSel ? document.querySelector(appearsSel) : null;
      const observer = new MutationObserver(() => {
        if (appearsSel) {
          const el = document.querySelector(appearsSel);
          if (el && el !== before) {
            observer.disconnect();
            goNext();
            return;
          }
        }
        if (waitForTarget && targetSel && document.querySelector(targetSel)) {
          observer.disconnect();
          setRecheck((n) => n + 1);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-tour'] });
      cleanups.push(() => observer.disconnect());
    }
    return () => cleanups.forEach((c) => c());
  }, [tour, mode, location, caseSlug, chapters, recheck, getDriver, goNext, goBack, goTo, skipChapter, exit]);

  // Debounced save of every change (never the state that came from the server unchanged).
  useEffect(() => {
    if (tour === null || tour === initialRef.current) return;
    pendingSave.current = tour;
    const timer = setTimeout(() => {
      pendingSave.current = null;
      void saveTourStateAction(tour).catch(() => {});
    }, SAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [tour]);

  // On unmount: flush a pending save and close driver.
  useEffect(() => () => {
    if (pendingSave.current) void saveTourStateAction(pendingSave.current).catch(() => {});
    driverRef.current?.destroy();
  }, []);

  const openPicker = useCallback(() => {
    // Pause a running tour while the picker is open; the saved position is kept.
    if (modeRef.current) {
      closeDriver();
      modeRef.current = null;
      setMode(null);
    }
    setPickerOpen(true);
  }, [closeDriver]);

  const start = useCallback((chapter: TourChapterId, m: Mode) => {
    setPickerOpen(false);
    stepStart.current = null;
    const t = tourRef.current;
    commit({ version: TOUR_VERSION, completed: t?.completed ?? [], current: { chapter, step: 0 }, dismissed: false }, m);
  }, [commit]);

  const continueTour = useCallback(() => {
    setPickerOpen(false);
    stepStart.current = null;
    const t = tourRef.current;
    if (t?.current) commit({ ...t, dismissed: false }, 'all');
  }, [commit]);

  const newSteps = hasNewSteps(initial) && tour === initialRef.current;
  const value = useMemo(() => ({ state: tour, newSteps, openPicker }), [tour, newSteps, openPicker]);

  return (
    <TourContext.Provider value={value}>
      <Suspense fallback={null}>
        <LocationWatcher onChange={setLocation} />
      </Suspense>
      {children}
      {pickerOpen ? (
        <ChapterPicker
          chapters={chapters}
          state={tour}
          newSteps={newSteps}
          onStartChapter={(id) => start(id, 'chapter')}
          onStartAll={() => start(TOUR_CHAPTERS[0], 'all')}
          onContinue={continueTour}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </TourContext.Provider>
  );
}
