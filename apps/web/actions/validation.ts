'use server';

import { ValidationJobOptionsSchema, queueValidationJob } from '@bcg/core/dashboard/validation-jobs';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireOwnerAction } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';
import { formToObject, pickValues, toInt, type FormState } from '@/lib/form';

const REFUSAL = {
  example: 'This is the example case. Its validation pack is already there.',
  sender_missing: 'Set your name, mailing address and contact in Settings first. Every email must include them.',
  already_queued: 'A validation job for this case is already waiting or running.',
  too_many_queued: '3 validation jobs are already waiting. Wait for the worker.',
  not_found: 'This case no longer exists.',
} as const;

const CHECKS = ['skipProspects', 'refresh', 'redraft'] as const;
const IdSchema = z.object({ caseId: z.uuid(), slug: z.string().min(1).max(200) });

/** Queues a validation pack for `npm run worker` (prospect count and the skip / refresh / redraft options). */
export async function queueValidationAction(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireOwnerAction();
  const raw = formToObject(fd);
  // Echoed on a refusal so the choices are kept. A ticked box submits a value; an unticked one submits nothing.
  const values = { ...pickValues(raw, ['prospects']), ...Object.fromEntries(CHECKS.map((k) => [k, raw[k] === undefined ? '' : 'on'])) };
  const ids = IdSchema.safeParse(raw);
  if (!ids.success) return { error: REFUSAL.not_found, values };
  const prospects = raw.prospects === undefined || raw.prospects === '' ? undefined : (toInt(raw.prospects) ?? raw.prospects);
  const parsed = ValidationJobOptionsSchema.safeParse({
    prospects,
    ...Object.fromEntries(CHECKS.map((k) => [k, raw[k] !== undefined])),
  });
  if (!parsed.success) return { error: 'Prospects must be a whole number from 1 to 100.', values };
  const r = await queueValidationJob(getDb(), ids.data.caseId, parsed.data);
  if (!r.ok) return { error: REFUSAL[r.reason], values };
  revalidatePath(`/cases/${ids.data.slug}`);
  return { ok: true };
}
