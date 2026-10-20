'use client';

import { useActionState } from 'react';
import { markOutreachAction } from '@/actions/outreach';
import type { FormState } from '@/lib/form';

const TYPES = [
  ['sent', 'I sent it'],
  ['replied', 'They replied'],
  ['positive', 'Positive reply'],
  ['meeting', 'Meeting booked'],
  ['not_interested', 'Not interested'],
  ['unsubscribe', 'Unsubscribe'],
] as const;

/** Log what happened with one prospect (the owner sends email himself; this only records it). Works without JS. */
export function MarkOutreachForm({ prospectId, slug }: { prospectId: string; slug: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(markOutreachAction, {});
  return (
    <form action={formAction} className="mark-outreach" data-testid="mark-outreach">
      <input type="hidden" name="prospectId" value={prospectId} />
      <input type="hidden" name="slug" value={slug} />
      <label htmlFor={`type-${prospectId}`}>What happened</label>
      <select id={`type-${prospectId}`} name="type" defaultValue="sent">
        {TYPES.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <label htmlFor={`mnote-${prospectId}`}>Note (optional)</label>
      <input id={`mnote-${prospectId}`} type="text" name="note" maxLength={500} />
      <button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Record'}
      </button>
      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p className="ok" role="status">
          Recorded.
        </p>
      ) : null}
    </form>
  );
}
