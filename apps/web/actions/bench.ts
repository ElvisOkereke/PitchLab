'use server';

import { BENCH_REFUSAL, queueBenchmarkPass, recomputePass } from '@bcg/core/bench/passes';
import { revalidatePath } from 'next/cache';
import { requireOwnerAction } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';
import { formToObject, type FormState } from '@/lib/form';
import { z } from 'zod';

/** Queues the benchmark runs for `npm run worker`. Takes no input; refused while runs are waiting or a pass is running. */
export async function runBenchmarkAction(_prev: FormState, _fd: FormData): Promise<FormState> {
  await requireOwnerAction();
  const r = await queueBenchmarkPass(getDb());
  if (!r.ok) return { error: BENCH_REFUSAL[r.reason] };
  for (const p of ['/progress', '/runs', '/command']) revalidatePath(p);
  return { ok: true };
}

const RecomputeSchema = z.object({ passId: z.string().uuid() });

/** Freezes a new snapshot of a finished pass with today's data (so new gut scores count). Never echoes the id back. */
export async function recomputePassAction(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireOwnerAction();
  const parsed = RecomputeSchema.safeParse(formToObject(fd));
  if (!parsed.success) return { error: 'Invalid request. Refresh and try again.' };
  const r = await recomputePass(getDb(), parsed.data.passId);
  if (!r.ok) return { error: r.reason === 'running' ? 'Wait until the pass finishes.' : 'That pass no longer exists.' };
  revalidatePath('/progress');
  return { ok: true };
}
