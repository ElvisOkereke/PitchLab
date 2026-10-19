import { sql } from 'drizzle-orm';
import type { CaseSections } from '../case/schema';
import type { RunConfig } from '../pipeline/types';
import {
  pgTable, pgEnum, text, uuid, boolean, integer, real, numeric, jsonb, timestamp,
  vector, primaryKey, uniqueIndex, check,
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

export const runs = pgTable('runs', {
  id: id(),
  config: jsonb('config').$type<RunConfig>().notNull(),
  status: runStatus('status').notNull(),
  currentStage: text('current_stage'),
  error: text('error'),
  costUsd: numeric('cost_usd').notNull().default('0'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: createdAt(),
});

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
