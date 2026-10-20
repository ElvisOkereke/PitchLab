'use server';

import { CASE_SLUG } from '@bcg/core/dashboard/case-view';
import { CRITERION_LABEL, OWNER_CRITERIA } from '@bcg/core/dashboard/criteria';
import { OwnerScoresInputSchema, saveOwnerScores } from '@bcg/core/dashboard/scores';
import { revalidatePath } from 'next/cache';
import { requireOwnerAction } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';
import { formToObject, toInt, type FormState } from '@/lib/form';

/** The first problem of a failed parse as a message the owner can act on (never zod's own text). */
function issueMessage(issues: { path: PropertyKey[]; code: string }[]): string {
  const i = issues[0]!;
  if (i.path[0] === 'caseId') return 'Invalid request. Refresh and try again.';
  if (i.path[0] === 'entries' && i.path.length === 1) return 'Score at least one criterion.';
  if (i.path.at(-1) === 'note') return 'Notes are at most 1000 characters.';
  return 'Scores are whole numbers from 1 to 5.';
}

/**
 * Saves the owner's scores from the Score tab: `value_<criterion>` (blank = leave that criterion as it is) and
 * `note_<criterion>`, for the 7 criteria plus "Your gut". Only submitted criteria replace their earlier owner row.
 */
export async function saveOwnerScoresAction(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireOwnerAction();
  const raw = formToObject(fd);
  const entries: { criterion: (typeof OWNER_CRITERIA)[number]; value: number; note: string }[] = [];
  for (const c of OWNER_CRITERIA) {
    const value = raw[`value_${c}`];
    const note = typeof raw[`note_${c}`] === 'string' ? (raw[`note_${c}`] as string) : '';
    if (value === undefined || value === '') {
      if (note !== '') return { error: `Pick a score for “${CRITERION_LABEL[c]}” or clear its note.` };
      continue;
    }
    entries.push({ criterion: c, value: toInt(value) ?? Number.NaN, note });
  }
  const parsed = OwnerScoresInputSchema.safeParse({ caseId: raw.caseId, entries });
  if (!parsed.success) return { error: issueMessage(parsed.error.issues) };
  const r = await saveOwnerScores(getDb(), parsed.data);
  if (!r.ok) return { error: 'This case no longer exists. Refresh.' };
  revalidatePath('/');
  revalidatePath('/leaderboard');
  revalidatePath('/command');
  if (typeof raw.slug === 'string' && CASE_SLUG.test(raw.slug)) revalidatePath(`/cases/${raw.slug}`);
  return { ok: true };
}
