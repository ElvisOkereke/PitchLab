/** Field values echoed back to a form (strings, or string lists for checkbox groups). */
export type FormValues = Record<string, string | string[]>;

/**
 * What every `useActionState` Server Action returns. `values` echoes the submitted fields (allow-listed, capped) so
 * the form can show them again: after an error nothing typed is lost, also without JS. `notice` is a neutral message
 * for an `ok` result that changed nothing (e.g. "Already logged.").
 */
export type FormState = { ok?: boolean; error?: string; notice?: string; values?: FormValues };

const ECHO_MAX = 20_000;

/**
 * The listed fields of a parsed form as FormValues: strings capped at 20,000 chars, `arrays` fields as lists. An empty
 * list is not echoed: an unticked checkbox group and one inside a disabled (hidden) fieldset both submit nothing, so
 * "nothing submitted" must not overwrite ticks the form still holds.
 */
export function pickValues(raw: Record<string, unknown>, keys: readonly string[], arrays: readonly string[] = []): FormValues {
  const out: FormValues = {};
  const cap = (v: unknown) => (typeof v === 'string' ? v.slice(0, ECHO_MAX) : undefined);
  for (const k of keys) {
    const v = raw[k];
    if (arrays.includes(k)) {
      const list = (Array.isArray(v) ? v : v === undefined ? [] : [v]).map(cap).filter((x): x is string => x !== undefined);
      if (list.length > 0) out[k] = list;
    } else {
      const s = cap(Array.isArray(v) ? v[0] : v);
      if (s !== undefined) out[k] = s;
    }
  }
  return out;
}

/**
 * FormData as a plain object for zod: strings trimmed, repeated keys become arrays, keys listed in `arrays` are always
 * arrays (empty when absent). Files and Next's internal `$ACTION…` fields are skipped.
 */
export function formToObject(fd: FormData, arrays: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = Object.fromEntries(arrays.map((k) => [k, [] as string[]]));
  const forceArray = new Set(arrays);
  for (const [key, value] of fd.entries()) {
    if (typeof value !== 'string' || key.startsWith('$ACTION')) continue;
    const v = value.trim();
    const prev = out[key];
    if (forceArray.has(key)) (prev as string[]).push(v);
    else if (prev === undefined) out[key] = v;
    else out[key] = Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return out;
}

/** A whole number from a form value (`'12'`, `' -3 '`, `7`), else undefined. */
export function toInt(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : undefined;
  if (typeof v !== 'string' || !/^\s*-?\d{1,15}\s*$/.test(v)) return undefined;
  return Number(v.trim());
}
