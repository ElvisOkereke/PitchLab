'use client';

import { useActionState } from 'react';
import { saveHoldoutAction } from '@/actions/settings';
import type { FormState } from '@/lib/form';
import { useFormFields } from '@/lib/use-form-fields';

/** The holdout examples, one per line. Saving replaces the list; saving it empty clears it. A refused save keeps what was typed. */
export function HoldoutForm({ items }: { items: string[] }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(saveHoldoutAction, {});
  const f = useFormFields({ holdout: items.join('\n') }, state);
  return (
    <form key={f.formKey} action={formAction} className="settings-form" data-testid="holdout-form">
      <div className="field">
        <label htmlFor="holdout-text">Examples (one per line, up to 10, at most 1,000 characters each)</label>
        <textarea
          id="holdout-text"
          name="holdout"
          rows={6}
          defaultValue={f.text('holdout')}
          onChange={(e) => f.set('holdout', e.target.value)}
        />
      </div>
      <button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save holdout examples'}
      </button>
      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p className="ok" role="status">
          Saved.
        </p>
      ) : null}
    </form>
  );
}
