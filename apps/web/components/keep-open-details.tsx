'use client';

import { useEffect, useRef, type ReactNode } from 'react';

const PREFIX = 'pitchlab.open.';

/**
 * A `<details>` that remembers being open (per `storageKey`, in this tab's session storage), so a list you opened stays
 * open when the page refreshes after a form submit. Closing it forgets it. Without storage (a private window, blocked
 * site data) it is a plain `<details>`; without JS it is one too.
 */
export function KeepOpenDetails({ storageKey, summary, children }: { storageKey: string; summary: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    try {
      if (ref.current && sessionStorage.getItem(PREFIX + storageKey) === '1') ref.current.open = true;
    } catch {
      // storage unavailable: stay a plain <details>
    }
  }, [storageKey]);
  return (
    <details
      ref={ref}
      onToggle={(e) => {
        try {
          if (e.currentTarget.open) sessionStorage.setItem(PREFIX + storageKey, '1');
          else sessionStorage.removeItem(PREFIX + storageKey);
        } catch {
          // storage unavailable
        }
      }}
    >
      <summary>{summary}</summary>
      {children}
    </details>
  );
}
