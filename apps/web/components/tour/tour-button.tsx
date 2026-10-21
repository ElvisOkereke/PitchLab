'use client';

import { useTour } from './tour-provider';

/** Header control that opens the chapter picker. A dot shows when the tour has new steps since the user last saw it. */
export function TourButton() {
  const { openPicker, newSteps } = useTour();
  return (
    <button type="button" className="secondary tour-button" aria-haspopup="dialog" onClick={openPicker}>
      Take the tour
      {newSteps ? (
        <>
          <span className="tour-dot" aria-hidden="true" />
          <span className="visually-hidden"> (new steps)</span>
        </>
      ) : null}
    </button>
  );
}
