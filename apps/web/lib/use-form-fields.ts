import { useState } from 'react';
import type { FormState, FormValues } from './form';

/**
 * Field values for a `useActionState` form that survive React 19's automatic form reset.
 *
 * React resets a form after a function action, and a `<select>` (or a controlled field) then shows its original
 * default again, so a second save would silently send stale values. Here every field keeps its latest value in
 * state (seeded from the server's values and from `values` echoed in the action's FormState) and the form is
 * remounted with `key={formKey}` after each action result, so its defaults are always the latest values.
 * `clearOnSuccess` fields are emptied after a successful action (e.g. a note that was just recorded).
 */
export function useFormFields(initial: FormValues, state: FormState, o: { clearOnSuccess?: readonly string[] } = {}) {
  const [values, setValues] = useState<FormValues>(() => ({ ...initial, ...state.values }));
  const [seen, setSeen] = useState(state);
  const [formKey, setFormKey] = useState(0);
  if (state !== seen) {
    // Adjusting state while rendering (React's documented pattern for reacting to a changed value).
    setSeen(state);
    setFormKey((k) => k + 1);
    setValues((v) => {
      const next = { ...v, ...state.values };
      if (state.ok) for (const k of o.clearOnSuccess ?? []) next[k] = '';
      return next;
    });
  }
  const text = (name: string): string => {
    const v = values[name];
    return typeof v === 'string' ? v : '';
  };
  const list = (name: string): string[] => {
    const v = values[name];
    return Array.isArray(v) ? v : [];
  };
  const set = (name: string, value: string | string[]) => setValues((v) => ({ ...v, [name]: value }));
  const toggle = (name: string, item: string, on: boolean) =>
    setValues((v) => {
      const cur = Array.isArray(v[name]) ? (v[name] as string[]) : [];
      return { ...v, [name]: on ? [...cur.filter((x) => x !== item), item] : cur.filter((x) => x !== item) };
    });
  return { values, text, list, set, toggle, formKey };
}
