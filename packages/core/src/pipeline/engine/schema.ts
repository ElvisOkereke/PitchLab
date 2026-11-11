import { z } from 'zod';
import { BUSINESS_MODELS } from '../business-models';
import { EARN_OR_SAVE, EDGE_KINDS, SKETCH_TEXT_MAX } from './kinds';

/** Web-safe: zod, business-models (zod only) and kinds only. */

/** The text fields that together are at most SKETCH_TEXT_MAX characters. */
export const SKETCH_TEXT_FIELDS = ['title', 'buyer', 'problem', 'howItEarns', 'edge', 'whyNotTrivial'] as const;

/** Total characters of a sketch's text fields (missing fields count as 0). */
export function sketchTextLength(s: Partial<Record<(typeof SKETCH_TEXT_FIELDS)[number], unknown>>): number {
  return SKETCH_TEXT_FIELDS.reduce((n, k) => n + (typeof s[k] === 'string' ? (s[k] as string).length : 0), 0);
}

const text = z.string().trim().min(1);

/**
 * One sketch (spec §2): a short idea the tournament ranks before the best are expanded. `edge` is one sentence naming
 * an incumbent (or "none known"); `whyNotTrivial` is one sentence on the engineering, data or industry work a person
 * or one prompt cannot do. `signalIds` cite harvest signals (at least one), `libraryItemIds` cite shown library entries.
 */
export const SketchSchema = z.object({
  title: text,
  buyer: text,
  problem: text,
  howItEarns: text,
  businessModel: z.enum(BUSINESS_MODELS),
  edge: text,
  edgeKind: z.enum(EDGE_KINDS),
  whyNotTrivial: text,
  earnOrSave: z.enum(EARN_OR_SAVE),
  signalIds: z.array(z.string()).min(1),
  libraryItemIds: z.array(z.string()).max(10),
}).refine((s) => sketchTextLength(s) <= SKETCH_TEXT_MAX, { path: ['text'], message: 'too_long' });
export type Sketch = z.infer<typeof SketchSchema>;
