/**
 * Parsing helpers shared by the generation stages (ideate, sketch): conservative repairs applied to model output
 * before validation, and the drop-reason summary. Web-safe: no imports.
 */

/** Plain object copy, or null. */
export const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : null;

/** A cited id as written: trimmed, surrounding square brackets removed, lower case. */
export const bareId = (s: string) => s.trim().replace(/^\[\s*(.*?)\s*\]$/, '$1').toLowerCase();

/** Spellings the model uses for an allowed enum value (spec §2); only applied when the target is allowed for the field. */
const ENUM_SYNONYMS: Record<string, string> = {
  one_time: 'one_off', 'one-time': 'one_off', 'one time': 'one_off',
  'service plus software': 'service_plus_software', 'service+software': 'service_plus_software', 'service + software': 'service_plus_software',
  consumers: 'consumer', individual: 'consumer',
  businesses: 'business', b2b: 'business',
};

/**
 * An enum value trimmed and lower-cased, matched as is, through the synonym list, or with spaces and hyphens read as
 * underscores (`"One-off"`, `"Transaction fee"`). An unknown value is returned unchanged, so a strict field still fails.
 */
export function enumValue(v: unknown, allowed: readonly string[]): unknown {
  if (typeof v !== 'string') return v;
  const s = v.trim().toLowerCase();
  const hit = [s, ENUM_SYNONYMS[s], s.replace(/[\s-]+/g, '_')].find((c) => c !== undefined && allowed.includes(c));
  return hit ?? v;
}

/** `a ×2, b ×1`: the most frequent drop reasons first (ties by name), at most `max`. */
export function topReasons(reasons: Record<string, number>, max = 3): string {
  return Object.entries(reasons)
    .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, max)
    .map(([k, n]) => `${k} ×${n}`)
    .join(', ');
}
