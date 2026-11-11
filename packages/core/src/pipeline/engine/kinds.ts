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

/** A sketch this close to an earlier sketch or idea (any run), or to another sketch in its run, is a duplicate. */
export const SKETCH_DUPLICATE_SIM = 0.85;
/** A sketch this close to a gate-killed idea or an owner-killed case is near_killed. */
export const SKETCH_KILLED_SIM = 0.75;

/** Tournament (spec §4): every sketch starts at ELO_START; each match moves ratings by at most ELO_K. */
export const ELO_START = 1200;
export const ELO_K = 24;
/** Swiss rounds in the main tournament, and at most this many judge calls (two per match) in it. */
export const SWISS_ROUNDS = 5;
export const JUDGE_CALLS_MAX = 300;
/** The final tournament (parents plus evolved variants, spec §6): rounds and judge call cap. */
export const FINAL_ROUNDS = 3;
export const FINAL_CALLS_MAX = 120;
/** How many sketches go on after a tournament, with at most MAX_PER_CELL per diversity cell and MAX_PER_BUSINESS_MODEL per business model. */
export const TOP_SKETCHES = 12;
export const MAX_PER_CELL = 2;
/** At most this many per business model: generated ideas reaching the gate in one run (screen), and sketches leaving a tournament. */
export const MAX_PER_BUSINESS_MODEL = 2;

/** Judge calibration (spec §5): at most this many few-shot Board pairs go into a judge prompt. */
export const FEWSHOT_PAIRS_MAX = 6;
/** The share of Board pairs that go to the training split (few-shot examples); the rest are held out to measure the judge. */
export const TRAIN_SHARE = 0.6;

/** Evolve (spec §6): how a variant was made from its parent sketch. */
export const SKETCH_OPERATORS = ['sharpen', 'combine', 'simplify'] as const;
export type SketchOperator = (typeof SKETCH_OPERATORS)[number];
/** Sketch, tournament and evolve together spend at most this much per run (USD, llm_calls of sketch.*, judge.* and evolve.*). */
export const ENGINE_USD_MAX = 8;
/** Evolve: the top this many sketches get one variant each, written against their COMPS_PER_SKETCH nearest comps. */
export const EVOLVE_TOP = 6;
export const COMPS_PER_SKETCH = 5;
