'use server';

import { CASE_SLUG } from '@bcg/core/dashboard/case-view';
import { markOutreach } from '@bcg/core/validation/tracking';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireOwnerAction } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';
import { formToObject, pickValues, type FormState } from '@/lib/form';

const MarkOutreachInputSchema = z.object({
  prospectId: z.uuid(),
  type: z.enum(['sent', 'replied', 'positive', 'meeting', 'not_interested', 'unsubscribe', 'note']),
  note: z.string().trim().max(500).optional(),
});

/** The checklist's interviews_done counts `note` events whose note starts with this (case-insensitive). */
const INTERVIEW_PREFIX = /^\s*interview:/i;

/**
 * Records what the owner did or heard for one prospect, through core's markOutreach (the function `gen outreach mark`
 * uses), so "status never regresses" and "unsubscribe suppresses the address" hold in one place. Type `note` is an
 * interview note: its text is required and gets the `interview:` prefix the checklist counts (unless already there).
 */
export async function markOutreachAction(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireOwnerAction();
  const raw = formToObject(fd);
  // Echoed on an error so the form keeps the choice and the note.
  const values = pickValues(raw, ['type', 'note']);
  const parsed = MarkOutreachInputSchema.safeParse({ prospectId: raw.prospectId, type: raw.type, note: raw.note === '' ? undefined : raw.note });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    if (field === 'note') return { error: 'The note is at most 500 characters.', values };
    if (field === 'type') return { error: 'Pick what happened.', values };
    return { error: 'Invalid request. Refresh and try again.', values };
  }
  const { prospectId, type } = parsed.data;
  let { note } = parsed.data;
  if (type === 'note') {
    if (!note) return { error: 'Write what you learned in the interview.', values };
    if (!INTERVIEW_PREFIX.test(note)) note = `interview: ${note}`;
  }
  try {
    // core skips a note identical to one logged for this prospect in the last 10 minutes (a resubmitted form).
    const r = await markOutreach(getDb(), prospectId, type, note);
    if (r.duplicate) return { ok: true, notice: 'Already logged.' };
  } catch (e) {
    // The only expected refusal for an id: the prospect is gone. Anything else is a real error.
    if (e instanceof Error && e.message.startsWith('No prospect matches')) return { error: 'This prospect no longer exists. Refresh.', values };
    throw e;
  }
  revalidatePath('/');
  revalidatePath('/command');
  if (typeof raw.slug === 'string' && CASE_SLUG.test(raw.slug)) revalidatePath(`/cases/${raw.slug}`);
  return { ok: true };
}
