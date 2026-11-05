import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { OWNER_IDEA_TAGS, type OwnerIdeaTag } from '../audit/owner-tags';
import type { Db } from '../db/client';
import { ideas } from '../db/schema';

// Web-safe: imported by the dashboard. No env, router or collector runtime here.

const RateIdeaSchema = z.object({
  ideaId: z.uuid(),
  rating: z.union([z.literal(-1), z.literal(0), z.literal(1), z.null()]),
  // Deduped first (order kept), then capped at 9.
  tags: z.array(z.enum(OWNER_IDEA_TAGS)).max(OWNER_IDEA_TAGS.length * 4)
    .transform((t) => [...new Set(t)]).pipe(z.array(z.enum(OWNER_IDEA_TAGS)).max(9)),
});
export type RateIdeaInput = { ideaId: string; rating: -1 | 0 | 1 | null; tags: OwnerIdeaTag[] };

/**
 * Sets the owner's rating and tags on a generated idea; a null rating clears both. Returns whether an idea was
 * updated: an unknown id, or an idea that is not generated (an owner idea), changes nothing and returns false.
 */
export async function rateIdea(db: Db, raw: RateIdeaInput): Promise<boolean> {
  const input = RateIdeaSchema.parse(raw);
  const patch = input.rating === null
    ? { ownerRating: null, ownerTags: null, ownerRatedAt: null }
    : { ownerRating: input.rating, ownerTags: input.tags, ownerRatedAt: new Date() };
  const updated = await db.update(ideas).set(patch)
    .where(and(eq(ideas.id, input.ideaId), eq(ideas.origin, 'generated')))
    .returning({ id: ideas.id });
  return updated.length > 0;
}
