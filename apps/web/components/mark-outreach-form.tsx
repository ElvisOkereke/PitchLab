'use client';

import { useActionState } from 'react';
import { markOutreachAction } from '@/actions/outreach';
import type { FormState } from '@/lib/form';
import { useFormFields } from '@/lib/use-form-fields';

const TYPES = [
  ['sent', 'I sent it'],
  ['replied', 'They replied'],
  ['positive', 'Positive reply'],
  ['meeting', 'Meeting booked'],
  ['not_interested', 'Not interested'],
  ['unsubscribe', 'Unsubscribe'],
  // Logged as a `note` event starting "interview:" (added on the server), which the checklist counts as an interview.
  ['note', 'Interview note'],
] as const;

/**
 * Log what happened with one prospect (the owner sends email himself; this only records it). Works without JS. An
 * error keeps the choice and the note; a success clears the note so it is not recorded twice.
 */
export function MarkOutreachForm({ prospectId, slug }: { prospectId: string; slug: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(markOutreachAction, {});
  const f = useFormFields({ type: 'sent', note: '' }, state, { clearOnSuccess: ['note'] });
  const interview = f.text('type') === 'note';
  return (
    <form key={f.formKey} action={formAction} className="mark-outreach" data-testid="mark-outreach">
      <input type="hidden" name="prospectId" value={prospectId} />
      <input type="hidden" name="slug" value={slug} />
      <label htmlFor={`type-${prospectId}`}>What happened</label>
      <select id={`type-${prospectId}`} name="type" defaultValue={f.text('type')} onChange={(e) => f.set('type', e.target.value)}>
        {TYPES.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <label htmlFor={`mnote-${prospectId}`}>{interview ? 'What you learned (required)' : 'Note (optional)'}</label>
      <input
        id={`mnote-${prospectId}`}
        type="text"
        name="note"
        maxLength={500}
        required={interview}
        defaultValue={f.text('note')}
        onChange={(e) => f.set('note', e.target.value)}
      />
      <button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Record'}
      </button>
      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p className={state.notice ? 'muted' : 'ok'} role="status">
          {state.notice ?? 'Recorded.'}
        </p>
      ) : null}
    </form>
  );
}
