CREATE TYPE "public"."find_source" AS ENUM('telegram', 'paste');--> statement-breakpoint
CREATE TYPE "public"."find_status" AS ENUM('queued', 'capturing', 'done', 'failed');--> statement-breakpoint
ALTER TYPE "public"."fetch_via" ADD VALUE 'real_browser';--> statement-breakpoint
ALTER TYPE "public"."fetch_via" ADD VALUE 'scraper';--> statement-breakpoint
ALTER TYPE "public"."knowledge_kind" ADD VALUE 'find';--> statement-breakpoint
CREATE TABLE "finds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"platform" text NOT NULL,
	"title" text,
	"note" text,
	"source" "find_source" NOT NULL,
	"status" "find_status" DEFAULT 'queued' NOT NULL,
	"caption" text,
	"transcript" text,
	"screen_text" text,
	"stats" jsonb,
	"error" text,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"knowledge_item_id" uuid,
	"started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"captured_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "finds" ADD CONSTRAINT "finds_knowledge_item_id_knowledge_items_id_fk" FOREIGN KEY ("knowledge_item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finds_url_uq" ON "finds" USING btree ("url");--> statement-breakpoint
CREATE INDEX "finds_status_created_idx" ON "finds" USING btree ("status","created_at");