/** What every `useActionState` Server Action returns. */
export type FormState = { ok?: boolean; error?: string };

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
