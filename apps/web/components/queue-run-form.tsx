'use client';

import { useActionState, useEffect, useState } from 'react';
import { queueRunAction } from '@/actions/runs';
import type { FormState } from '@/lib/form';
import { useFormFields } from '@/lib/use-form-fields';
import { HelpTip } from './help-tip';

type Seed = 'open' | 'sector' | 'lens' | 'idea';

const SEEDS: { value: Seed; label: string; hint: string }[] = [
  { value: 'open', label: 'Open', hint: 'Let the generator look across every sector.' },
  { value: 'sector', label: 'Sectors', hint: 'Only the sectors you tick.' },
  { value: 'lens', label: 'Lenses', hint: 'Only the idea patterns you tick.' },
  { value: 'idea', label: 'Your idea', hint: 'Build a case for an idea you describe.' },
];
const isSeed = (v: string): v is Seed => SEEDS.some((s) => s.value === v);

/**
 * Queue a run. HTML limits mirror the server's (ideas 1–30, advance 1–10, idea text ≤ 20,000), but only the server is
 * trusted. Without JS every seed's fields are shown (the server ignores the ones the chosen seed does not use); with JS
 * only the chosen seed's fields are shown. Sectors and lenses come from the server as props (no core import here).
 * A refused run keeps everything the owner entered (useFormFields).
 */
export function QueueRunForm({ sectors, lenses }: { sectors: string[]; lenses: { id: string; name: string }[] }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(queueRunAction, {});
  const f = useFormFields({ seedType: 'open', sectors: [], lensIds: [], ideaText: '', ideaCount: '12', advanceCount: '3' }, state);
  const seed: Seed = isSeed(f.text('seedType')) ? (f.text('seedType') as Seed) : 'open';
  const [js, setJs] = useState(false);
  useEffect(() => setJs(true), []);
  const shown = (s: Seed) => !js || seed === s;

  return (
    <form key={f.formKey} action={formAction} className="queue-form" data-testid="queue-run">
      <fieldset className="seed-choice">
        <legend>
          Seed <HelpTip term="seed" />
        </legend>
        {SEEDS.map((s) => (
          <div key={s.value} className="choice">
            <input
              id={`seed-${s.value}`}
              type="radio"
              name="seedType"
              value={s.value}
              defaultChecked={seed === s.value}
              onChange={() => f.set('seedType', s.value)}
            />
            <label htmlFor={`seed-${s.value}`}>{s.label}</label>
            <span className="muted small"> {s.hint}</span>
          </div>
        ))}
      </fieldset>

      <fieldset hidden={!shown('sector')} disabled={!shown('sector')} data-seed="sector">
        <legend>
          Sectors (for “Sectors”) <HelpTip term="sector" />
        </legend>
        <div className="checks">
          {sectors.map((s, i) => (
            <div key={s} className="choice">
              <input
                id={`sector-${i}`}
                type="checkbox"
                name="sectors"
                value={s}
                defaultChecked={f.list('sectors').includes(s)}
                onChange={(e) => f.toggle('sectors', s, e.target.checked)}
              />
              <label htmlFor={`sector-${i}`}>{s}</label>
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset hidden={!shown('lens')} disabled={!shown('lens')} data-seed="lens">
        <legend>
          Lenses (for “Lenses”) <HelpTip term="lens" />
        </legend>
        <div className="checks">
          {lenses.map((l) => (
            <div key={l.id} className="choice">
              <input
                id={`lens-${l.id}`}
                type="checkbox"
                name="lensIds"
                value={l.id}
                defaultChecked={f.list('lensIds').includes(l.id)}
                onChange={(e) => f.toggle('lensIds', l.id, e.target.checked)}
              />
              <label htmlFor={`lens-${l.id}`}>{l.name}</label>
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset hidden={!shown('idea')} disabled={!shown('idea')} data-seed="idea">
        <legend>Idea (for “Your idea”)</legend>
        <label htmlFor="idea-text">Describe the idea (at least 50 characters)</label>
        <textarea
          id="idea-text"
          name="ideaText"
          maxLength={20_000}
          rows={6}
          defaultValue={f.text('ideaText')}
          onChange={(e) => f.set('ideaText', e.target.value)}
        />
      </fieldset>

      <div className="counts">
        <div>
          <div className="label-row">
            <label htmlFor="idea-count">Ideas to generate</label>
            <HelpTip term="ideaCount" />
          </div>
          <input
            id="idea-count"
            type="number"
            name="ideaCount"
            min={1}
            max={30}
            step={1}
            inputMode="numeric"
            defaultValue={f.text('ideaCount')}
            onChange={(e) => f.set('ideaCount', e.target.value)}
          />
        </div>
        <div>
          <div className="label-row">
            <label htmlFor="advance-count">Ideas to turn into cases</label>
            <HelpTip term="advanceCount" />
          </div>
          <input
            id="advance-count"
            type="number"
            name="advanceCount"
            min={1}
            max={10}
            step={1}
            inputMode="numeric"
            defaultValue={f.text('advanceCount')}
            onChange={(e) => f.set('advanceCount', e.target.value)}
          />
        </div>
      </div>

      <button type="submit" disabled={pending}>
        {pending ? 'Queueing…' : 'Queue run'}
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
