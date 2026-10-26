'use server';

import { BENCH_REFUSAL, queueBenchmarkPass } from '@bcg/core/bench/passes';
import { revalidatePath } from 'next/cache';
import { requireOwnerAction } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';
import type { FormState } from '@/lib/form';

/** Queues the benchmark runs for `npm run worker`. Takes no input; refused while runs are waiting or a pass is running. */
export async function runBenchmarkAction(_prev: FormState, _fd: FormData): Promise<FormState> {
  await requireOwnerAction();
  const r = await queueBenchmarkPass(getDb());
  if (!r.ok) return { error: BENCH_REFUSAL[r.reason] };
  for (const p of ['/progress', '/runs', '/command']) revalidatePath(p);
  return { ok: true };
}
