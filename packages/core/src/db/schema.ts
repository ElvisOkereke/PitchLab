import { sql } from 'drizzle-orm';
import type { CaseSections } from '../case/schema';
import type { ValueToUser, PriceHint, Barriers, IdeaAudience, BusinessModel } from '../pipeline/business-models';
import type { RunConfig } from '../pipeline/types';
import { EDGE_KINDS } from '../pipeline/engine/kinds';
import type { ValidationJobOptions } from '../dashboard/validation-jobs';
import type { StepResult } from '../validation/run';
import type { Scorecard } from '../bench/scorecard';
import {
  pgTable, pgEnum, text, uuid, boolean, integer, real, numeric, jsonb, timestamp,
  vector, smallint, primaryKey, uniqueIndex, index, check, type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const runStatus = pgEnum('run_status', ['queued', 'running', 'succeeded', 'failed']);
export const stageStatus = pgEnum('stage_status', ['running', 'done', 'failed']);
export const ideaOrigin = pgEnum('idea_origin', ['generated', 'owner']);
export const ideaStatus = pgEnum('idea_status', ['candidate', 'duplicate', 'screened_out', 'gated_out', 'advanced']);
export const gateCheck = pgEnum('gate_check', ['generic', 'regulation', 'control', 'autonomy', 'reachability', 'evidence', 'scale', 'trivial', 'comps']);
// ADVISORY_GATE_CHECKS (verdicts that only flag, never kill) live in pipeline/gate-checks, which has no imports.
export const caseStage = pgEnum('case_stage', ['new', 'validating', 'pilot', 'live', 'killed']);
export const claimVerified = pgEnum('claim_verified', ['unverified', 'verified', 'unsupported', 'unreachable', 'needs_review']);
export const criterion = pgEnum('criterion', ['pain', 'roi', 'evidence', 'speed', 'autonomy', 'novelty', 'reach', 'gut']);
export const scoreBy = pgEnum('score_by', ['ai', 'owner']);

export const markets = pgTable('markets', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  countries: text('countries').array().notNull(),
  language: text('language').notNull(),
  currency: text('currency').notNull(),
  sectors: text('sectors').array().notNull(),
  createdAt: createdAt(),
});

export const lenses = pgTable('lenses', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  pattern: text('pattern').notNull(),
  promptHint: text('prompt_hint').notNull(),
  active: boolean('active').notNull().default(true),
  version: integer('version').notNull().default(1),
  /** Who the lens is for: 'business', 'consumer' or 'any'. */
  audience: text('audience').$type<'business' | 'consumer' | 'any'>().notNull().default('business'),
  /** Sampling weight for open and sector runs; null reads as 1. */
  weight: real('weight'),
  createdAt: createdAt(),
});

export const benchmarkKind = pgEnum('benchmark_kind', ['baseline', 'pass', 'recompute']);
export const benchmarkStatus = pgEnum('benchmark_status', ['running', 'complete', 'incomplete']);

/** A frozen benchmark snapshot: the runs it covers and the metrics computed once (null while running). */
export const benchmarkPasses = pgTable('benchmark_passes', {
  id: id(),
  /** e.g. 'bench-v1', or 'baseline' for baseline-0. */
  version: text('version').notNull(),
  label: text('label').notNull(),
  kind: benchmarkKind('kind').notNull(),
  status: benchmarkStatus('status').notNull(),
  runIds: uuid('run_ids').array().notNull(),
  /** The frozen scorecard; null while running. */
  metrics: jsonb('metrics').$type<Scorecard | null>(),
  /** For recomputes: the pass this one was recomputed from. */
  sourcePassId: uuid('source_pass_id').references((): AnyPgColumn => benchmarkPasses.id),
  createdAt: createdAt(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export const runs = pgTable('runs', {
  id: id(),
  config: jsonb('config').$type<RunConfig>().notNull(),
  status: runStatus('status').notNull(),
  currentStage: text('current_stage'),
  error: text('error'),
  costUsd: numeric('cost_usd').notNull().default('0'),
  /** True only for the built-in example case's run (hidden/reset by src/example). */
  isExample: boolean('is_example').notNull().default(false),
  benchmarkPassId: uuid('benchmark_pass_id').references(() => benchmarkPasses.id),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index('runs_benchmark_pass_idx').on(t.benchmarkPassId)]);

export const runStages = pgTable('run_stages', {
  runId: uuid('run_id').notNull().references(() => runs.id),
  stage: text('stage').notNull(),
  status: stageStatus('status').notNull(),
  output: jsonb('output').$type<unknown>(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.runId, t.stage] })]);

/** Who wrote a signal (extract-signals.v3): someone in the affected business, an independent third party, or a seller. */
export const SIGNAL_VOICES = ['operator', 'neutral', 'vendor'] as const;
export type SignalVoice = (typeof SIGNAL_VOICES)[number];
/** Compile-time: the library's voice vocabulary is exactly the signal voice vocabulary. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const _voicesMatch: Equal<SignalVoice, import('../library/kinds').KnowledgeVoice> = true;
void _voicesMatch;

export const signals = pgTable('signals', {
  id: id(),
  runId: uuid('run_id').references(() => runs.id),
  marketId: text('market_id').notNull().references(() => markets.id),
  source: text('source').notNull(),
  url: text('url').notNull(),
  title: text('title').notNull(),
  quote: text('quote').notNull(),
  quoteHash: text('quote_hash').notNull(),
  sector: text('sector'),
  painType: text('pain_type'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  /** One of SIGNAL_VOICES (type-level only, no DB constraint); null for signals extracted before tuning-4 (untagged). */
  voice: text('voice', { enum: SIGNAL_VOICES }),
  /** 'pain' (a complaint) or 'opportunity' (a demand or growth signal); type-level only, no DB constraint. */
  kind: text('kind').$type<'pain' | 'opportunity'>().notNull().default('pain'),
  embedding: vector('embedding', { dimensions: 1536 }),
  /** The library entry this signal was promoted from (null for pipeline-collected signals). */
  knowledgeItemId: uuid('knowledge_item_id').references((): AnyPgColumn => knowledgeItems.id),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('signals_url_quote_hash_uq').on(t.url, t.quoteHash)]);

export const ideas = pgTable('ideas', {
  id: id(),
  runId: uuid('run_id').notNull().references(() => runs.id),
  lensId: text('lens_id').references(() => lenses.id),
  origin: ideaOrigin('origin').notNull(),
  title: text('title').notNull(),
  oneLiner: text('one_liner').notNull(),
  buyer: text('buyer').notNull(),
  problem: text('problem').notNull(),
  solution: text('solution').notNull(),
  /** Declared by ideate (one of IDEA_MECHANISMS); null for ideas from before tuning-2. Screen caps entrants per business model (screen.v4), not per mechanism. */
  mechanism: text('mechanism'),
  /** Short noun phrase for the buyer, e.g. "property manager"; null for ideas from before tuning-2. */
  buyerType: text('buyer_type'),
  /** The function incumbents leave unserved, as claimed by ideate (a model claim, not verified); null for owner ideas and ideas before tuning-4. */
  functionalGap: text('functional_gap'),
  /** Incumbents ideate says it knows (model claim); null for owner ideas and ideas before tuning-4. */
  knownIncumbents: jsonb('known_incumbents').$type<string[]>(),
  /** Who pays: 'business', 'consumer' or 'both'; null for ideas from before the generation rebuild. */
  audience: text('audience').$type<IdeaAudience>(),
  /** One of BUSINESS_MODELS; null reads as 'subscription'. */
  businessModel: text('business_model').$type<BusinessModel>(),
  revenueMechanics: text('revenue_mechanics'),
  valueToUser: jsonb('value_to_user').$type<ValueToUser>(),
  priceHint: jsonb('price_hint').$type<PriceHint>(),
  barriers: jsonb('barriers').$type<Barriers>(),
  /** Owner rating: -1, 0 or 1; null when unrated. Lives on the row, so a re-run that replaces the ideas drops it with them. */
  ownerRating: smallint('owner_rating'),
  ownerTags: text('owner_tags').array(),
  ownerRatedAt: timestamp('owner_rated_at', { withTimezone: true }),
  /** What the idea does better than incumbents (ideate v12; model claim); null for older ideas. */
  edge: jsonb('edge').$type<unknown>(),
  /** How many buyers there are and how we know (ideate v12; model claim); null for older ideas. */
  scale: jsonb('scale').$type<unknown>(),
  /** The scale estimate (model claim, ScaleEstimateSchema); null until estimated. */
  scaleEstimate: jsonb('scale_estimate').$type<unknown>(),
  /** computeScale output for the estimate (ScaleResult); null until estimated. */
  scaleResult: jsonb('scale_result').$type<unknown>(),
  /** Research library items the idea drew on. */
  libraryItemIds: uuid('library_item_ids').array(),
  /** The sketch this idea expands (engine v2); null for v1 and owner ideas. */
  sketchId: uuid('sketch_id'),
  /** The sketch's tournament Elo when it was expanded (engine v2); null otherwise. */
  elo: real('elo'),
  signalIds: uuid('signal_ids').array().notNull(),
  embedding: vector('embedding', { dimensions: 1536 }),
  screenScores: jsonb('screen_scores').$type<unknown>(),
  screenTotal: real('screen_total'),
  status: ideaStatus('status').notNull(),
  duplicateOf: uuid('duplicate_of'),
  createdAt: createdAt(),
});

/** The reviewer's 1-5 scores for an idea, one row per idea and prompt version. */
export const ideaReviews = pgTable('idea_reviews', {
  id: id(),
  ideaId: uuid('idea_id').notNull().references(() => ideas.id),
  scale: integer('scale').notNull(),
  edge: integer('edge').notNull(),
  novelty: integer('novelty').notNull(),
  niche: integer('niche').notNull(),
  reasons: jsonb('reasons').$type<unknown>().notNull(),
  model: text('model').notNull(),
  promptVersion: text('prompt_version').notNull(),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('idea_reviews_idea_prompt_uq').on(t.ideaId, t.promptVersion),
  check('idea_reviews_scale_range', sql`${t.scale} between 1 and 5`),
  check('idea_reviews_edge_range', sql`${t.edge} between 1 and 5`),
  check('idea_reviews_novelty_range', sql`${t.novelty} between 1 and 5`),
  check('idea_reviews_niche_range', sql`${t.niche} between 1 and 5`),
]);

export const gateVerdicts = pgTable('gate_verdicts', {
  id: id(),
  ideaId: uuid('idea_id').notNull().references(() => ideas.id),
  check: gateCheck('check').notNull(),
  pass: boolean('pass').notNull(),
  reasoning: text('reasoning').notNull(),
  sources: jsonb('sources').$type<unknown>(),
  model: text('model').notNull(),
  promptVersion: text('prompt_version').notNull(),
  createdAt: createdAt(),
});

export const cases = pgTable('cases', {
  id: id(),
  ideaId: uuid('idea_id').notNull().unique().references(() => ideas.id),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  stage: caseStage('stage').notNull().default('new'),
  sections: jsonb('sections').$type<CaseSections>().notNull(),
  killReason: text('kill_reason'),
  gateAdvisory: boolean('gate_advisory').notNull(),
  model: text('model').notNull(),
  promptVersion: text('prompt_version').notNull(),
  /** True only for the built-in example case (hidden/reset by src/example). */
  isExample: boolean('is_example').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const claims = pgTable('claims', {
  id: id(),
  caseId: uuid('case_id').notNull().references(() => cases.id),
  section: text('section').notNull(),
  text: text('text').notNull(),
  sourceUrl: text('source_url').notNull(),
  quote: text('quote'),
  verified: claimVerified('verified').notNull().default('unverified'),
  confidence: real('confidence'),
  /** Why the owner must check this claim himself (set with `unreachable` and `needs_review`). */
  reviewNote: text('review_note'),
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const scores = pgTable('scores', {
  id: id(),
  caseId: uuid('case_id').notNull().references(() => cases.id),
  criterion: criterion('criterion').notNull(),
  value: integer('value').notNull(),
  note: text('note').notNull(),
  by: scoreBy('by').notNull(),
  model: text('model'),
  promptVersion: text('prompt_version'),
  createdAt: createdAt(),
}, (t) => [check('scores_value_range', sql`${t.value} between 1 and 5`)]);

export const llmCalls = pgTable('llm_calls', {
  id: id(),
  runId: uuid('run_id').references(() => runs.id),
  missionId: uuid('mission_id').references((): AnyPgColumn => researchMissions.id),
  stage: text('stage').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  searchRequests: integer('search_requests').notNull(),
  costUsd: numeric('cost_usd').notNull(),
  latencyMs: integer('latency_ms').notNull(),
  promptVersion: text('prompt_version').notNull(),
  ok: boolean('ok').notNull(),
  error: text('error'),
  createdAt: createdAt(),
}, (t) => [index('llm_calls_mission_idx').on(t.missionId)]);

export const dataCalls = pgTable('data_calls', {
  id: id(),
  runId: uuid('run_id').references(() => runs.id),
  missionId: uuid('mission_id').references((): AnyPgColumn => researchMissions.id),
  provider: text('provider').notNull(),
  endpoint: text('endpoint').notNull(),
  costUsd: numeric('cost_usd').notNull().default('0'),
  ok: boolean('ok').notNull(),
  createdAt: createdAt(),
}, (t) => [index('data_calls_mission_idx').on(t.missionId)]);

// ---- Validation pack (Plan 3, migration 0004) -----------------------------------------------------

/** CASL basis of a prospect email (spec §11.6): published by the prospect themself (strong), a third party (weak), or unknown. */
export const CASL_BASES = ['self_published', 'third_party', 'unknown'] as const;
export type CaslBasis = (typeof CASL_BASES)[number];
export const PROSPECT_SOURCES = ['web_research', 'places', 'csv', 'manual'] as const;
export type ProspectSourceId = (typeof PROSPECT_SOURCES)[number];
export const PROSPECT_STATUSES = ['new', 'drafted', 'sent', 'replied', 'positive', 'meeting', 'not_interested', 'unsubscribed'] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];
export const OUTREACH_KINDS = ['cold', 'followup1', 'followup2'] as const;
export type OutreachKind = (typeof OUTREACH_KINDS)[number];
export const OUTREACH_EVENT_TYPES = ['sent', 'replied', 'positive', 'meeting', 'not_interested', 'unsubscribe', 'note'] as const;
export type OutreachEventType = (typeof OUTREACH_EVENT_TYPES)[number];

export const caslBasis = pgEnum('casl_basis', CASL_BASES);
export const prospectSource = pgEnum('prospect_source', PROSPECT_SOURCES);
export const prospectStatus = pgEnum('prospect_status', PROSPECT_STATUSES);
export const outreachKind = pgEnum('outreach_kind', OUTREACH_KINDS);
export const outreachEventType = pgEnum('outreach_event_type', OUTREACH_EVENT_TYPES);
export const landingEventType = pgEnum('landing_event_type', ['visit', 'submit']);

/** One generated pack (MVP spec, pilot plan, interview kit, checklist) per case. */
export const validationPacks = pgTable('validation_packs', {
  id: id(),
  caseId: uuid('case_id').notNull().unique().references(() => cases.id),
  sections: jsonb('sections').$type<unknown>().notNull(),
  model: text('model').notNull(),
  promptVersion: text('prompt_version').notNull(),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const prospects = pgTable('prospects', {
  id: id(),
  caseId: uuid('case_id').notNull().references(() => cases.id),
  name: text('name').notNull(),
  website: text('website').notNull(),
  /** Registrable domain of `website` (tldts), lowercase; one prospect per (case, domain). */
  domain: text('domain').notNull(),
  location: text('location').notNull(),
  country: text('country'),
  sizeNote: text('size_note'),
  fitReason: text('fit_reason').notNull(),
  contactName: text('contact_name'),
  contactRole: text('contact_role'),
  email: text('email'),
  /** The page the email was found on (CASL provenance). */
  emailSourceUrl: text('email_source_url'),
  emailCapturedAt: timestamp('email_captured_at', { withTimezone: true }),
  caslBasis: caslBasis('casl_basis').notNull().default('unknown'),
  source: prospectSource('source').notNull(),
  status: prospectStatus('status').notNull().default('new'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('prospects_case_domain_uq').on(t.caseId, t.domain)]);

export const outreachDrafts = pgTable('outreach_drafts', {
  id: id(),
  prospectId: uuid('prospect_id').notNull().references(() => prospects.id),
  kind: outreachKind('kind').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  model: text('model').notNull(),
  promptVersion: text('prompt_version').notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('outreach_drafts_prospect_kind_uq').on(t.prospectId, t.kind)]);

export const outreachEvents = pgTable('outreach_events', {
  id: id(),
  prospectId: uuid('prospect_id').notNull().references(() => prospects.id),
  type: outreachEventType('type').notNull(),
  note: text('note'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
}, (t) => [index('outreach_events_prospect_id_idx').on(t.prospectId)]);

/** Addresses that must never be exported again (unsubscribes). Stored lowercased. */
export const suppressions = pgTable('suppressions', {
  email: text('email').primaryKey(),
  reason: text('reason').notNull(),
  createdAt: createdAt(),
}, (t) => [check('suppressions_email_lower', sql`${t.email} = lower(${t.email})`)]);

export const landingPages = pgTable('landing_pages', {
  id: id(),
  caseId: uuid('case_id').notNull().unique().references(() => cases.id),
  slug: text('slug').notNull(),
  html: text('html').notNull(),
  copy: jsonb('copy').$type<unknown>().notNull(),
  publishedUrl: text('published_url'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Populated later by the hosted form endpoint. */
export const landingEvents = pgTable('landing_events', {
  id: id(),
  landingPageId: uuid('landing_page_id').notNull().references(() => landingPages.id),
  type: landingEventType('type').notNull(),
  email: text('email'),
  company: text('company'),
  note: text('note'),
  createdAt: createdAt(),
}, (t) => [index('landing_events_landing_page_id_idx').on(t.landingPageId)]);

// ---- Dashboard (Plan 2, migration 0006) -----------------------------------------------------------

export type CaseStage = (typeof caseStage.enumValues)[number];

/** `kill` = moved to killed; `overturn` = moved out of killed (any target); `move` = everything else. */
export const stageEventKind = pgEnum('stage_event_kind', ['move', 'overturn', 'kill']);
export type StageEventKind = (typeof stageEventKind.enumValues)[number];

/** Every stage move the owner makes (spec §6.2: each move is logged). Kept for the later taste-learning loop. */
export const stageEvents = pgTable('stage_events', {
  id: id(),
  caseId: uuid('case_id').notNull().references(() => cases.id),
  fromStage: caseStage('from_stage').notNull(),
  toStage: caseStage('to_stage').notNull(),
  kind: stageEventKind('kind').notNull(),
  note: text('note'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('stage_events_case_at_idx').on(t.caseId, t.at)]);

/** Queued validation-pack jobs (the worker picks them up). */
export const validationJobs = pgTable('validation_jobs', {
  id: id(),
  caseId: uuid('case_id').notNull().references(() => cases.id),
  options: jsonb('options').$type<ValidationJobOptions>().notNull(),
  status: runStatus('status').notNull().default('queued'),
  steps: jsonb('steps').$type<StepResult[]>(),
  error: text('error'),
  costUsd: numeric('cost_usd').notNull().default('0'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index('validation_jobs_status_created_idx').on(t.status, t.createdAt)]);

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  createdAt: createdAt(),
});

// ---- Research library (Slice A, migration 0009) ---------------------------------------------------

export const knowledgeKind = pgEnum('knowledge_kind', ['problem', 'startup', 'pricing', 'trend', 'rule_change', 'market', 'find']);
export const knowledgeStatus = pgEnum('knowledge_status', ['active', 'rejected']);
export const missionOrigin = pgEnum('mission_origin', ['owner', 'background']);

/** `challenge`: a bot wall or interstitial page; `skipped`: an escalation step not run (no scraper key, or its monthly budget used up). */
export const FETCH_OUTCOMES = ['ok', 'http_403', 'http_404', 'http_410', 'http_4xx', 'http_5xx', 'timeout', 'blocked_robots', 'blocked_host', 'too_large', 'not_html', 'thin_text', 'network', 'challenge', 'skipped'] as const;
export const FETCH_VIAS = ['direct', 'archive', 'browser', 'real_browser', 'scraper'] as const;
export const fetchOutcome = pgEnum('fetch_outcome', FETCH_OUTCOMES);
export const fetchVia = pgEnum('fetch_via', FETCH_VIAS);

export const KNOWLEDGE_AUDIENCES = ['business', 'consumer', 'both'] as const;

/** A research mission: one owner- or worker-started collection pass with a soft budget. */
export const researchMissions = pgTable('research_missions', {
  id: id(),
  topic: text('topic').notNull(),
  kinds: text('kinds').array().notNull(),
  countries: text('countries').array().notNull(),
  audience: text('audience', { enum: KNOWLEDGE_AUDIENCES }),
  budgetUsd: numeric('budget_usd').notNull(),
  costUsd: numeric('cost_usd').notNull().default('0'),
  origin: missionOrigin('origin').notNull(),
  status: runStatus('status').notNull().default('queued'),
  itemsAdded: integer('items_added').notNull().default(0),
  itemsMerged: integer('items_merged').notNull().default(0),
  warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [index('research_missions_status_created_idx').on(t.status, t.createdAt)]);

/** A deduplicated library entry. Facts are kind-specific (see library/kinds.ts). */
export const knowledgeItems = pgTable('knowledge_items', {
  id: id(),
  kind: knowledgeKind('kind').notNull(),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  quote: text('quote'),
  quoteVerified: boolean('quote_verified').notNull().default(false),
  audience: text('audience', { enum: KNOWLEDGE_AUDIENCES }).notNull(),
  countries: text('countries').array().notNull(),
  industries: text('industries').array().notNull(),
  voice: text('voice', { enum: SIGNAL_VOICES }),
  facts: jsonb('facts').notNull(),
  /** Strength assessment (library-assess.v1, evidence strength 1-5 and why); null until assessed. */
  assessment: jsonb('assessment').$type<unknown>(),
  embedding: vector('embedding', { dimensions: 1536 }),
  contentHash: text('content_hash').notNull(),
  status: knowledgeStatus('status').notNull().default('active'),
  rejectReason: text('reject_reason'),
  missionId: uuid('mission_id').references((): AnyPgColumn => researchMissions.id),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('knowledge_items_content_hash_uq').on(t.contentHash),
  index('knowledge_items_kind_status_idx').on(t.kind, t.status),
  index('knowledge_items_updated_idx').on(t.updatedAt),
]);

/** Where an entry came from (one entry can have many sources). Never stores author identity. */
export const knowledgeSources = pgTable('knowledge_sources', {
  id: id(),
  itemId: uuid('item_id').notNull().references(() => knowledgeItems.id),
  url: text('url').notNull(),
  domain: text('domain').notNull(),
  sourceType: text('source_type').notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  quote: text('quote'),
  quoteVerified: boolean('quote_verified').notNull().default(false),
  /** Who wrote this source's text; signals take their voice from the source they quote (the entry voice is for display and ranking). */
  voice: text('voice', { enum: SIGNAL_VOICES }),
  /** When this source's data must be deleted (YouTube: 30 days after fetch); null = never. */
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  /** How the text was obtained. */
  via: fetchVia('via').notNull().default('direct'),
  /** The archive snapshot time when via = 'archive'. */
  snapshotAt: timestamp('snapshot_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('knowledge_sources_item_url_uq').on(t.itemId, t.url),
  index('knowledge_sources_source_type_idx').on(t.sourceType),
  index('knowledge_sources_domain_idx').on(t.domain),
]);

/** One row per page fetch attempt (registrable domain only, never the URL). Pruned after 90 days by maintenance. */
export const pageFetches = pgTable('page_fetches', {
  id: id(),
  urlDomain: text('url_domain').notNull(),
  outcome: fetchOutcome('outcome').notNull(),
  via: fetchVia('via').notNull().default('direct'),
  status: integer('status'),
  missionId: uuid('mission_id').references((): AnyPgColumn => researchMissions.id),
  runId: uuid('run_id').references(() => runs.id),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('page_fetches_at_idx').on(t.at), index('page_fetches_url_domain_idx').on(t.urlDomain)]);

// ---- Finds (migration 0014) ---------------------------------------------------------------------------

export const FIND_STATUSES = ['queued', 'capturing', 'done', 'failed'] as const;
export const FIND_SOURCES = ['telegram', 'paste'] as const;
export const findStatus = pgEnum('find_status', FIND_STATUSES);
export const findSource = pgEnum('find_source', FIND_SOURCES);

/** View and like counts from the capture, where the platform shows them. */
export type FindStats = { views?: number; likes?: number; comments?: number; durationSec?: number; uploadedAt?: string };

/** A link the owner shared (Telegram or pasted), captured by the worker and turned into one `find` library entry. */
export const finds = pgTable('finds', {
  id: id(),
  /** The normalised url (tracking parameters stripped); unique. */
  url: text('url').notNull(),
  platform: text('platform').notNull(),
  title: text('title'),
  note: text('note'),
  source: findSource('source').notNull(),
  status: findStatus('status').notNull().default('queued'),
  caption: text('caption'),
  transcript: text('transcript'),
  screenText: text('screen_text'),
  stats: jsonb('stats').$type<FindStats>(),
  error: text('error'),
  warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
  knowledgeItemId: uuid('knowledge_item_id').references(() => knowledgeItems.id, { onDelete: 'set null' }),
  /** When the current capture started (a `capturing` row older than 15 minutes goes back to the queue). */
  startedAt: timestamp('started_at', { withTimezone: true }),
  createdAt: createdAt(),
  capturedAt: timestamp('captured_at', { withTimezone: true }),
}, (t) => [uniqueIndex('finds_url_uq').on(t.url), index('finds_status_created_idx').on(t.status, t.createdAt)]);

export const sketchStatus = pgEnum('sketch_status', ['kept', 'duplicate', 'near_killed', 'evolved']);
export const sketchOperator = pgEnum('sketch_operator', ['sharpen', 'combine', 'simplify']);
export const matchPhase = pgEnum('match_phase', ['main', 'final']);
export const matchVerdict = pgEnum('match_verdict', ['a', 'b', 'draw', 'error']);
export const matchResult = pgEnum('match_result', ['a', 'b', 'draw']);
export const judgeSplit = pgEnum('judge_split', ['train', 'test']);

/** A short idea candidate (engine v2): sketched per lens, filtered by the archive, ranked by the tournament, then expanded into an idea. */
export const sketches = pgTable('sketches', {
  id: id(),
  runId: uuid('run_id').notNull().references(() => runs.id),
  lensId: text('lens_id').references(() => lenses.id),
  title: text('title').notNull(),
  buyer: text('buyer').notNull(),
  problem: text('problem').notNull(),
  howItEarns: text('how_it_earns').notNull(),
  businessModel: text('business_model').notNull(),
  edge: text('edge').notNull(),
  edgeKind: text('edge_kind', { enum: EDGE_KINDS }).notNull(),
  whyNotTrivial: text('why_not_trivial').notNull(),
  /** 'earn' or 'save': whether the buyer makes money or saves it. */
  earnOrSave: text('earn_or_save').notNull(),
  signalIds: uuid('signal_ids').array().notNull(),
  libraryItemIds: uuid('library_item_ids').array().notNull(),
  embedding: vector('embedding', { dimensions: 1536 }),
  /** The diversity cell (buyer kind, business model, edge kind) the archive files it under. */
  cell: text('cell'),
  status: sketchStatus('status').notNull(),
  elo: real('elo'),
  parentSketchId: uuid('parent_sketch_id').references((): AnyPgColumn => sketches.id),
  operator: sketchOperator('operator'),
  createdAt: createdAt(),
}, (t) => [index('sketches_run_idx').on(t.runId)]);

/** One judged pairing in a run's tournament. Keyed by round and pair so a resumed run neither repeats nor double-counts a match. */
export const tournamentMatches = pgTable('tournament_matches', {
  id: id(),
  runId: uuid('run_id').notNull().references(() => runs.id),
  phase: matchPhase('phase').notNull(),
  round: integer('round').notNull(),
  aId: uuid('a_id').notNull().references(() => sketches.id),
  bId: uuid('b_id').notNull().references(() => sketches.id),
  verdictAB: matchVerdict('verdict_ab').notNull(),
  verdictBA: matchVerdict('verdict_ba').notNull(),
  result: matchResult('result').notNull(),
  confidence: real('confidence').notNull(),
  reasons: jsonb('reasons').$type<unknown>().notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('tournament_matches_pair_uq').on(t.runId, t.phase, t.round, t.aId, t.bId)]);

/** A kept-versus-killed pair of ideas the judge is calibrated on (train: few-shot examples, test: held out for accuracy). */
export const judgePairs = pgTable('judge_pairs', {
  id: id(),
  keptIdeaId: uuid('kept_idea_id').notNull().references(() => ideas.id),
  killedIdeaId: uuid('killed_idea_id').notNull().references(() => ideas.id),
  pairHash: text('pair_hash').notNull(),
  split: judgeSplit('split').notNull(),
  reason: text('reason'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('judge_pairs_pair_hash_uq').on(t.pairHash)]);
