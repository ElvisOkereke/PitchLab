'use client';

import { OWNER_IDEA_TAGS } from '@bcg/core/audit/owner-tags';
import type { RunIdeaRow } from '@bcg/core/dashboard/runs';
import { useActionState } from 'react';
import { rateIdeaAction } from '@/actions/ideas';
import type { FormState } from '@/lib/form';

/**
 * Rating controls for one generated idea: thumbs up, thumbs down, clear and a toggle chip per reason tag. Every control
 * is a submit button of one form, so it works without JS. The form carries the idea's current rating and tags; the page
 * refreshes with the saved state, shown as pressed buttons. A failed save shows a message under the buttons.
 */
export function IdeaRating({ idea }: { idea: Pick<RunIdeaRow, 'id' | 'ownerRating' | 'ownerTags'> }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(rateIdeaAction, {});
  const tags = idea.ownerTags ?? [];
  const rating = idea.ownerRating;
  return (
    <form action={formAction} data-testid="rate-idea" className="idea-rating">
      <input type="hidden" name="ideaId" value={idea.id} />
      <input type="hidden" name="rating" value={rating === null ? '' : String(rating)} />
      {tags.map((t) => (
        <input key={t} type="hidden" name="tags" value={t} />
      ))}
      <div className="idea-rating-row">
        <button type="submit" name="op" value="up" aria-pressed={rating === 1} disabled={pending} className="secondary">
          Thumbs up
        </button>
        <button type="submit" name="op" value="down" aria-pressed={rating === -1} disabled={pending} className="secondary">
          Thumbs down
        </button>
        <button type="submit" name="op" value="clear" disabled={pending || rating === null} className="secondary">
          Clear rating
        </button>
      </div>
      <div className="idea-rating-row">
        {OWNER_IDEA_TAGS.map((t) => (
          <button key={t} type="submit" name="toggleTag" value={t} aria-pressed={tags.includes(t)} disabled={pending} className="secondary idea-tag">
            {t}
          </button>
        ))}
      </div>
      {state.error ? (
        <p className="error" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
