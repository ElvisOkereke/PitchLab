import { z } from 'zod';

export const CASE_TABS = ['summary', 'evidence', 'numbers', 'competitors', 'pitch', 'validate', 'score'] as const;
export type CaseTab = (typeof CASE_TABS)[number];

export const CASE_TAB_LABEL: Record<CaseTab, string> = {
  summary: 'Summary',
  evidence: 'Evidence',
  numbers: 'Numbers',
  competitors: 'Competitors',
  pitch: 'Pitch',
  validate: 'Validate',
  score: 'Score',
};

/** One-off messages the case page may show (allow-listed; the query value is only a key). */
export const CASE_NOTICES = {
  overturn_refused: 'That case is no longer killed, so there was nothing to overturn.',
} as const;
export type CaseNotice = keyof typeof CASE_NOTICES;

const PAGE_MAX = 1_000_000;
const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);

/** A page number from a query value: whole numbers only, clamped to 1…1,000,000; anything else → 1. */
export function pageParam(v: unknown): number {
  const s = first(v);
  if (typeof s !== 'string' || !/^\d{1,15}$/.test(s)) return 1;
  return Math.min(Math.max(Number(s), 1), PAGE_MAX);
}

const CaseQuerySchema = z.object({
  tab: z.preprocess(first, z.enum(CASE_TABS)).catch('summary'),
  page: z.unknown().optional().transform(pageParam),
  notice: z.preprocess(first, z.enum(Object.keys(CASE_NOTICES) as [CaseNotice, ...CaseNotice[]]).optional()).catch(undefined),
});
export type CaseQuery = { tab: CaseTab; page: number; notice?: CaseNotice };

/** `?tab=&page=&notice=`; anything invalid falls back (tab → summary, page → 1, notice → none). */
export function parseCaseQuery(sp: Record<string, string | string[] | undefined>): CaseQuery {
  const q = CaseQuerySchema.parse(sp);
  return q.notice ? { tab: q.tab, page: q.page, notice: q.notice } : { tab: q.tab, page: q.page };
}

/** A case tab URL (Summary carries no tab parameter; page only when > 1). */
export function caseHref(slug: string, tab: CaseTab = 'summary', page = 1): string {
  const p = new URLSearchParams();
  if (tab !== 'summary') p.set('tab', tab);
  if (page > 1) p.set('page', String(page));
  const s = p.toString();
  return `/cases/${encodeURIComponent(slug)}${s ? `?${s}` : ''}`;
}
