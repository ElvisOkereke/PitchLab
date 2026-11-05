'use server';

import { rateIdea } from '@bcg/core/dashboard/idea-ratings';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireOwnerAction } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';
import { formToObject, type FormState } from '@/lib/form';
import { nextIdeaRating } from '@/lib/idea-rating';

const IdeaRefSchema = z.object({ ideaId: z.uuid() });

/**
 * Thumbs up, thumbs down, clear or toggle one reason tag on a generated idea (`ideaId`, the idea's current `rating` and
 * `tags`, and the pressed button as `op` or `toggleTag`). The ratings are measurement only: nothing here reaches a prompt.
 */
export async function rateIdeaAction(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireOwnerAction();
  const raw = formToObject(fd, ['tags']);
  const ref = IdeaRefSchema.safeParse(raw);
  const next = nextIdeaRating(raw);
  if (!ref.success || !next) return { error: 'Could not save that rating. Refresh and try again.' };
  if (!(await rateIdea(getDb(), { ideaId: ref.data.ideaId, ...next }))) {
    return { error: 'You can rate only generated ideas. Refresh and try again.' };
  }
  revalidatePath('/runs');
  return { ok: true };
}
