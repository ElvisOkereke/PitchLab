CREATE TYPE "public"."stage_event_kind" AS ENUM('move', 'overturn', 'kill');--> statement-breakpoint
CREATE TABLE "stage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"from_stage" "case_stage" NOT NULL,
	"to_stage" "case_stage" NOT NULL,
	"kind" "stage_event_kind" NOT NULL,
	"note" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stage_events" ADD CONSTRAINT "stage_events_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stage_events_case_at_idx" ON "stage_events" USING btree ("case_id","at");