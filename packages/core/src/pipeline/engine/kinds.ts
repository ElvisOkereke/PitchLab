/** Web-safe: constants and types only. Shared by the schema, the sketch stage and the tournament. */
export const EDGE_KINDS = ['data', 'workflow', 'regulation', 'network', 'ai_capability', 'distribution', 'none'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const BUYER_KINDS = ['business', 'prosumer', 'consumer'] as const;
export type BuyerKind = (typeof BUYER_KINDS)[number];

/** Whether a sketch helps its buyer earn money, save it, or both. */
export const EARN_OR_SAVE = ['earn', 'save', 'both'] as const;
export type EarnOrSave = (typeof EARN_OR_SAVE)[number];

/** Each sketch call: a long list of `longList` titles, then `min` to `max` final sketches (spec §2). */
export const SKETCHES_PER_LENS = { min: 12, max: 15, longList: 20 } as const;
/** The avoid list shows at most this many nearest earlier idea and sketch titles from other runs. */
export const AVOID_TITLES_MAX = 60;
/** A sketch's text fields together are at most this many characters. */
export const SKETCH_TEXT_MAX = 600;
