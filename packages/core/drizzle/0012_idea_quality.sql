CREATE TABLE "idea_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"idea_id" uuid NOT NULL,
	"scale" integer NOT NULL,
	"edge" integer NOT NULL,
	"novelty" integer NOT NULL,
	"niche" integer NOT NULL,
	"reasons" jsonb NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idea_reviews_scale_range" CHECK ("idea_reviews"."scale" between 1 and 5),
	CONSTRAINT "idea_reviews_edge_range" CHECK ("idea_reviews"."edge" between 1 and 5),
	CONSTRAINT "idea_reviews_novelty_range" CHECK ("idea_reviews"."novelty" between 1 and 5),
	CONSTRAINT "idea_reviews_niche_range" CHECK ("idea_reviews"."niche" between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "owner_rating" smallint;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "owner_tags" text[];--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "owner_rated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "edge" jsonb;--> statement-breakpoint
ALTER TABLE "ideas" ADD COLUMN "scale" jsonb;--> statement-breakpoint
ALTER TABLE "lenses" ADD COLUMN "weight" real;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "kind" text DEFAULT 'pain' NOT NULL;--> statement-breakpoint
ALTER TABLE "idea_reviews" ADD CONSTRAINT "idea_reviews_idea_id_ideas_id_fk" FOREIGN KEY ("idea_id") REFERENCES "public"."ideas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idea_reviews_idea_prompt_uq" ON "idea_reviews" USING btree ("idea_id","prompt_version");