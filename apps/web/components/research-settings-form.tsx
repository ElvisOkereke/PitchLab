'use client';

import { useActionState } from 'react';
import { saveResearchSettingsAction } from '@/actions/library';
import type { FormState } from '@/lib/form';
import { useFormFields } from '@/lib/use-form-fields';

/** Background research on or off and its daily cap. Shows the values as saved; a refused save keeps what was typed. */
export function ResearchSettingsForm({ background, dailyCapUsd }: { background: boolean; dailyCapUsd: number }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(saveResearchSettingsAction, {});
  const f = useFormFields({ background: background ? 'on' : 'off', dailyCapUsd: String(dailyCapUsd) }, state);
  return (
    <form key={f.formKey} action={formAction} className="settings-form" data-testid="research-settings">
      <div className="choice">
        <input
          id="research-background"
          type="checkbox"
          name="background"
          defaultChecked={f.text('background') === 'on'}
          onChange={(e) => f.set('background', e.target.checked ? 'on' : 'off')}
        />
        <label htmlFor="research-background">Background research</label>
      </div>
      <div className="field">
        <label htmlFor="research-cap">Daily cap (US dollars, 0 to 50)</label>
        <input
          id="research-cap"
          type="number"
          name="dailyCapUsd"
          min={0}
          max={50}
          step={0.5}
          inputMode="decimal"
          defaultValue={f.text('dailyCapUsd')}
          onChange={(e) => f.set('dailyCapUsd', e.target.value)}
        />
      </div>
      {f.text('dailyCapUsd').trim() !== '' && Number(f.text('dailyCapUsd')) < 1 ? (
        <p className="muted small" data-testid="research-cap-note">
          Background research needs a cap of at least $1.
        </p>
      ) : null}
      <button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save research settings'}
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
