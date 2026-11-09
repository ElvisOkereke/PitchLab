'use client';

import { useActionState } from 'react';
import { addFindsAction } from '@/actions/finds';
import type { FormState } from '@/lib/form';
import { useFormFields } from '@/lib/use-form-fields';

/** The paste box: one link per line, an optional note after the first space. A refused paste keeps what was typed. */
export function FindsPasteForm() {
  const [state, formAction, pending] = useActionState<FormState, FormData>(addFindsAction, {});
  const f = useFormFields({ links: '' }, state, { clearOnSuccess: ['links'] });
  return (
    <form key={f.formKey} action={formAction} className="queue-form" data-testid="finds-paste-form">
      <div className="field">
        <label htmlFor="finds-links">Links (one per line, a note after the first space is optional)</label>
        <textarea
          id="finds-links"
          name="links"
          rows={5}
          maxLength={100000}
          required
          placeholder="https://www.tiktok.com/@someone/video/123 idea for plumbers"
          defaultValue={f.text('links')}
          onChange={(e) => f.set('links', e.target.value)}
        />
        <p className="muted">Up to 50 links at a time. Only http and https links.</p>
      </div>
      <button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Add to finds'}</button>
      {state.error ? <p role="alert" className="error">{state.error}</p> : null}
      {state.ok && state.notice ? <p role="status">{state.notice}</p> : null}
    </form>
  );
}
