'use server';

import { QueueRunInputSchema, clampPage, queueRun, requeueRun } from '@bcg/core/dashboard/runs';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { requireOwnerAction } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';
import { formToObject, toInt, type FormState } from '@/lib/form';
import { runsHref, type RunsNotice } from '@/lib/runs-query';

const REFUSAL = {
  too_many_queued: '3 runs are already queued. Wait for the worker.',
  unknown_lens: 'One of the lenses is unknown or inactive. Refresh and try again.',
  unknown_sector: 'One of the sectors is not in the market. Refresh and try again.',
} as const;

/** Fields whose messages core writes for the owner (counts, list sizes, idea length, advance ≤ ideas). */
const CORE_WORDED = new Set(['ideaCount', 'advanceCount', 'ideaText']);

/** A form count: blank → undefined (core's default applies); a whole number → number; anything else stays a string (rejected). */
function count(v: unknown): unknown {
  if (v === undefined || v === '') return undefined;
  return toInt(v) ?? v;
}

function issueMessage(issue: { path: PropertyKey[]; message: string }): string {
  const [field] = issue.path;
  if (typeof field === 'string' && CORE_WORDED.has(field)) return issue.message;
  if (field === 'sectors') return issue.path.length === 1 ? issue.message : 'Pick sectors from the list.';
  if (field === 'lensIds') return issue.path.length === 1 ? issue.message : 'Pick lenses from the list.';
  return 'Pick how to seed the run.';
}

/** Queues a run for `npm run worker` (seed open / sectors / lenses / idea, idea and advance counts). */
export async function queueRunAction(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireOwnerAction();
  const raw = formToObject(fd, ['sectors', 'lensIds']);
  const parsed = QueueRunInputSchema.safeParse({
    seedType: raw.seedType,
    sectors: raw.sectors,
    lensIds: raw.lensIds,
    ideaText: raw.ideaText,
    ideaCount: count(raw.ideaCount),
    advanceCount: count(raw.advanceCount),
  });
  if (!parsed.success) return { error: issueMessage(parsed.error.issues[0]!) };
  const r = await queueRun(getDb(), parsed.data);
  if (!r.ok) return { error: REFUSAL[r.reason] };
  revalidatePath('/runs');
  revalidatePath('/command');
  return { ok: true };
}

const RequeueSchema = z.object({ runId: z.uuid() });
const REQUEUE_NOTICE: Record<'not_found' | 'not_failed' | 'too_many_queued', RunsNotice> = {
  not_found: 'requeue_not_found',
  not_failed: 'requeue_not_failed',
  too_many_queued: 'requeue_busy',
};

/** "Resume" a failed run (failed → queued; the worker resumes from the failed stage), then back to the same Runs page. */
export async function requeueRunAction(fd: FormData): Promise<void> {
  await requireOwnerAction();
  const raw = formToObject(fd);
  const parsed = RequeueSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid request.');
  const page = clampPage(raw.page);
  const r = await requeueRun(getDb(), parsed.data.runId);
  if (r.ok) {
    revalidatePath('/runs');
    revalidatePath('/command');
  }
  redirect(runsHref(page, r.ok ? 'requeued' : REQUEUE_NOTICE[r.reason ?? 'not_found']));
}
