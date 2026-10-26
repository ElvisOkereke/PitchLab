'use server';

import { MissionInputSchema, queueMission, saveResearchSettings } from '@bcg/core/dashboard/missions';
import { rejectItem, restoreItem } from '@bcg/core/library/store';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireOwnerAction } from '@/lib/auth/require-owner';
import { safeNext } from '@/lib/auth/safe-next';
import { getDb } from '@/lib/db';
import { formToObject, pickValues, type FormState } from '@/lib/form';

const WAITING = '3 research missions are already waiting. Wait for the worker.';
const FIELD_MESSAGE: Record<string, string> = {
  topic: 'Topic must be 3 to 200 characters.',
  kinds: 'Pick 1 to 3 kinds.',
  countries: 'Countries must be two-letter codes or global, up to 10, separated by commas.',
  audience: 'Audience must be business, consumer or both.',
  budgetUsd: 'Budget must be a number from 0.5 to 10.',
};

/** "ca, us ,Global," becomes ['CA', 'US', 'global']. */
function parseCountries(v: unknown): string[] {
  if (typeof v !== 'string') return [];
  return v.split(',').map((c) => c.trim()).filter(Boolean).map((c) => (c.toLowerCase() === 'global' ? 'global' : c.toUpperCase()));
}

/** A plain decimal ('3', '3.5') as a number; blank is undefined (the default applies); anything else stays a string (rejected). */
function decimal(v: unknown): unknown {
  if (v === undefined || v === '') return undefined;
  return typeof v === 'string' && /^\d{1,6}(\.\d{1,4})?$/.test(v) ? Number(v) : v;
}

/** Queues a research mission for `npm run worker` (topic, 1 to 3 kinds, countries, audience, budget). */
export async function queueMissionAction(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireOwnerAction();
  const raw = formToObject(fd, ['kinds']);
  const values = pickValues(raw, ['topic', 'kinds', 'countries', 'audience', 'budgetUsd'], ['kinds']);
  const parsed = MissionInputSchema.safeParse({
    topic: raw.topic,
    kinds: raw.kinds,
    countries: parseCountries(raw.countries),
    audience: raw.audience === '' ? undefined : raw.audience,
    budgetUsd: decimal(raw.budgetUsd),
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]!.path[0];
    return { error: FIELD_MESSAGE[String(field)] ?? 'Check the form and try again.', values };
  }
  const r = await queueMission(getDb(), parsed.data, 'owner');
  if (!r.ok) return { error: WAITING, values };
  revalidatePath('/library');
  return { ok: true };
}

const ItemSchema = z.object({ id: z.uuid(), reason: z.string().max(200).optional() });

/** A same-origin `/library` path from the form's `returnTo`; anything else becomes `/library`. */
function libraryReturn(raw: unknown): string {
  const p = safeNext(raw);
  return p === '/library' || p.startsWith('/library?') ? p : '/library';
}

function parseItem(fd: FormData) {
  const raw = formToObject(fd);
  const parsed = ItemSchema.safeParse({ id: raw.id, reason: raw.reason === '' ? undefined : raw.reason });
  if (!parsed.success) throw new Error('Invalid request.');
  return { ...parsed.data, back: libraryReturn(raw.returnTo) };
}

/** Takes an entry out of search and retrieval (it stays rejected if collected again), then back to the same Library URL. */
export async function rejectItemAction(fd: FormData): Promise<void> {
  await requireOwnerAction();
  const { id, reason, back } = parseItem(fd);
  await rejectItem(getDb(), id, reason);
  revalidatePath('/library');
  redirect(back);
}

/** Puts a rejected entry back, then back to the same Library URL. */
export async function restoreItemAction(fd: FormData): Promise<void> {
  await requireOwnerAction();
  const { id, back } = parseItem(fd);
  await restoreItem(getDb(), id);
  revalidatePath('/library');
  redirect(back);
}

/** Background research on or off and its daily cap (US dollars, 0 to 50). */
export async function saveResearchSettingsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireOwnerAction();
  const raw = formToObject(fd);
  const values = { ...pickValues(raw, ['dailyCapUsd']), background: raw.background === undefined ? 'off' : 'on' };
  const parsed = z.object({ background: z.boolean(), dailyCapUsd: z.number().min(0).max(50) })
    .safeParse({ background: values.background === 'on', dailyCapUsd: decimal(raw.dailyCapUsd) });
  if (!parsed.success) return { error: 'Daily cap must be a number from 0 to 50.', values };
  await saveResearchSettings(getDb(), parsed.data);
  revalidatePath('/settings');
  revalidatePath('/library');
  return { ok: true, values };
}
