'use client';

import { useActionState } from 'react';
import { recomputePassAction } from '@/actions/bench';
import type { FormState } from '@/lib/form';

/** The Recompute button under a pass column: freezes a new snapshot with today's data, so new gut scores count. */
export function RecomputeForm({ passId }: { passId: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(recomputePassAction, {});
  return (
    <form action={formAction} data-testid="recompute">
      <input type="hidden" name="passId" value={passId} />
      {state.error ? (
        <p className="error small" role="alert">
          {state.error}
        </p>
      ) : null}
      <button type="submit" disabled={pending}>
        Recompute
      </button>
    </form>
  );
}
