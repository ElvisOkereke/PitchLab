/**
 * Web-safe and import-free: the assessment types, the strength rule and its labels. Re-exported by ./assessment, which
 * adds the database work (corroboration, refresh). Kept apart so the web bundle never pulls in the domain parser.
 */

export const DIRECTNESS = ['first_hand', 'customer_review', 'vendor', 'press', 'aggregate', 'official', 'unknown'] as const;
export type Directness = (typeof DIRECTNESS)[number];

export type Assessment = {
  directness: Directness;
  bias: string | null;
  strength: 1 | 2 | 3 | 4 | 5;
  why: string;
  /** Distinct registrable domains of other active entries at cosine 0.9 or more. */
  corroboration: number;
};

/** Source types whose entries come from an official or measured publisher (+1 strength). */
export const OFFICIAL_SOURCE_TYPES: readonly string[] = ['federalregister', 'worldbank', 'yc'];

export const STRENGTH_BASE = 3;
/** An entry whose newest source is older than this loses a point. */
export const STALE_DAYS = 730;
export const CORROBORATION_MIN = 2;
export const CORROBORATION_STRONG = 5;

export type StrengthInput = {
  voice: string | null;
  quoteVerified: boolean;
  corroboration: number;
  /** The newest source's date (published, else fetched); null when unknown (no age penalty). */
  fetchedAt: Date | null;
  sourceTypes: string[];
};

const clampStrength = (n: number): 1 | 2 | 3 | 4 | 5 => Math.min(5, Math.max(1, Math.round(n))) as 1 | 2 | 3 | 4 | 5;

/** Start from 3; operator or customer voice +1, vendor -1; verified quote +1; 2+ corroborating domains +1 (5+: +2); older than 730 days -1; official source type +1; clamp 1 to 5. */
export function computeStrength(i: StrengthInput, now: Date): 1 | 2 | 3 | 4 | 5 {
  let s = STRENGTH_BASE;
  if (i.voice === 'operator' || i.voice === 'customer') s += 1;
  else if (i.voice === 'vendor') s -= 1;
  if (i.quoteVerified) s += 1;
  if (i.corroboration >= CORROBORATION_STRONG) s += 2;
  else if (i.corroboration >= CORROBORATION_MIN) s += 1;
  if (i.fetchedAt && now.getTime() - i.fetchedAt.getTime() > STALE_DAYS * 86_400_000) s -= 1;
  if (i.sourceTypes.some((t) => OFFICIAL_SOURCE_TYPES.includes(t))) s += 1;
  return clampStrength(s);
}

/** Anything the model says outside the enum is `unknown`. */
export function normalizeDirectness(v: unknown): Directness {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (DIRECTNESS as readonly string[]).includes(t) ? (t as Directness) : 'unknown';
}

/** A stored assessment, or null when absent or malformed. Text fields are returned as plain strings (render them as text). */
export function parseAssessment(v: unknown): Assessment | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const strength = o.strength;
  if (typeof strength !== 'number' || !Number.isInteger(strength) || strength < 1 || strength > 5) return null;
  if (typeof o.why !== 'string') return null;
  return {
    directness: normalizeDirectness(o.directness),
    bias: typeof o.bias === 'string' && o.bias.trim() ? o.bias : null,
    strength: strength as Assessment['strength'],
    why: o.why,
    corroboration: typeof o.corroboration === 'number' && Number.isFinite(o.corroboration) ? Math.max(0, Math.floor(o.corroboration)) : 0,
  };
}

const DIRECTNESS_LABEL: Record<Directness, string> = {
  first_hand: 'first-hand', customer_review: 'customer review', vendor: 'vendor', press: 'press', aggregate: 'aggregate', official: 'official', unknown: '',
};

/** For example "strength 4/5, first-hand" ("strength 3/5" when the directness is unknown). Used by ideation, the judge and the web. */
export function strengthLabel(a: Assessment): string {
  const d = DIRECTNESS_LABEL[a.directness];
  return `strength ${a.strength}/5${d ? `, ${d}` : ''}`;
}
