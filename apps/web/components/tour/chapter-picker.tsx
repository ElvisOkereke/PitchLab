'use client';

import type { TourChapterId, TourState } from '@bcg/core/dashboard/tour';
import { TOUR_CHAPTERS } from '@bcg/core/dashboard/tour-ids';
import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { Chapters } from '@/lib/tour/machine';

type Props = {
  chapters: Chapters;
  state: TourState | null;
  newSteps: boolean;
  onStartChapter: (id: TourChapterId) => void;
  onStartAll: () => void;
  onContinue: () => void;
  onClose: () => void;
};

/** "Take the tour": continue, start over, or run one chapter. A modal dialog; Escape or Close dismisses it. */
export function ChapterPicker({ chapters, state, newSteps, onStartChapter, onStartAll, onContinue, onClose }: Props) {
  const dialog = useRef<HTMLDivElement>(null);

  // Focus moves into the dialog, and back to where it was (the header button) when it closes.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => previous?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !dialog.current) return;
    // Keep Tab inside the dialog.
    const buttons = [...dialog.current.querySelectorAll<HTMLButtonElement>('button')];
    const first = buttons[0];
    const last = buttons.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  };

  const completed = new Set(state?.completed ?? []);
  const canContinue = Boolean(state?.current);

  return (
    <div className="tour-picker-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="tour-picker-title" className="tour-picker" onKeyDown={onKeyDown}>
        <h2 id="tour-picker-title">Take the tour</h2>
        {newSteps ? <p className="notice">The tour has new steps.</p> : null}
        <p className="muted small">Run the whole tour, or pick one chapter.</p>
        <div className="tour-picker-actions">
          {canContinue ? (
            <button type="button" onClick={onContinue}>
              Continue where you left off
            </button>
          ) : null}
          <button type="button" className={canContinue ? 'secondary' : undefined} onClick={onStartAll}>
            Start from the beginning
          </button>
        </div>
        <ol className="tour-chapters">
          {TOUR_CHAPTERS.map((id) => (
            <li key={id}>
              <button type="button" className="secondary" onClick={() => onStartChapter(id)}>
                <span>{chapters[id].title}</span>
                {completed.has(id) ? (
                  <>
                    <span aria-hidden="true" className="tour-done">
                      ✓
                    </span>
                    <span className="visually-hidden"> (done)</span>
                  </>
                ) : null}
              </button>
            </li>
          ))}
        </ol>
        <button type="button" className="secondary tour-picker-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
