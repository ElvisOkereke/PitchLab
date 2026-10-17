CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TYPE "public"."case_stage" AS ENUM('new', 'validating', 'pilot', 'live', 'killed');--> statement-breakpoint
CREATE TYPE "public"."claim_verified" AS ENUM('unverified', 'verified', 'unsupported', 'unreachable');--> statement-breakpoint
CREATE TYPE "public"."criterion" AS ENUM('pain', 'roi', 'evidence', 'speed', 'autonomy', 'novelty', 'reach', 'gut');--> statement-breakpoint
CREATE TYPE "public"."gate_check" AS ENUM('generic', 'regulation', 'control', 'autonomy', 'reachability', 'evidence');--> statement-breakpoint
CREATE TYPE "public"."idea_origin" AS ENUM('generated', 'owner');--> statement-breakpoint
CREATE TYPE "public"."idea_status" AS ENUM('candidate', 'duplicate', 'screened_out', 'gated_out', 'advanced');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."score_by" AS ENUM('ai', 'owner');--> statement-breakpoint
CREATE TYPE "public"."stage_status" AS ENUM('running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idea_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"stage" "case_stage" DEFAULT 'new' NOT NULL,
	"sections" jsonb NOT NULL,
	"kill_reason" text,
	"gate_advisory" boolean NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cases_idea_id_unique" UNIQUE("idea_id"),
	CONSTRAINT "cases_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"section" text NOT NULL,
	"text" text NOT NULL,
	"source_url" text NOT NULL,
	"quote" text,
	"verified" "claim_verified" DEFAULT 'unverified' NOT NULL,
	"confidence" real,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"provider" text NOT NULL,
	"endpoint" text NOT NULL,
	"cost_usd" numeric DEFAULT '0' NOT NULL,
	"ok" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gate_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idea_id" uuid NOT NULL,
	"check" "gate_check" NOT NULL,
	"pass" boolean NOT NULL,
	"reasoning" text NOT NULL,
	"sources" jsonb,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ideas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"lens_id" text,
	"origin" "idea_origin" NOT NULL,
	"title" text NOT NULL,
	"one_liner" text NOT NULL,
	"buyer" text NOT NULL,
	"problem" text NOT NULL,
	"solution" text NOT NULL,
	"signal_ids" uuid[] NOT NULL,
	"embedding" vector(1536),
	"screen_scores" jsonb,
	"screen_total" real,
	"status" "idea_status" NOT NULL,
	"duplicate_of" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lenses" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"pattern" text NOT NULL,
	"prompt_hint" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"stage" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"search_requests" integer NOT NULL,
	"cost_usd" numeric NOT NULL,
	"latency_ms" integer NOT NULL,
	"prompt_version" text NOT NULL,
	"ok" boolean NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"countries" text[] NOT NULL,
	"language" text NOT NULL,
	"currency" text NOT NULL,
	"sectors" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_stages" (
	"run_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"status" "stage_status" NOT NULL,
	"output" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_stages_run_id_stage_pk" PRIMARY KEY("run_id","stage")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"config" jsonb NOT NULL,
	"status" "run_status" NOT NULL,
	"current_stage" text,
	"error" text,
	"cost_usd" numeric DEFAULT '0' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"criterion" "criterion" NOT NULL,
	"value" integer NOT NULL,
	"note" text NOT NULL,
	"by" "score_by" NOT NULL,
	"model" text,
	"prompt_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scores_value_range" CHECK ("scores"."value" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"market_id" text NOT NULL,
	"source" text NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"quote" text NOT NULL,
	"quote_hash" text NOT NULL,
	"sector" text,
	"pain_type" text,
	"published_at" timestamp with time zone,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_calls" ADD CONSTRAINT "data_calls_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_verdicts" ADD CONSTRAINT "gate_verdicts_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ideas" ADD CONSTRAINT "ideas_lens_id_lenses_id_fk" FOREIGN KEY ("lens_id") REFERENCES "public"."lenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_stages" ADD CONSTRAINT "run_stages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_market_id_markets_id_fk" FOREIGN KEY ("market_id") REFERENCES "public"."markets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "signals_url_quote_hash_uq" ON "signals" USING btree ("url","quote_hash");