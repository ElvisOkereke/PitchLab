CREATE TYPE "public"."casl_basis" AS ENUM('self_published', 'third_party', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."landing_event_type" AS ENUM('visit', 'submit');--> statement-breakpoint
CREATE TYPE "public"."outreach_event_type" AS ENUM('sent', 'replied', 'positive', 'meeting', 'not_interested', 'unsubscribe', 'note');--> statement-breakpoint
CREATE TYPE "public"."outreach_kind" AS ENUM('cold', 'followup1', 'followup2');--> statement-breakpoint
CREATE TYPE "public"."prospect_source" AS ENUM('web_research', 'places', 'csv', 'manual');--> statement-breakpoint
CREATE TYPE "public"."prospect_status" AS ENUM('new', 'drafted', 'sent', 'replied', 'positive', 'meeting', 'not_interested', 'unsubscribed');--> statement-breakpoint
CREATE TABLE "landing_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"landing_page_id" uuid NOT NULL,
	"type" "landing_event_type" NOT NULL,
	"email" text,
	"company" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "landing_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"html" text NOT NULL,
	"copy" jsonb NOT NULL,
	"published_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "landing_pages_case_id_unique" UNIQUE("case_id")
);
--> statement-breakpoint
CREATE TABLE "outreach_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prospect_id" uuid NOT NULL,
	"kind" "outreach_kind" NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outreach_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prospect_id" uuid NOT NULL,
	"type" "outreach_event_type" NOT NULL,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prospects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"name" text NOT NULL,
	"website" text NOT NULL,
	"domain" text NOT NULL,
	"location" text NOT NULL,
	"country" text,
	"size_note" text,
	"fit_reason" text NOT NULL,
	"contact_name" text,
	"contact_role" text,
	"email" text,
	"email_source_url" text,
	"email_captured_at" timestamp with time zone,
	"casl_basis" "casl_basis" DEFAULT 'unknown' NOT NULL,
	"source" "prospect_source" NOT NULL,
	"status" "prospect_status" DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"email" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppressions_email_lower" CHECK ("suppressions"."email" = lower("suppressions"."email"))
);
--> statement-breakpoint
CREATE TABLE "validation_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"sections" jsonb NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "validation_packs_case_id_unique" UNIQUE("case_id")
);
--> statement-breakpoint
ALTER TABLE "landing_events" ADD CONSTRAINT "landing_events_landing_page_id_landing_pages_id_fk" FOREIGN KEY ("landing_page_id") REFERENCES "public"."landing_pages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "landing_pages" ADD CONSTRAINT "landing_pages_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_events" ADD CONSTRAINT "outreach_events_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "validation_packs" ADD CONSTRAINT "validation_packs_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outreach_drafts_prospect_kind_uq" ON "outreach_drafts" USING btree ("prospect_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "prospects_case_domain_uq" ON "prospects" USING btree ("case_id","domain");