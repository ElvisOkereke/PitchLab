ALTER TYPE "public"."gate_check" ADD VALUE 'scale';--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "scale_estimate" jsonb;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "scale_result" jsonb;