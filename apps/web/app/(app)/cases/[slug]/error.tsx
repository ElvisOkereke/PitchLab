'use client';

import Link from 'next/link';

/**
 * Anything that throws on the case page (a tab that cannot render a legacy row, or a failed action) shows a fixed,
 * neutral message: no error text, no stack trace.
 */
export default function CaseError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="case-page" data-render-error="">
      <p className="error card" role="alert">
        Something went wrong on this case page. Reload or go back to the board.
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
