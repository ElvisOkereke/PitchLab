import { z } from 'zod';

/** Web-safe: zod and types only. Keep this file free of db/runtime imports. */
export const KNOWLEDGE_KINDS = ['problem', 'startup', 'pricing', 'trend', 'rule_change', 'market'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

/** Kinds collected in Slice A. */
export const SLICE_A_KINDS = ['problem', 'startup', 'pricing'] as const;
export type SliceAKind = (typeof SLICE_A_KINDS)[number];

export type KnowledgeVoice = 'operator' | 'neutral' | 'vendor';
export type KnowledgeAudience = 'business' | 'consumer' | 'both';

export const FactsSchemas = {
  problem: z.object({
    persona: z.string(),
    frequencyOrCost: z.string().optional(),
    workaround: z.string().optional(),
  }),
  startup: z.object({
    name: z.string(),
    whatItDoes: z.string(),
    businessModel: z.string(),
    outcome: z.enum(['active', 'dead', 'acquired', 'public', 'unknown']),
    why: z.string().optional(),
    foundedYear: z.number().optional(),
    endedYear: z.number().optional(),
    funding: z.string().optional(),
  }),
  pricing: z.object({
    product: z.string(),
    pricePoints: z.array(z.object({ amount: z.number(), currency: z.string(), unit: z.string() })),
    buyer: z.string(),
    complaints: z.array(z.string()),
  }),
  trend: z.object({
    topic: z.string(),
    direction: z.enum(['rising', 'falling', 'steady']),
    evidence: z.array(z.object({ metric: z.string(), value: z.string(), period: z.string() })).min(1).max(6),
    window: z.string(),
    basis: z.enum(['measured', 'reported']),
  }),
  rule_change: z.object({
    title: z.string(),
    change: z.string(),
    whoIsAffected: z.string(),
    jurisdiction: z.string(),
    status: z.enum(['final', 'proposed', 'announced']),
    effectiveDate: z.iso.date().nullable(),
    publishedDate: z.iso.date().nullable(),
  }),
  market: z.object({
    segment: z.string(),
    geography: z.string(),
    sizeClues: z.array(z.object({ metric: z.string(), value: z.string(), unit: z.string(), year: z.string() })).min(1).max(8),
    growthClues: z.array(z.object({ metric: z.string(), change: z.string(), period: z.string() })).max(6),
  }),
} as const;

/** Plain labels for the web (forms and filters). */
export const KIND_LABELS: Record<KnowledgeKind, string> = {
  problem: 'Problems',
  startup: 'Startups',
  pricing: 'Pricing',
  trend: "What's growing or shrinking",
  rule_change: 'A rule or platform change',
  market: 'Market size clues',
};

export type KnowledgeDraft = {
  kind: KnowledgeKind;
  title: string;
  summary: string;
  quote?: string;
  audience: KnowledgeAudience;
  countries: string[];
  industries: string[];
  voice?: KnowledgeVoice;
  facts: unknown;
  source: { url: string; domain: string; sourceType: string; publishedAt?: Date; quote?: string; quoteVerified: boolean; voice?: KnowledgeVoice; via?: 'direct' | 'archive' | 'browser'; snapshotAt?: Date };
};

export class FactsError extends Error {
  constructor(kind: string, issues: string) {
    super(`Invalid ${kind} facts: ${issues}`);
    this.name = 'FactsError';
  }
}

/** Parse kind-specific facts; throws FactsError (named) on mismatch or a kind with no schema yet. */
export function parseFacts(kind: KnowledgeKind, facts: unknown): unknown {
  const schema = (FactsSchemas as Record<string, z.ZodType>)[kind];
  if (!schema) throw new FactsError(kind, 'no facts schema for this kind');
  const r = schema.safeParse(facts);
  if (!r.success) throw new FactsError(kind, r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
  return r.data;
}
