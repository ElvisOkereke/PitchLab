import { z } from 'zod';
import type { Directness } from './strength';

/** Web-safe: zod and types only. Keep this file free of db/runtime imports. */
export const KNOWLEDGE_KINDS = ['problem', 'startup', 'pricing', 'trend', 'rule_change', 'market'] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

/**
 * Every kind a library entry can have: the researchable kinds above, plus `find` (a link the owner shared, captured by
 * the worker). Missions and feeds never extract finds, so `find` is not in KNOWLEDGE_KINDS.
 */
export const LIBRARY_ENTRY_KINDS = [...KNOWLEDGE_KINDS, 'find'] as const;
export type LibraryEntryKind = (typeof LIBRARY_ENTRY_KINDS)[number];

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
    // A free-text string on older entries; the dossier writes the structured form.
    funding: z.union([z.string(), z.object({ stage: z.string().optional(), amount: z.string().optional(), date: z.string().optional() })]).optional(),
    // Company dossier (engine v2, dossier.v1). All optional: entries from before dossiers still parse.
    whoPays: z.string().optional(),
    pricingUnit: z.string().optional(),
    priceRange: z.string().optional(),
    revenueDrivers: z.array(z.string()).optional(),
    acquisition: z.array(z.string()).optional(),
    moat: z.string().optional(),
    useCases: z.array(z.string()).optional(),
    whyItWorked: z.string().optional(),
    whyItDied: z.string().optional(),
    comps: z.array(z.string()).optional(),
    traction: z.object({
      customers: z.number().optional(),
      reviewCount: z.number().optional(),
      hiring: z.boolean().optional(),
      rank: z.number().optional(),
    }).optional(),
    dossierAt: z.string().optional(),
    dossierStatus: z.enum(['done', 'unmatched', 'failed']).optional(),
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
  /** A shared link (finds). Claims are the creator's own and unverified; views and likes come from the capture, never the model. */
  find: z.object({
    what: z.string(),
    whoPays: z.string(),
    howItEarns: z.string(),
    whyItWorks: z.string(),
    claims: z.array(z.string()).max(10),
    platform: z.string(),
    views: z.number().optional(),
    likes: z.number().optional(),
    creatorType: z.string().optional(),
  }),
} as const;

/** Plain labels for the web (forms and filters). */
export const KIND_LABELS: Record<LibraryEntryKind, string> = {
  problem: 'Problems',
  startup: 'Startups',
  pricing: 'Pricing',
  trend: "What's growing or shrinking",
  rule_change: 'A rule or platform change',
  market: 'Market size clues',
  find: 'Seen in the wild',
};

/** What the extraction model said about how strong a draft's evidence is (strength itself is computed in code). */
export type DraftAssessment = { directness: Directness; bias: string | null; why: string };

export type KnowledgeDraft = {
  kind: LibraryEntryKind;
  title: string;
  summary: string;
  quote?: string;
  audience: KnowledgeAudience;
  countries: string[];
  industries: string[];
  voice?: KnowledgeVoice;
  assessment?: DraftAssessment;
  facts: unknown;
  source: { url: string; domain: string; sourceType: string; publishedAt?: Date; quote?: string; quoteVerified: boolean; voice?: KnowledgeVoice; via?: 'direct' | 'archive' | 'browser' | 'real_browser' | 'scraper'; snapshotAt?: Date };
};

export class FactsError extends Error {
  constructor(kind: string, issues: string) {
    super(`Invalid ${kind} facts: ${issues}`);
    this.name = 'FactsError';
  }
}

/** Parse kind-specific facts; throws FactsError (named) on mismatch or a kind with no schema yet. */
export function parseFacts(kind: LibraryEntryKind, facts: unknown): unknown {
  const schema = (FactsSchemas as Record<string, z.ZodType>)[kind];
  if (!schema) throw new FactsError(kind, 'no facts schema for this kind');
  const r = schema.safeParse(facts);
  if (!r.success) throw new FactsError(kind, r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '));
  return r.data;
}
