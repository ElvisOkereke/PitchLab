'use client';

import { useActionState } from 'react';
import { queueMissionAction } from '@/actions/library';
import type { FormState } from '@/lib/form';
import { usd } from '@/lib/time';
import { useFormFields } from '@/lib/use-form-fields';

// Plain copies of core's mission limits and kinds (MissionInputSchema, SLICE_A_KINDS): core's missions module pulls in
// drizzle, which must stay out of client bundles. The server re-checks every value.
const KINDS = [
  { value: 'problem', label: 'Problems' },
  { value: 'startup', label: 'Startups' },
  { value: 'pricing', label: 'Pricing' },
] as const;
const BUDGET = { min: 0.5, max: 10, step: 0.5, initial: '2' } as const;

/** Start a research mission. A refused mission keeps everything typed (useFormFields). */
export function MissionForm({ typicalCost }: { typicalCost: number | null }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(queueMissionAction, {});
  const f = useFormFields({ topic: '', kinds: KINDS.map((k) => k.value), countries: '', audience: '', budgetUsd: BUDGET.initial }, state);
  const budget = Number(f.text('budgetUsd'));
  const shownBudget = Number.isFinite(budget) && budget >= BUDGET.min && budget <= BUDGET.max ? budget : Number(BUDGET.initial);
  return (
    <form key={f.formKey} action={formAction} className="queue-form" data-testid="mission-form">
      <div className="field">
        <label htmlFor="mission-topic">Topic</label>
        <input
          id="mission-topic"
          type="text"
          name="topic"
          maxLength={200}
          required
          placeholder="for example: late payments in small trades businesses"
          defaultValue={f.text('topic')}
          onChange={(e) => f.set('topic', e.target.value)}
        />
      </div>
      <fieldset>
        <legend>What to collect</legend>
        <div className="checks">
          {KINDS.map((k) => (
            <div key={k.value} className="choice">
              <input
                id={`mission-kind-${k.value}`}
                type="checkbox"
                name="kinds"
                value={k.value}
                defaultChecked={f.list('kinds').includes(k.value)}
                onChange={(e) => f.toggle('kinds', k.value, e.target.checked)}
              />
              <label htmlFor={`mission-kind-${k.value}`}>{k.label}</label>
            </div>
          ))}
        </div>
      </fieldset>
      <div className="counts">
        <div>
          <label htmlFor="mission-countries">Countries (optional)</label>
          <input
            id="mission-countries"
            type="text"
            name="countries"
            placeholder="CA, US, global"
            defaultValue={f.text('countries')}
            onChange={(e) => f.set('countries', e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="mission-audience">Audience</label>
          <select id="mission-audience" name="audience" defaultValue={f.text('audience')} onChange={(e) => f.set('audience', e.target.value)}>
            <option value="">Any</option>
            <option value="business">Business</option>
            <option value="consumer">Consumer</option>
            <option value="both">Both</option>
          </select>
        </div>
        <div>
          <label htmlFor="mission-budget">Budget (US dollars)</label>
          <input
            id="mission-budget"
            type="number"
            name="budgetUsd"
            min={BUDGET.min}
            max={BUDGET.max}
            step={BUDGET.step}
            inputMode="decimal"
            defaultValue={f.text('budgetUsd')}
            onChange={(e) => f.set('budgetUsd', e.target.value)}
          />
        </div>
      </div>
      <p className="muted small" data-testid="mission-cost">
        This mission costs up to {usd(shownBudget)} in model and data calls.
        {typicalCost === null ? '' : ` Typical cost of recent missions: ${usd(typicalCost)}.`}
      </p>
      <button type="submit" disabled={pending}>
        {pending ? 'Starting…' : 'Start research mission'}
      </button>
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
