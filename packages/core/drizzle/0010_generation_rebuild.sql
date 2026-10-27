ALTER TABLE "ideas" ADD COLUMN "audience" text;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "business_model" text;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "revenue_mechanics" text;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "value_to_user" jsonb;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "price_hint" jsonb;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "barriers" jsonb;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "library_item_ids" uuid[];--> statement-breakpoint
ALTER TABLE "lenses" ADD COLUMN "audience" text DEFAULT 'business' NOT NULL;