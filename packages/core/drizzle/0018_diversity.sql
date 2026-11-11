INSERT INTO "markets" ("id", "name", "countries", "language", "currency", "sectors")
VALUES ('broad', 'North America, all tiers', ARRAY['CA', 'US'], 'en', 'USD', ARRAY[
'insurance carriers',
'banks and credit unions',
'health systems and hospitals',
'health insurers and payers',
'pharma and life sciences',
'utilities and energy',
'telecom',
'manufacturing',
'chemicals',
'aerospace and defence suppliers',
'government agencies',
'universities',
'logistics shippers and 3PLs',
'wholesale and distribution',
'commercial real estate',
'construction general contractors',
'engineering firms',
'staffing agencies',
'law firms',
'accounting firms',
'HR and payroll',
'fintech and payments',
'B2B SaaS companies',
'data and AI teams',
'cybersecurity',
'ecommerce marketplaces',
'media and publishers',
'automotive dealers',
'agriculture and food processing',
'mining',
'specialty retail chains',
'hospitality groups',
'franchise groups',
'multi-location clinics',
'field services',
'ecommerce brands'
])
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
ALTER TYPE "public"."gate_check" ADD VALUE 'buyers';--> statement-breakpoint
UPDATE "lenses" SET "weight" = 0.5 WHERE "id" IN ('money-leak', 'silent-failure', 'review-gap', 'platform-shockwave');--> statement-breakpoint
UPDATE "lenses" SET "weight" = 1.5 WHERE "id" IN ('new-capability', 'ai-replaces-labour', 'data-flywheel', 'compliance-demand', 'picks-and-shovels', 'ten-x-incumbent');--> statement-breakpoint
INSERT INTO "lenses" ("id", "name", "pattern", "prompt_hint", "active", "audience", "weight")
VALUES ('industry-shift', 'Industry shift', 'A structural change across a large industry (regulation, technology, labour, capital) that forces thousands of companies to change how they work; build what they will all need.', 'Find a structural change across a large industry (regulation, technology, labour or capital) in the signals that forces thousands of companies to change how they work, and propose what they will all need. Name today''s option, the change forcing the move, and the concrete advantage.', true, 'business', 1.5)
ON CONFLICT ("id") DO NOTHING;
