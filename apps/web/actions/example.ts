'use server';

import { EXAMPLE_SLUG, hideExample, resetExample } from '@bcg/core/example/example';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireOwnerAction } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';
import { settingsHref } from '@/lib/settings-query';

function refresh() {
  revalidatePath('/');
  revalidatePath('/leaderboard');
  revalidatePath('/settings');
  revalidatePath(`/cases/${EXAMPLE_SLUG}`);
}

/** Hides the built-in example (and keeps it hidden), then back to Settings. */
export async function hideExampleAction(_fd: FormData): Promise<void> {
  await requireOwnerAction();
  await hideExample(getDb());
  refresh();
  redirect(settingsHref('example_hidden'));
}

/** Restores the built-in example to its first state and shows it again, then back to Settings. */
export async function resetExampleAction(_fd: FormData): Promise<void> {
  await requireOwnerAction();
  await resetExample(getDb());
  refresh();
  redirect(settingsHref('example_reset'));
}
