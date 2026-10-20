'use server';

import { CASE_SLUG } from '@bcg/core/dashboard/case-view';
import { markOutreach } from '@bcg/core/validation/tracking';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireOwnerAction } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';
import { formToObject, type FormState } from '@/lib/form';

const MarkOutreachInputSchema = z.object({
  prospectId: z.uuid(),
  type: z.enum(['sent', 'replied', 'positive', 'meeting', 'not_interested', 'unsubscribe']),
  note: z.string().trim().max(500).optional(),
});

/**
 * Records what the owner did or heard for one prospect, through core's markOutreach (the function `gen outreach mark`
 * uses), so "status never regresses" and "unsubscribe suppresses the address" hold in one place.
 */
export async function markOutreachAction(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireOwnerAction();
  const raw = formToObject(fd);
  const parsed = MarkOutreachInputSchema.safeParse({ prospectId: raw.prospectId, type: raw.type, note: raw.note === '' ? undefined : raw.note });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    if (field === 'note') return { error: 'The note is at most 500 characters.' };
    if (field === 'type') return { error: 'Pick what happened.' };
    return { error: 'Invalid request. Refresh and try again.' };
  }
  const { prospectId, type, note } = parsed.data;
  try {
    await markOutreach(getDb(), prospectId, type, note);
  } catch (e) {
    // The only expected refusal for an id: the prospect is gone. Anything else is a real error.
    if (e instanceof Error && e.message.startsWith('No prospect matches')) return { error: 'This prospect no longer exists. Refresh.' };
    throw e;
  }
  revalidatePath('/');
  revalidatePath('/command');
  if (typeof raw.slug === 'string' && CASE_SLUG.test(raw.slug)) revalidatePath(`/cases/${raw.slug}`);
  return { ok: true };
}
