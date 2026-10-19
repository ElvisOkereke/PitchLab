ALTER TABLE "ideas" ADD COLUMN "functional_gap" text;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "known_incumbents" jsonb;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "voice" text;