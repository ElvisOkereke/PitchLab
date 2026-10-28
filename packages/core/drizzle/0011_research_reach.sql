CREATE TYPE "public"."fetch_outcome" AS ENUM('ok', 'http_403', 'http_404', 'http_410', 'http_4xx', 'http_5xx', 'timeout', 'blocked_robots', 'blocked_host', 'too_large', 'not_html', 'thin_text', 'network');--> statement-breakpoint
CREATE TYPE "public"."fetch_via" AS ENUM('direct', 'archive', 'browser');--> statement-breakpoint
CREATE TABLE "page_fetches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url_domain" text NOT NULL,
	"outcome" "fetch_outcome" NOT NULL,
	"via" "fetch_via" DEFAULT 'direct' NOT NULL,
	"status" integer,
	"mission_id" uuid,
	"run_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "via" "fetch_via" DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN "snapshot_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "page_fetches" ADD CONSTRAINT "page_fetches_mission_id_research_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."research_missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_fetches" ADD CONSTRAINT "page_fetches_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_fetches_at_idx" ON "page_fetches" USING btree ("at");--> statement-breakpoint
CREATE INDEX "page_fetches_url_domain_idx" ON "page_fetches" USING btree ("url_domain");