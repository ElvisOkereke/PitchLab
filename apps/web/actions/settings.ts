'use server';

import { HOLDOUT_REFUSAL, holdoutSet } from '@bcg/core/audit/holdout';
import { EDITABLE_SETTING_KEYS, SettingsInputSchema, saveSettings, type EditableSettingKey } from '@bcg/core/dashboard/settings';
import { resetTelegramPairing } from '@bcg/core/dashboard/telegram';
import { revalidatePath } from 'next/cache';
import { requireOwnerAction } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';
import { formToObject, pickValues, type FormState } from '@/lib/form';
import { SETTING_FIELDS } from '@/lib/settings-labels';

/**
 * Saves the sender and landing settings. Only EDITABLE_SETTING_KEYS pass core's schema (unknown keys such as
 * `worker.status` are dropped); all given keys are written in one transaction.
 */
export async function saveSettingsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireOwnerAction();
  const raw = formToObject(fd);
  // Only editable keys are echoed: after an error the form keeps what was typed, after a save it shows it as stored.
  const values = pickValues(raw, EDITABLE_SETTING_KEYS);
  const parsed = SettingsInputSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const field = SETTING_FIELDS[issue.path[0] as EditableSettingKey]?.label ?? 'A setting';
    // Core writes the length and https messages; anything else (e.g. a repeated field) gets a fixed one.
    const message = issue.code === 'custom' || issue.code === 'too_big' ? issue.message : 'Invalid value.';
    return { error: `${field}: ${message}`, values };
  }
  await saveSettings(getDb(), parsed.data);
  revalidatePath('/settings');
  return { ok: true, values };
}

/** Settings → Connections "Reset pairing": forgets the Telegram bot's owner and makes a new pairing code. */
export async function resetTelegramPairingAction(): Promise<void> {
  await requireOwnerAction();
  await resetTelegramPairing(getDb());
  revalidatePath('/settings');
  revalidatePath('/library/finds');
}

/**
 * Replaces the holdout examples with the lines of the text box (blank lines and repeats dropped). Refused, with nothing
 * saved, when there are more than 10 or one is over 1,000 characters. An empty box clears the list.
 */
export async function saveHoldoutAction(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireOwnerAction();
  const raw = formToObject(fd);
  const values = pickValues(raw, ['holdout']);
  const text = typeof raw.holdout === 'string' ? raw.holdout : '';
  const r = await holdoutSet(getDb(), text.split(/\r?\n/));
  if (!r.ok) return { error: HOLDOUT_REFUSAL[r.reason], values };
  revalidatePath('/settings');
  revalidatePath('/progress');
  return { ok: true, values: { holdout: r.items.join('\n') } };
}
