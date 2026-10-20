'use client';

import { useActionState } from 'react';
import { saveSettingsAction } from '@/actions/settings';
import type { FormState } from '@/lib/form';

export type SettingField = { key: string; label: string; hint?: string; value: string };

/** The editable settings (sender identity, landing settings). Keys, labels and values come from the server. */
export function SettingsForm({ fields }: { fields: SettingField[] }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(saveSettingsAction, {});
  return (
    <form action={formAction} className="settings-form" data-testid="settings-form">
      {fields.map((f) => {
        const id = `setting-${f.key.replace(/\W/g, '-')}`;
        return (
          <div key={f.key} className="field">
            <label htmlFor={id}>{f.label}</label>
            <input id={id} type="text" name={f.key} defaultValue={f.value} maxLength={500} aria-describedby={f.hint ? `${id}-hint` : undefined} />
            {f.hint ? (
              <p id={`${id}-hint`} className="muted small">
                {f.hint}
              </p>
            ) : null}
          </div>
        );
      })}
      <button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save settings'}
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
