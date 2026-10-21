// Browser-safe tour constants (no zod, no drizzle): the client tour imports these, the server code re-exports them
// from ./tour.

/** The guided tour's chapters, in the order the whole tour runs them. */
export const TOUR_CHAPTERS = ['setup', 'generate', 'board', 'read', 'score', 'validate', 'outreach', 'decide'] as const;
export type TourChapterId = (typeof TOUR_CHAPTERS)[number];

/** Bump when the chapters change materially: older saved states then show "The tour has new steps". */
export const TOUR_VERSION = 1;
export const TOUR_STATE_KEY = 'tour.state';
