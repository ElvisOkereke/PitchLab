'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { startRunFromFindsAction } from '@/actions/finds';
import type { FormState } from '@/lib/form';

/** "Start a run from these finds": queues a run over the `count` most recent captured finds (the server picks and checks them). */
export function FindsRunForm({ count }: { count: number }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(startRunFromFindsAction, {});
  return (
    <form action={formAction} className="queue-form" data-testid="finds-run-form">
      <p className="muted">
        A run that uses your {count} most recent captured finds as proof that people pay, then looks for a better idea behind them. It
        researches the first three and shows up to six to the idea generator. It costs the same as any run.
      </p>
      <button type="submit" disabled={pending}>{pending ? 'Queueing…' : 'Start a run from these finds'}</button>
      {state.error ? <p role="alert" className="error">{state.error}</p> : null}
      {state.ok && state.notice ? (
        <p role="status">
          {state.notice} <Link href="/runs">Open Runs</Link>
        </p>
      ) : null}
    </form>
  );
}
