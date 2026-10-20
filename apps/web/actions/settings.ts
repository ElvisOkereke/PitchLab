'use server';

import { SettingsInputSchema, saveSettings, type EditableSettingKey } from '@bcg/core/dashboard/settings';
import { revalidatePath } from 'next/cache';
import { requireOwnerAction } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';
import { formToObject, type FormState } from '@/lib/form';
import { SETTING_FIELDS } from '@/lib/settings-labels';

/**
 * Saves the sender and landing settings. Only EDITABLE_SETTING_KEYS pass core's schema (unknown keys such as
 * `worker.status` are dropped); all given keys are written in one transaction.
 */
export async function saveSettingsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireOwnerAction();
  const parsed = SettingsInputSchema.safeParse(formToObject(fd));
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const field = SETTING_FIELDS[issue.path[0] as EditableSettingKey]?.label ?? 'A setting';
    // Core writes the length and https messages; anything else (e.g. a repeated field) gets a fixed one.
    const message = issue.code === 'custom' || issue.code === 'too_big' ? issue.message : 'Invalid value.';
    return { error: `${field}: ${message}` };
  }
  await saveSettings(getDb(), parsed.data);
  revalidatePath('/settings');
  return { ok: true };
}
