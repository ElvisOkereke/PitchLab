'use client';

import { useActionState } from 'react';
import { saveSettingsAction } from '@/actions/settings';
import type { FormState } from '@/lib/form';
import { useFormFields } from '@/lib/use-form-fields';

export type SettingField = { key: string; label: string; hint?: string; value: string };

/**
 * The editable settings (sender identity, landing settings). Keys, labels and values come from the server. A refused
 * save keeps every typed value; a successful one shows the values as saved (useFormFields).
 */
export function SettingsForm({ fields }: { fields: SettingField[] }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(saveSettingsAction, {});
  const form = useFormFields(Object.fromEntries(fields.map((x) => [x.key, x.value])), state);
  return (
    <form key={form.formKey} action={formAction} className="settings-form" data-testid="settings-form">
      {fields.map((x) => {
        const id = `setting-${x.key.replace(/\W/g, '-')}`;
        return (
          <div key={x.key} className="field">
            <label htmlFor={id}>{x.label}</label>
            <input
              id={id}
              type="text"
              name={x.key}
              defaultValue={form.text(x.key)}
              onChange={(e) => form.set(x.key, e.target.value)}
              maxLength={500}
              aria-describedby={x.hint ? `${id}-hint` : undefined}
            />
            {x.hint ? (
              <p id={`${id}-hint`} className="muted small">
                {x.hint}
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
