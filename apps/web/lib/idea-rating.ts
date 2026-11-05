import { OWNER_IDEA_TAGS, type OwnerIdeaTag } from '@bcg/core/audit/owner-tags';

export type IdeaRatingState = { rating: -1 | 0 | 1 | null; tags: OwnerIdeaTag[] };

const isTag = (t: unknown): t is OwnerIdeaTag => typeof t === 'string' && (OWNER_IDEA_TAGS as readonly string[]).includes(t);

/** The rating a form carries: '' is unrated, anything but -1, 0 or 1 is invalid (undefined). */
function parseRating(v: unknown): -1 | 0 | 1 | null | undefined {
  if (v === '' || v === undefined) return null;
  return v === '-1' ? -1 : v === '0' ? 0 : v === '1' ? 1 : undefined;
}

/**
 * The idea's next rating and tags from what its form carried (current rating and tags) and the button pressed
 * (`op` up/down/clear, or `toggleTag`). A tag on an unrated idea makes it neutral (0). Undefined when anything is invalid.
 */
export function nextIdeaRating(raw: Record<string, unknown>): IdeaRatingState | undefined {
  const current = parseRating(raw.rating);
  const list = raw.tags === undefined ? [] : Array.isArray(raw.tags) ? raw.tags : [raw.tags];
  if (current === undefined || !list.every(isTag)) return undefined;
  const tags = [...new Set(list)] as OwnerIdeaTag[];
  const { op, toggleTag } = raw;
  if (toggleTag !== undefined) {
    if (!isTag(toggleTag)) return undefined;
    const next = tags.includes(toggleTag) ? tags.filter((t) => t !== toggleTag) : [...tags, toggleTag];
    return { rating: current ?? 0, tags: next };
  }
  if (op === 'up') return { rating: 1, tags };
  if (op === 'down') return { rating: -1, tags };
  if (op === 'clear') return { rating: null, tags: [] };
  return undefined;
}
