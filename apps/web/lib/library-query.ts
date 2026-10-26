import type { LibraryFilter } from '@bcg/core/library/store';
import { z } from 'zod';
import { pageParam } from './case-query';

// Allow-lists for the query string (plain literals; the values mirror the core enums).
export const LIBRARY_KINDS = ['problem', 'startup', 'pricing', 'trend', 'rule_change', 'market'] as const;
export const LIBRARY_AUDIENCES = ['business', 'consumer', 'both'] as const;
export const LIBRARY_VOICES = ['operator', 'neutral', 'vendor'] as const;
export const LIBRARY_STATUSES = ['active', 'rejected', 'all'] as const;
export const LIBRARY_AGES = [7, 30, 90, 365] as const;
export type LibraryAge = (typeof LIBRARY_AGES)[number];

export type LibraryQuery = {
  q: string;
  kind?: (typeof LIBRARY_KINDS)[number];
  audience?: (typeof LIBRARY_AUDIENCES)[number];
  country?: string;
  voice?: (typeof LIBRARY_VOICES)[number];
  source?: string;
  age?: LibraryAge;
  status: (typeof LIBRARY_STATUSES)[number];
  page: number;
  item?: string;
};

const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
const opt = <T extends z.ZodType>(s: T) => z.preprocess(first, s.optional()).catch(undefined);

const Schema = z.object({
  q: z.preprocess(first, z.string().trim().transform((s) => s.slice(0, 100))).catch(''),
  kind: opt(z.enum(LIBRARY_KINDS)),
  audience: opt(z.enum(LIBRARY_AUDIENCES)),
  country: opt(z.string().trim().regex(/^[A-Za-z]{2}$/).transform((s) => s.toUpperCase())),
  voice: opt(z.enum(LIBRARY_VOICES)),
  source: opt(z.string().regex(/^[a-z0-9_-]{1,40}$/)),
  age: opt(z.string().regex(/^(7|30|90|365)$/).transform((s) => Number(s) as LibraryAge)),
  status: z.preprocess(first, z.enum(LIBRARY_STATUSES)).catch('active'),
  page: z.unknown().optional().transform(pageParam),
  item: opt(z.uuid()),
});

/** `?q=&kind=&audience=&country=&voice=&source=&age=&status=&page=&item=`: anything invalid is dropped. */
export function parseLibraryQuery(sp: Record<string, string | string[] | undefined>): LibraryQuery {
  const p = Schema.parse(sp);
  const out: LibraryQuery = { q: p.q, status: p.status, page: p.page };
  if (p.kind) out.kind = p.kind;
  if (p.audience) out.audience = p.audience;
  if (p.country) out.country = p.country;
  if (p.voice) out.voice = p.voice;
  if (p.source) out.source = p.source;
  if (p.age) out.age = p.age;
  if (p.item) out.item = p.item;
  return out;
}

/** The Library URL for a query (defaults are left out). */
export function libraryHref(q: LibraryQuery): string {
  const p = new URLSearchParams();
  if (q.q) p.set('q', q.q);
  for (const k of ['kind', 'audience', 'country', 'voice', 'source'] as const) if (q[k]) p.set(k, q[k]!);
  if (q.age) p.set('age', String(q.age));
  if (q.status !== 'active') p.set('status', q.status);
  if (q.page > 1) p.set('page', String(q.page));
  if (q.item) p.set('item', q.item);
  const s = p.toString();
  return s ? `/library?${s}` : '/library';
}

/** The core search filter for a query (the text box is a plain substring search; semantic search is not on the page). */
export function libraryFilter(q: LibraryQuery): LibraryFilter {
  const f: LibraryFilter = { status: q.status, page: q.page };
  if (q.q) f.text = q.q;
  if (q.kind) f.kinds = [q.kind];
  if (q.audience) f.audience = q.audience;
  if (q.country) f.country = q.country;
  if (q.voice) f.voice = q.voice;
  if (q.source) f.sourceType = q.source;
  if (q.age) f.maxAgeDays = q.age;
  return f;
}
