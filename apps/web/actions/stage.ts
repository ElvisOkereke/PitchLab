'use server';

import { CASE_SLUG } from '@bcg/core/dashboard/case-view';
import { queueGateKillRerun } from '@bcg/core/dashboard/runs';
import { MoveStageInputSchema, moveStage, type MoveStageResult } from '@bcg/core/dashboard/stage';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireOwnerAction } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';
import { formToObject, type FormState } from '@/lib/form';

const REFUSAL: Record<Extract<MoveStageResult, { ok: false }>['reason'], string> = {
  stale: 'This case moved since you loaded the page. Refresh.',
  not_found: 'This case no longer exists. Refresh.',
  same_stage: 'Pick a different stage.',
  note_required: 'Add a note saying why you are killing it.',
};

/** Revalidates the board and, when the slug is well formed, the case page. */
function revalidateCase(slug: unknown) {
  revalidatePath('/');
  if (typeof slug === 'string' && CASE_SLUG.test(slug)) revalidatePath(`/cases/${slug}`);
}

/** Moves a case between stages from the board or case page (`caseId`, `from`, `to`, optional `note`, `slug`). */
export async function moveStageAction(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireOwnerAction();
  const raw = formToObject(fd);
  const parsed = MoveStageInputSchema.safeParse({
    caseId: raw.caseId,
    from: raw.from,
    to: raw.to,
    note: raw.note === '' ? undefined : raw.note,
  });
  if (!parsed.success) {
    const noteTooLong = parsed.error.issues.some((i) => i.path[0] === 'note');
    return { error: noteTooLong ? 'The note is at most 500 characters.' : 'Invalid move. Refresh and try again.' };
  }
  const r = await moveStage(getDb(), parsed.data);
  if (!r.ok) return { error: REFUSAL[r.reason] };
  revalidateCase(raw.slug);
  return { ok: true };
}

const CaseRefSchema = z.object({ caseId: z.uuid() });

/**
 * "Overturn kill": killed → new (logged as an overturn, kill reason cleared). A case that is no longer killed (or is
 * gone) is left alone and the owner lands on the Killed column with the `overturn_refused` notice.
 */
export async function overturnKillAction(fd: FormData): Promise<void> {
  await requireOwnerAction();
  const raw = formToObject(fd);
  const parsed = CaseRefSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid request.');
  const r = await moveStage(getDb(), { caseId: parsed.data.caseId, from: 'killed', to: 'new' });
  if (!r.ok) redirect('/?stage=killed&notice=overturn_refused');
  revalidateCase(raw.slug);
}

const IdeaRefSchema = z.object({ ideaId: z.uuid() });

/**
 * "Re-run as owner idea" for a gate-killed idea: queues a full case run, then returns to the Killed column with a
 * notice (`rerun_queued`, `rerun_busy` when the queue is full, `rerun_refused` otherwise).
 */
export async function rerunGateKillAction(fd: FormData): Promise<void> {
  await requireOwnerAction();
  const parsed = IdeaRefSchema.safeParse(formToObject(fd));
  if (!parsed.success) throw new Error('Invalid request.');
  const r = await queueGateKillRerun(getDb(), parsed.data.ideaId);
  const notice = r.ok ? 'rerun_queued' : r.reason === 'too_many_queued' ? 'rerun_busy' : 'rerun_refused';
  if (r.ok) {
    revalidatePath('/');
    revalidatePath('/runs');
  }
  redirect(`/?stage=killed&notice=${notice}`);
}
