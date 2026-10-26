import { sql } from 'drizzle-orm';
import type { CaseSections } from '../case/schema';
import type { RunConfig } from '../pipeline/types';
import type { ValidationJobOptions } from '../dashboard/validation-jobs';
import type { StepResult } from '../validation/run';
import {
  pgTable, pgEnum, text, uuid, boolean, integer, real, numeric, jsonb, timestamp,
  vector, primaryKey, uniqueIndex, index, check, type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const runStatus = pgEnum('run_status', ['queued', 'running', 'succeeded', 'failed']);
export const stageStatus = pgEnum('stage_status', ['running', 'done', 'failed']);
export const ideaOrigin = pgEnum('idea_origin', ['generated', 'owner']);
export const ideaStatus = pgEnum('idea_status', ['candidate', 'duplicate', 'screened_out', 'gated_out', 'advanced']);
export const gateCheck = pgEnum('gate_check', ['generic', 'regulation', 'control', 'autonomy', 'reachability', 'evidence']);
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
  /** Scorecard (narrowed in src/bench); null while running. */
  metrics: jsonb('metrics').$type<unknown>(),
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
  embedding: vector('embedding', { dimensions: 1536 }),
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
  /** Declared by ideate (one of IDEA_MECHANISMS); null for ideas from before tuning-2. Screen caps entrants per mechanism. */
  mechanism: text('mechanism'),
  /** Short noun phrase for the buyer, e.g. "property manager"; null for ideas from before tuning-2. */
  buyerType: text('buyer_type'),
  /** The function incumbents leave unserved, as claimed by ideate (a model claim, not verified); null for owner ideas and ideas before tuning-4. */
  functionalGap: text('functional_gap'),
  /** Incumbents ideate says it knows (model claim); null for owner ideas and ideas before tuning-4. */
  knownIncumbents: jsonb('known_incumbents').$type<string[]>(),
  signalIds: uuid('signal_ids').array().notNull(),
  embedding: vector('embedding', { dimensions: 1536 }),
  screenScores: jsonb('screen_scores').$type<unknown>(),
  screenTotal: real('screen_total'),
  status: ideaStatus('status').notNull(),
  duplicateOf: uuid('duplicate_of'),
  createdAt: createdAt(),
});

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
});

export const dataCalls = pgTable('data_calls', {
  id: id(),
  runId: uuid('run_id').references(() => runs.id),
  provider: text('provider').notNull(),
  endpoint: text('endpoint').notNull(),
  costUsd: numeric('cost_usd').notNull().default('0'),
  ok: boolean('ok').notNull(),
  createdAt: createdAt(),
});

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
