'use client';

import Link from 'next/link';

/** A tab that throws (e.g. a legacy case row) shows a fixed message: no error text, no stack trace. */
export default function CaseError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="case-page" data-render-error="">
      <p className="error card" role="alert">
        This tab could not be rendered.
      </p>
      <p>
        <button type="button" className="secondary" onClick={() => reset()}>
          Try again
        </button>{' '}
        <Link href="/">Back to the board</Link>
      </p>
    </main>
  );
}
