ALTER TYPE "public"."claim_verified" ADD VALUE 'needs_review';--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "review_note" text;