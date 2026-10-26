'use client';

import { useActionState } from 'react';
import { runBenchmarkAction } from '@/actions/bench';
import type { FormState } from '@/lib/form';

/** The Run benchmark button. Takes no input; a refusal shows as an alert. The cost note comes from the server page. */
export function RunBenchmarkForm({ costNote }: { costNote: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(runBenchmarkAction, {});
  return (
    <form action={formAction} data-testid="run-benchmark">
      <p>
        Queues 4 runs, <span>{costNote}</span>. Nothing is queued until you press the button.
      </p>
      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}
      <button type="submit" disabled={pending}>
        Run benchmark
      </button>
      <p className="muted small">
        Runs execute when <code>npm run worker</code> is running.
      </p>
    </form>
  );
}
