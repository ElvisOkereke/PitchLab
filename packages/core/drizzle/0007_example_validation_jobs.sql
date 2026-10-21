CREATE TABLE "validation_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"options" jsonb NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"steps" jsonb,
	"error" text,
	"cost_usd" numeric DEFAULT '0' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "is_example" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "is_example" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "validation_jobs" ADD CONSTRAINT "validation_jobs_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "validation_jobs_status_created_idx" ON "validation_jobs" USING btree ("status","created_at");