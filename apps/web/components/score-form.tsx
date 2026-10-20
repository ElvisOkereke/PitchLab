'use client';

import { useActionState } from 'react';
import { saveOwnerScoresAction } from '@/actions/scores';
import type { FormState } from '@/lib/form';

export type ScoreFormRow = { criterion: string; label: string; value: number | null; note: string };

const VALUES = [1, 2, 3, 4, 5];

/**
 * The owner's scores: one row per criterion (7 + "Your gut"), each a 1–5 select (blank = keep as is) and a note.
 * Labels and current values come from the server, so this client component imports nothing from core.
 */
export function ScoreForm({ caseId, slug, rows }: { caseId: string; slug: string; rows: ScoreFormRow[] }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(saveOwnerScoresAction, {});
  return (
    <form action={formAction} className="score-form" data-testid="score-form">
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="slug" value={slug} />
      {rows.map((r) => (
        <fieldset key={r.criterion} className="score-row card">
          <legend>{r.label}</legend>
          <label htmlFor={`value-${r.criterion}`}>Score</label>
          <select id={`value-${r.criterion}`} name={`value_${r.criterion}`} defaultValue={r.value === null ? '' : String(r.value)}>
            <option value="">–</option>
            {VALUES.map((v) => (
              <option key={v} value={String(v)}>
                {v}
              </option>
            ))}
          </select>
          <label htmlFor={`note-${r.criterion}`}>Note</label>
          <textarea id={`note-${r.criterion}`} name={`note_${r.criterion}`} maxLength={1000} rows={2} defaultValue={r.note} />
        </fieldset>
      ))}
      <p className="muted small">Leave a score blank to keep it as it is.</p>
      <button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save my scores'}
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
