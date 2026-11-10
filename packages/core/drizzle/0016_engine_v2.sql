CREATE TYPE "public"."judge_split" AS ENUM('train', 'test');--> statement-breakpoint
CREATE TYPE "public"."match_phase" AS ENUM('main', 'final');--> statement-breakpoint
CREATE TYPE "public"."match_result" AS ENUM('a', 'b', 'draw');--> statement-breakpoint
CREATE TYPE "public"."match_verdict" AS ENUM('a', 'b', 'draw', 'error');--> statement-breakpoint
CREATE TYPE "public"."sketch_operator" AS ENUM('sharpen', 'combine', 'simplify');--> statement-breakpoint
CREATE TYPE "public"."sketch_status" AS ENUM('kept', 'duplicate', 'near_killed', 'evolved');--> statement-breakpoint
CREATE TABLE "judge_pairs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kept_idea_id" uuid NOT NULL,
	"killed_idea_id" uuid NOT NULL,
	"pair_hash" text NOT NULL,
	"split" "judge_split" NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sketches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"lens_id" text,
	"title" text NOT NULL,
	"buyer" text NOT NULL,
	"problem" text NOT NULL,
	"how_it_earns" text NOT NULL,
	"business_model" text NOT NULL,
	"edge" text NOT NULL,
	"edge_kind" text NOT NULL,
	"why_not_trivial" text NOT NULL,
	"earn_or_save" text NOT NULL,
	"signal_ids" uuid[] NOT NULL,
	"library_item_ids" uuid[] NOT NULL,
	"embedding" vector(1536),
	"cell" text,
	"status" "sketch_status" NOT NULL,
	"elo" real,
	"parent_sketch_id" uuid,
	"operator" "sketch_operator",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tournament_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"phase" "match_phase" NOT NULL,
	"round" integer NOT NULL,
	"a_id" uuid NOT NULL,
	"b_id" uuid NOT NULL,
	"verdict_ab" "match_verdict" NOT NULL,
	"verdict_ba" "match_verdict" NOT NULL,
	"result" "match_result" NOT NULL,
	"confidence" real NOT NULL,
	"reasons" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "sketch_id" uuid;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "elo" real;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD COLUMN "assessment" jsonb;--> statement-breakpoint
ALTER TABLE "judge_pairs" ADD CONSTRAINT "judge_pairs_kept_idea_id_ideas_id_fk" FOREIGN KEY ("kept_idea_id") REFERENCES "public"."ideas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judge_pairs" ADD CONSTRAINT "judge_pairs_killed_idea_id_ideas_id_fk" FOREIGN KEY ("killed_idea_id") REFERENCES "public"."ideas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sketches" ADD CONSTRAINT "sketches_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sketches" ADD CONSTRAINT "sketches_lens_id_lenses_id_fk" FOREIGN KEY ("lens_id") REFERENCES "public"."lenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sketches" ADD CONSTRAINT "sketches_parent_sketch_id_sketches_id_fk" FOREIGN KEY ("parent_sketch_id") REFERENCES "public"."sketches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_a_id_sketches_id_fk" FOREIGN KEY ("a_id") REFERENCES "public"."sketches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tournament_matches" ADD CONSTRAINT "tournament_matches_b_id_sketches_id_fk" FOREIGN KEY ("b_id") REFERENCES "public"."sketches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "judge_pairs_pair_hash_uq" ON "judge_pairs" USING btree ("pair_hash");--> statement-breakpoint
CREATE INDEX "sketches_run_idx" ON "sketches" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tournament_matches_pair_uq" ON "tournament_matches" USING btree ("run_id","phase","round","a_id","b_id");