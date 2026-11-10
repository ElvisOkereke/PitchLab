/** Web-safe: constants and types only. Shared by the schema, the sketch stage and the tournament. */
export const EDGE_KINDS = ['data', 'workflow', 'regulation', 'network', 'ai_capability', 'distribution', 'none'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const BUYER_KINDS = ['business', 'prosumer', 'consumer'] as const;
export type BuyerKind = (typeof BUYER_KINDS)[number];
