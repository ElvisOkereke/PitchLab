'use server';

import { queueRun } from '@bcg/core/dashboard/runs';
import { addFinds, deleteFind, FIND_BATCH_MAX, normalizeFindUrl, retryFind } from '@bcg/core/finds/store';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireOwnerAction } from '@/lib/auth/require-owner';
import { getDb } from '@/lib/db';
import { formToObject, pickValues, type FormState } from '@/lib/form';

const PAGE = '/library/finds';
const LINKS_MAX = 100_000;

/**
 * The paste box as items: one link per line, the rest of the line (after the first space) is the note. Blank lines are
 * skipped but still counted, so `badLine` is the line number the owner sees in the box.
 */
function parseLinks(text: string): { items: { url: string; note?: string }[]; badLine?: number } {
  const items: { url: string; note?: string }[] = [];
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    n += 1;
    const t = line.trim();
    if (!t) continue;
    const space = t.search(/\s/);
    const url = space === -1 ? t : t.slice(0, space);
    const note = space === -1 ? '' : t.slice(space).trim();
    if (!normalizeFindUrl(url)) return { items, badLine: n };
    items.push(note ? { url, note } : { url });
  }
  return { items };
}

/** Saves pasted links as finds for the worker to capture (at most 50 lines; links must be http or https). */
export async function addFindsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  await requireOwnerAction();
  const raw = formToObject(fd);
  const values = pickValues(raw, ['links']);
  const text = typeof raw.links === 'string' ? raw.links.slice(0, LINKS_MAX) : '';
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).length;
  if (lines === 0) return { error: 'Paste at least one link.', values };
  if (lines > FIND_BATCH_MAX) return { error: `Paste at most ${FIND_BATCH_MAX} links at a time.`, values };
  const { items, badLine } = parseLinks(text);
  if (badLine) return { error: `Line ${badLine} is not an http or https link.`, values };
  const r = await addFinds(getDb(), items.map((i) => ({ ...i, source: 'paste' as const })));
  revalidatePath(PAGE);
  const parts = [`Added ${r.added}`];
  if (r.duplicates > 0) parts.push(`${r.duplicates} already in your finds`);
  return { ok: true, notice: `${parts.join(', ')}.` };
}

const IdSchema = z.object({ id: z.uuid() });

function parseId(fd: FormData): string {
  const parsed = IdSchema.safeParse(formToObject(fd));
  if (!parsed.success) throw new Error('Invalid request.');
  return parsed.data.id;
}

/** Puts a failed find back in the queue. */
export async function retryFindAction(fd: FormData): Promise<void> {
  await requireOwnerAction();
  await retryFind(getDb(), parseId(fd));
  revalidatePath(PAGE);
}

/** Deletes a find (its library entry stays). A find being captured right now is left alone. */
export async function deleteFindAction(fd: FormData): Promise<void> {
  await requireOwnerAction();
  await deleteFind(getDb(), parseId(fd));
  revalidatePath(PAGE);
}

const RUN_REFUSAL: Record<string, string> = {
  too_many_queued: '3 runs are already queued. Wait for the worker.',
  no_finds: 'No captured finds yet. Wait for the worker to capture your links.',
};

/**
 * "Start a run from these finds": queues a finds run over the 10 most recent captured finds (fixed when queued), with
 * the default counts, like the Runs page's queue form.
 */
export async function startRunFromFindsAction(_prev: FormState, _fd: FormData): Promise<FormState> {
  await requireOwnerAction();
  const r = await queueRun(getDb(), { seedType: 'finds', ideaCount: 12, advanceCount: 3 });
  if (!r.ok) return { error: RUN_REFUSAL[r.reason] ?? 'The run could not be queued. Refresh and try again.' };
  const n = r.findIds?.length ?? 0;
  revalidatePath('/runs');
  revalidatePath('/command');
  revalidatePath(PAGE);
  return { ok: true, notice: `Queued a run from ${n} finds. It starts when the worker is running; follow it on the Runs page.` };
}
