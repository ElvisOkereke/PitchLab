'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { queueValidationAction } from '@/actions/validation';
import type { FormState } from '@/lib/form';
import { useFormFields } from '@/lib/use-form-fields';

const CHECKS = [
  ['skipProspects', 'Skip new prospect search'],
  ['refresh', 'Refresh the pack documents'],
  ['redraft', 'Write the emails again'],
] as const;

/**
 * Queue a validation pack. Works without JS. When disabled (example case, or no sender yet) the form is replaced by
 * text. HTML limits mirror the server's (prospects 1–100); only the server is trusted.
 */
export function ValidationJobForm({
  caseId, slug, hasPack, isExample, senderMissing,
}: { caseId: string; slug: string; hasPack: boolean; isExample: boolean; senderMissing: boolean }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(queueValidationAction, {});
  const f = useFormFields({ prospects: '25', skipProspects: '', refresh: '', redraft: '' }, state);

  if (isExample) return <p className="card muted">Example data: already generated.</p>;
  if (senderMissing) {
    return (
      <p className="card">
        Set your name, mailing address and contact in Settings first. Every email must include them.{' '}
        <Link href="/settings">Open Settings</Link>
      </p>
    );
  }
  return (
    <form key={f.formKey} action={formAction} className="queue-form" data-testid="validation-job-form">
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="slug" value={slug} />
      <div>
        <label htmlFor="validation-prospects">Prospects to find</label>
        <input
          id="validation-prospects"
          type="number"
          name="prospects"
          min={1}
          max={100}
          step={1}
          inputMode="numeric"
          defaultValue={f.text('prospects')}
          onChange={(e) => f.set('prospects', e.target.value)}
        />
      </div>
      {CHECKS.map(([name, label]) => (
        <div key={name} className="choice">
          <input
            id={`validation-${name}`}
            type="checkbox"
            name={name}
            defaultChecked={f.text(name) === 'on'}
            onChange={(e) => f.set(name, e.target.checked ? 'on' : '')}
          />
          <label htmlFor={`validation-${name}`}>{label}</label>
        </div>
      ))}
      <button type="submit" disabled={pending} data-tour="validate-generate">
        {pending ? 'Queueing…' : hasPack ? 'Run validation again' : 'Generate validation pack'}
      </button>
      <p className="muted small">
        Uses about $0.60–1.50 of model calls (prospect search is about $0.45–0.60 of that). Runs when <code>npm run worker</code> is running.
        Files are also saved to output/validation/{slug}/ on the worker&apos;s computer.
      </p>
      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.ok ? (
        <p className="ok" role="status">
          Queued. It starts when <code>npm run worker</code> is running.
        </p>
      ) : null}
    </form>
  );
}
