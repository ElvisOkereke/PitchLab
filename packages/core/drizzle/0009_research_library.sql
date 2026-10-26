CREATE TYPE "public"."knowledge_kind" AS ENUM('problem', 'startup', 'pricing', 'trend', 'rule_change', 'market');--> statement-breakpoint
CREATE TYPE "public"."knowledge_status" AS ENUM('active', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."mission_origin" AS ENUM('owner', 'background');--> statement-breakpoint
CREATE TABLE "knowledge_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "knowledge_kind" NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"quote" text,
	"quote_verified" boolean DEFAULT false NOT NULL,
	"audience" text NOT NULL,
	"countries" text[] NOT NULL,
	"industries" text[] NOT NULL,
	"voice" text,
	"facts" jsonb NOT NULL,
	"embedding" vector(1536),
	"content_hash" text NOT NULL,
	"status" "knowledge_status" DEFAULT 'active' NOT NULL,
	"reject_reason" text,
	"mission_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"url" text NOT NULL,
	"domain" text NOT NULL,
	"source_type" text NOT NULL,
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"quote" text,
	"quote_verified" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "research_missions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic" text NOT NULL,
	"kinds" text[] NOT NULL,
	"countries" text[] NOT NULL,
	"audience" text,
	"budget_usd" numeric NOT NULL,
	"cost_usd" numeric DEFAULT '0' NOT NULL,
	"origin" "mission_origin" NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"items_added" integer DEFAULT 0 NOT NULL,
	"items_merged" integer DEFAULT 0 NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "data_calls" ADD COLUMN "mission_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD COLUMN "mission_id" uuid;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "knowledge_item_id" uuid;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_mission_id_research_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."research_missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_item_id_knowledge_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_items_content_hash_uq" ON "knowledge_items" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "knowledge_items_kind_status_idx" ON "knowledge_items" USING btree ("kind","status");--> statement-breakpoint
CREATE INDEX "knowledge_items_updated_idx" ON "knowledge_items" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_sources_item_url_uq" ON "knowledge_sources" USING btree ("item_id","url");--> statement-breakpoint
CREATE INDEX "knowledge_sources_source_type_idx" ON "knowledge_sources" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX "knowledge_sources_domain_idx" ON "knowledge_sources" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "research_missions_status_created_idx" ON "research_missions" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "data_calls" ADD CONSTRAINT "data_calls_mission_id_research_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."research_missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_mission_id_research_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."research_missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_knowledge_item_id_knowledge_items_id_fk" FOREIGN KEY ("knowledge_item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE no action ON UPDATE no action;