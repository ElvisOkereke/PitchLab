CREATE TYPE "public"."benchmark_kind" AS ENUM('baseline', 'pass', 'recompute');--> statement-breakpoint
CREATE TYPE "public"."benchmark_status" AS ENUM('running', 'complete', 'incomplete');--> statement-breakpoint
CREATE TABLE "benchmark_passes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text NOT NULL,
	"label" text NOT NULL,
	"kind" "benchmark_kind" NOT NULL,
	"status" "benchmark_status" NOT NULL,
	"run_ids" uuid[] NOT NULL,
	"metrics" jsonb,
	"source_pass_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "benchmark_pass_id" uuid;--> statement-breakpoint
ALTER TABLE "benchmark_passes" ADD CONSTRAINT "benchmark_passes_source_pass_id_benchmark_passes_id_fk" FOREIGN KEY ("source_pass_id") REFERENCES "public"."benchmark_passes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_benchmark_pass_id_benchmark_passes_id_fk" FOREIGN KEY ("benchmark_pass_id") REFERENCES "public"."benchmark_passes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_benchmark_pass_idx" ON "runs" USING btree ("benchmark_pass_id");