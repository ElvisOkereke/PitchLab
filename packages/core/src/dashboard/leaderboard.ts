import { desc } from 'drizzle-orm';
import { z } from 'zod';
import type { Criterion } from '../case/schema';
import type { Db } from '../db/client';
import { cases, type CaseStage } from '../db/schema';
import { OWNER_CRITERIA, latestScoreRows, scoreSummary, type OwnerCriterion } from './criteria';

/** Most cases on the leaderboard (newest-updated first). */
export const LEADERBOARD_LIMIT = 500;

export type LeaderRow = {
  slug: string;
  title: string;
  stage: CaseStage;
  isExample: boolean;
  ai: Partial<Record<Criterion, number>>;
  owner: Partial<Record<OwnerCriterion, number>>;
  aiTotal: number | null;
  ownerTotal: number | null;
};

const DEFAULT_SORT = { key: 'ai', by: 'ai', dir: 'desc' } as const;

/** Sort keys go through an allowlist: anything unknown falls back to AI total, descending. */
export const LeaderSortSchema = z.object({
  key: z.enum(['ai', 'owner', 'title', ...OWNER_CRITERIA]).catch('ai'),
  by: z.enum(['ai', 'owner']).catch('ai'),
  dir: z.enum(['asc', 'desc']).catch('desc'),
}).catch({ ...DEFAULT_SORT });
export type LeaderSort = z.infer<typeof LeaderSortSchema>;

/** Every case (up to LEADERBOARD_LIMIT) with its latest AI and owner score per criterion and both means. */
export async function listLeaderboard(db: Db): Promise<LeaderRow[]> {
  const rows = await db.select({ id: cases.id, slug: cases.slug, title: cases.title, stage: cases.stage, isExample: cases.isExample })
    .from(cases)
    .orderBy(desc(cases.updatedAt), cases.slug)
    .limit(LEADERBOARD_LIMIT);
  const scoreRows = await latestScoreRows(db, rows.map((r) => r.id));
  const byCase = new Map<string, typeof scoreRows>();
  for (const s of scoreRows) {
    const list = byCase.get(s.caseId) ?? [];
    list.push(s);
    byCase.set(s.caseId, list);
  }
  return rows.map((r) => {
    const sum = scoreSummary(byCase.get(r.id) ?? []);
    const ai: LeaderRow['ai'] = {};
    const owner: LeaderRow['owner'] = {};
    for (const c of OWNER_CRITERIA) {
      const e = sum.latest[c];
      if (e?.ai && c !== 'gut') ai[c] = e.ai.value;
      if (e?.owner) owner[c] = e.owner.value;
    }
    return { slug: r.slug, title: r.title, stage: r.stage, isExample: r.isExample, ai, owner, aiTotal: sum.ai, ownerTotal: sum.owner };
  });
}

function valueOf(r: LeaderRow, s: LeaderSort): number | string | null {
  if (s.key === 'title') return r.title;
  if (s.key === 'ai') return r.aiTotal;
  if (s.key === 'owner') return r.ownerTotal;
  if (s.key === 'gut' || s.by === 'owner') return r.owner[s.key] ?? null;
  return r.ai[s.key] ?? null;
}

/** A sorted copy: nulls last in both directions; ties keep title order. */
export function sortLeaderboard(rows: LeaderRow[], s: LeaderSort): LeaderRow[] {
  const sign = s.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = valueOf(a, s);
    const vb = valueOf(b, s);
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1;
    } else {
      const d = typeof va === 'string' ? va.localeCompare(vb as string) : va - (vb as number);
      if (d !== 0) return sign * d;
    }
    return a.title.localeCompare(b.title);
  });
}
