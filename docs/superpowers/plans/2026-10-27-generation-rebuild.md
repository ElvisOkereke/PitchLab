# Phase 3: Generation Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. TDD per task (failing test first, capture RED). No live model calls and no real network in tests: mock the router. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ideas that are varied (consumer and business, many business models), avoid what's already sold, carry a sourced dollar value-to-user and price, and score barrier to entry. This should get cases out of the gate again, measured by a bench-v2 pass.

**Architecture:**
- New nullable idea columns and `lenses.audience` (migration 0010).
- Consumer lenses and `CONSUMER_SEGMENTS`.
- A library-context retriever (already-sold startups, dead-startup lessons, price points) fed into `ideate.v8`, with per-run lens sampling and an enforced mix with one re-ask.
- `screen.v4` ranks on money case and barrier, with per-model caps and a consumer entrant.
- `gate.v3` relaxes autonomy and gives `generic` the already-sold list.
- `NumberInputs` gains a business model and revenue blocks; `computeNumbers` computes a value multiple; `case-write.v4`.
- The scorecard measures metrics 4, 5 and 11, plus bench-v2.

Prompts are versioned files picked by `loadPrompt` (highest `vN` wins).

**Tech Stack:** existing. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-27-generation-rebuild-design.md`. Binding, including "Decisions settled after the design review".

**Branch:** `generation` in the sibling worktree `Y:/CODING PROJECTS/Business_Case_Gen-generation`, with its own `npm install` and no `.env`. The migration is `0010` (`npx drizzle-kit generate --name generation_rebuild` in `packages/core`). It must only add things.

## Global Constraints

- **Money and cost:**
  - Open and sector runs use at most 6 lenses, with at least 2 consumer lenses when the seed allows; lens seeds use exactly their lenses.
  - At most one mix re-ask per run.
  - Library context is retrieved with SQL plus one embedding per lens.
- **Evidence:**
  - `valueToUser` and `priceHint` must cite a library item id or signal URL, or carry an explicit assumption.
  - Library context reaches prompts only via `wrapUntrusted` / `capField`.
  - The verified-evidence rules from Phase 2 are unchanged.
- **Compatibility:**
  - Existing ideas, cases and `NumberInputs` stay valid and render unchanged. A missing `businessModel` reads as `subscription`; `roiMultiple` is kept.
  - Old prompt versions are kept.
  - bench-v1 stays frozen.
- **Mix anti-goal:** prompts require a consumer idea to name an individual who pays, or whose attention or data is the product. No relabelling business ideas as "both".
- **Existing rulings bind:**
  - R13: escape all text.
  - R20: idempotent re-runs.
  - Bounded queries; bound parameters only.
  - Web-safe core imports, and `check-bundle` stays green.
  - Server Actions follow the existing pattern.
  - Copy is plain, second person; the product name is PitchLab.
- **Merge gates:**
  - Run `npm test -w packages/core`, `npm test -w apps/web`, `npm run typecheck -w apps/web`, `npx tsc --noEmit -p packages/core`, the web build with dummy env, and `npm run check-bundle -w apps/web`.
  - Chain them with `set -o pipefail`, without piping test output through tail/head.
  - Secret scan: 0 token hits, and no tracked `.env`, `.data`, `output`, `.next`, `.crt`, `.pem` or `.superpowers`.
- **Environment:**
  - Never run `gen` or db commands without an explicit `DATABASE_URL=pglite://<temp under .data/>`.
  - Never touch the owner's checkout or Supabase.
  - Commits end with the committing agent's `Co-Authored-By` trailer.

## Review Focus

1. **The model returns ideas missing the new fields, or with an unknown business model.**
   - Expected: they are rejected by zod and dropped with a count in the log.
   - The run continues; the mix check counts only valid ideas.
   - Pinned in Task 3.
2. **The mix is short after the one re-ask.**
   - Expected: the run continues and the shortfall is logged and visible in the run stage output. There is no loop.
   - Pinned in Task 3.
3. **An empty library, or no startup or pricing entries, for a lens.**
   - Expected: the context sections render "none found", and generation proceeds.
   - Pinned in Tasks 2 and 3.
4. **Old cases with old `NumberInputs`.**
   - Expected: identical computed results and an identical Numbers tab.
   - Pinned in Task 5 with a snapshot of an existing case fixture's results before and after.
5. **A value multiple below 1×.**
   - Expected: the case gets the gate flag "value below price" and is kept.
   - Pinned in Task 5.

---

### Task 1: Schema, business models, consumer lenses and segments

**Files:**
- Modify: `packages/core/src/db/schema.ts`, `packages/core/src/db/seed.ts`.
- Generate: `0010`.
- Create: `packages/core/src/pipeline/business-models.ts` (web-safe).
- Test: `packages/core/test/pipeline/business-models.test.ts`; extend `test/db/db.test.ts`.

**Interfaces:**
- **Schema:**
  - `lenses.audience` text `'business' | 'consumer' | 'any'`, not null, default `'business'`.
  - New nullable `ideas` columns:
    - `audience` text
    - `businessModel` text
    - `revenueMechanics` text
    - `valueToUser` jsonb
    - `priceHint` jsonb
    - `barriers` jsonb
    - `libraryItemIds` uuid[]
- **`business-models.ts`:**
  - `BUSINESS_MODELS = ['subscription', 'one_off', 'usage', 'marketplace', 'transaction_fee', 'data_sales', 'ads', 'affiliate', 'licensing', 'freemium', 'service_plus_software'] as const`, with `type BusinessModel`.
  - `AUDIENCES = ['business', 'consumer', 'both'] as const`.
  - `ValueToUserSchema = z.object({ kind: z.enum(['earn', 'save', 'time', 'risk']), amountPerYear: z.number().min(0), basis: z.string().min(1).max(400), source: z.string().max(300).optional() })`.
  - `PriceHintSchema = z.object({ amount: z.number().min(0), unit: z.string().min(1).max(60), basis: z.string().min(1).max(300), source: z.string().max(300).optional() })`.
  - `BarriersSchema = z.object({ toStart: z.number().int().min(1).max(5), toStartWhy: z.string().max(300), toCopy: z.number().int().min(1).max(5), toCopyWhy: z.string().max(300), soloBuildable: z.boolean() })`.
  - `valueMultiple(valueToUser, priceHint, periodsPerYear?: number): number | null`. It annualises the price by unit: month×12, year×1, week×52, one-time×1, per-use uses `periodsPerYear` or returns null.
- **Seed:**
  - Add 6 consumer lenses (ids prefixed `consumer-`, `audience: 'consumer'`): earn on the side, save money automatically, life-stage pain, creator and solo-worker tools, leapfrog markets, AI assistant for a personal chore. Each has a pattern and a promptHint in the style of the existing lenses.
  - Insert with `onConflictDoNothing`.
  - Export `CONSUMER_SEGMENTS`, about 15 strings.

- [ ] **Step 1: Write the failing tests:**
  - The schemas accept valid samples and reject bad ones.
  - `valueMultiple`: 1200/yr ÷ $10/month = 10; one-time price; per-use without periods returns null; price 0 returns null.
  - After `seedDefaults` there are 6 consumer lenses with audience `consumer`, and existing lenses read `business`.
  - The migration applies.
- [ ] **Step 2: Run** `npm test -w packages/core -- business-models db`. Expected: FAIL.
- [ ] **Step 3: Implement.** Generate `0010` and check it only adds things.
- [ ] **Step 4: Run** the core and web suites, the web typecheck and core tsc. Expected: PASS (update fixtures for the new lens column if needed).
- [ ] **Step 5: Commit** `feat(core): idea money and barrier fields, consumer lenses and segments`.

### Task 2: Library context for ideation

**Files:**
- Create: `packages/core/src/library/context.ts` (web-safe).
- Test: `packages/core/test/library/context.test.ts`.

**Interfaces:**
- `type IdeationContext = { alreadySold: CtxStartup[]; lessons: CtxStartup[]; pricing: CtxPricing[] }`.
  - `CtxStartup = { id; name; whatItDoes; outcome; why?; url }`
  - `CtxPricing = { id; product; pricePoints; buyer; url }`
- `ideationContext(db, queryVector: number[], opts: { countries?: string[]; alreadySoldMax?: number; lessonsMax?: number; pricingMax?: number }): Promise<IdeationContext>`.
  - Defaults are 15, 8 and 15.
  - Only active entries with an embedding are considered.
  - alreadySold = `startup` entries with outcome active, acquired or public.
  - lessons = `startup` entries with outcome dead, preferring those with `why`.
  - pricing = `pricing` entries, whether or not their quote is verified, because facts carry the prices.
  - Results are ordered by similarity, with the same L1 country rule as `retrieveForRun`.
  - The facts are parsed with `parseFacts`, and invalid ones are skipped.
- `renderIdeationContext(ctx): { alreadySold: string; lessons: string; pricing: string }`.
  - Each section is a capped plain-text block, and "none found" when empty.
  - The caller wraps each block with `wrapUntrusted`.

- [ ] **Step 1: Write the failing tests:**
  - Seed library entries of each kind and outcome (vectors via `unit(i)`).
  - Assert classification, caps, ordering, the country rule, that rejected entries are excluded, that invalid facts are skipped, and that empty lists render "none found".
- [ ] **Step 2: Run** `npm test -w packages/core -- context`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -w packages/core`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): library context for ideation`.

### Task 3: Ideate v8 with lens sampling, library context and enforced mix

**Files:**
- Create: `packages/core/prompts/ideate.v8.md`.
- Modify: `packages/core/src/pipeline/ideate.ts`.
- Test: extend `packages/core/test/pipeline/ideate.test.ts`.

**Interfaces:**
- **Schema:** the generated idea schema gains:
  - `audience: z.enum(AUDIENCES)`
  - `businessModel: z.enum(BUSINESS_MODELS)`
  - `revenueMechanics: z.string().min(1).max(400)`
  - `valueToUser: ValueToUserSchema`
  - `priceHint: PriceHintSchema`
  - `barriers: BarriersSchema`
  - `libraryItemIds: z.array(z.string().uuid()).max(10)`

  Invalid ideas are dropped and counted. Owner ideas get the new fields as optional, so an owner idea may leave them null.
- **Lens sampling:** `selectLenses(all, cfg, rng): Lens[]`.
  - Lens seeds use exactly the chosen ones.
  - Otherwise pick at most `MAX_LENSES_PER_RUN = 6` active lenses, at least `MIN_CONSUMER_LENSES = 2` consumer ones when available, the rest from business or any lenses.
  - Sampling is seeded by the run id, so re-runs are deterministic (R20).
- **Consumer segments:** open seeds pass `CONSUMER_SEGMENTS` (a random 5, seeded by the run id) to the prompt next to the sectors.
- **Per lens:**
  - Embed `lens.pattern + seed text` once.
  - Call `ideationContext` with the market's countries and render the sections.
  - The prompt gets `alreadySold`, `lessons` and `pricing` blocks, each wrapped as untrusted, plus the rules from spec §2.
- **Mix (after all lenses):**
  - `checkMix(ideas): { consumerShare: number; models: number; short: { consumer: number; models: BusinessModel[] } }` with targets `MIN_CONSUMER_SHARE = 0.3` and `MIN_MODELS = 4`.
  - If short, make one re-ask (`ideate.v8` with a "fill the gap" instruction listing the needed count and the unused models, using consumer lenses or segments), then add the valid results.
  - Log `ideate: mix consumer X% models N (re-ask: yes/no, still short: …)` and include `mix` in the stage output.
- **Storage:** store all new columns on each idea row.

- [ ] **Step 1: Write the failing tests** (mock router):
  - New fields are parsed and stored; an invalid business model is dropped and counted.
  - `selectLenses`: at most 6 lenses with at least 2 consumer when available; lens seeds are exact; the choice is deterministic per run id.
  - Library context blocks appear inside the untrusted wrappers in the prompt; an empty library renders "none found".
  - The mix re-ask fires when short and appends ideas; there is no second re-ask; the shortfall is logged and in the stage output.
  - Open seeds include consumer segments.
  - Owner ideas still work.
- [ ] **Step 2: Run** `npm test -w packages/core -- ideate`. Expected: FAIL.
- [ ] **Step 3: Implement**, including the prompt v8 text: rules, the named-buyer rule, the source and assumption rule, the barrier definitions, and avoiding control dependencies.
- [ ] **Step 4: Run** the core suite and core tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): ideate v8 — library context, consumer lenses and enforced mix`.

### Task 4: Screen v4 and Gate v3

**Files:**
- Create: `packages/core/prompts/screen.v4.md` and `gate.v3.md`.
- Modify: `packages/core/src/pipeline/screen.ts` and `gate.ts`.
- Test: extend `test/pipeline/screen.test.ts` and `gate.test.ts`.

**Interfaces:**
- **Screen:**
  - The screen schema gains `moneyCase` and `barrier` scores (1–5).
  - `moneyCase` bands come from the idea's `valueMultiple`: ≥10 → 5, ≥5 → 4, ≥3 → 3, ≥1.5 → 2, else 1; null → 2. Computed in code and passed to the prompt as context. The model may not override a computed band.
  - `barrier` = round(((6 − toStart) + toCopy) / 2), clamped 1–5; null → 3. Computed in code.
  - Rank = mean(existing criteria + novelty + moneyCase + barrier).
  - Replace `MAX_PER_MECHANISM` with `MAX_PER_BUSINESS_MODEL = 2` (a null model is not capped).
  - Guarantee at least 1 consumer or both entrant if any such idea passes the existing thresholds (swap out the lowest-ranked business entrant).
- **Gate:**
  - `gate.v3`: `autonomy` FAILs only when delivery is mostly human labour; software-led delivery with light per-customer setup or review passes, with the labour noted.
  - `generic` additionally gets the idea's `alreadySold` library context (via `ideationContext` with the idea's embedding) wrapped as untrusted.
  - Other checks are unchanged.

- [ ] **Step 1: Write the failing tests:**
  - The band and barrier math.
  - The ranking includes the new scores.
  - The per-model cap; the consumer-entrant swap.
  - The gate prompt for autonomy uses the v3 wording.
  - The `generic` prompt contains the already-sold block, and "none found" when empty.
- [ ] **Step 2: Run** `npm test -w packages/core -- screen gate`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the core suite and core tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): screen v4 money and barrier ranking, gate v3`.

### Task 5: Business models in the numbers and case-write v4

**Files:**
- Modify: `packages/core/src/calc/schema.ts`, `calc/numbers.ts`, `case/schema.ts`, `pipeline/deep-case.ts`, and `apps/web/components/tabs/numbers.tsx` (and summary display).
- Create: `packages/core/prompts/case-write.v4.md`.
- Test: `packages/core/test/calc/numbers.test.ts`, deep-case tests, and web numbers-tab tests.

**Interfaces:**
- **`NumberInputsSchema` gains:**
  - `businessModel: z.enum(BUSINESS_MODELS).optional()` (absent → subscription);
  - `revenue: z.discriminatedUnion('model', […]).optional()`, with one variant per model whose fields are all `SourcedSchema`:
    - marketplace: `{ gmvPerBuyerPerYear, takeRate }`
    - usage: `{ unitPrice, unitsPerBuyerPerYear }`
    - ads: `{ usersPerYear… }`, or per buyer as `{ impressionsPerUserPerYear, cpm }`
    - affiliate: `{ referralsPerBuyerPerYear, commission }`
    - freemium: `{ conversionRate, paidPricePerYear }`
    - transaction_fee: `{ transactionsPerBuyerPerYear, feePerTransaction }`
    - one_off: `{ price, repeatPurchasesPerYear }`
    - data_sales and licensing: `{ pricePerClientPerYear }`
    - service_plus_software: `{ subscriptionPerYear, setupFee }`
  - `valueToUserPerYear: SourcedSchema.optional()`.
- **`computeNumbers`:**
  - When `revenue` is present, annual revenue per buyer comes from the model formula; otherwise from the existing price fields.
  - When `valueToUserPerYear` is present, buyer annual savings uses it instead of problemCost × reduction.
  - Output adds `buyer.valueMultiple` (= value ÷ annual price) and `revenueFormula: string`.
  - `roiMultiple` is kept and equals `valueMultiple` when value is used.
  - The existing outputs for old inputs are unchanged.
- **deep-case:**
  - Uses `case-write.v4`, which tells the writer the idea's business model, value and price hints, and requires matching revenue inputs.
  - Adds the gate flag "value below price" when `valueMultiple < 1`.
- **Web:** the Numbers tab shows the business model, the revenue formula and the value multiple when present. The Summary tab shows audience, business model, value to user and barriers when present. All as text.

- [ ] **Step 1: Write the failing tests:**
  - Each model formula with known numbers.
  - The value multiple.
  - The old-input snapshot is unchanged: take an existing fixture's results before the change and assert deep equality after.
  - The flag is added when below 1×.
  - The web tabs render the new fields, and old cases look the same.
- [ ] **Step 2: Run** `npm test -w packages/core -- numbers deep-case` and `npm test -w apps/web -- numbers summary`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the core and web suites, both typechecks, the build and check-bundle. Expected: PASS.
- [ ] **Step 5: Commit** `feat: business-model revenue, value multiple and case-write v4`.

### Task 6: Scorecard metrics, bench-v2 and docs

**Files:**
- Modify: `packages/core/src/bench/{definitions,scorecard}.ts`.
- Docs: README, `docs/user-guide.md`, `docs/architecture.md`, `docs/glossary.md` + `apps/web/lib/glossary.ts` (business model, value multiple, barriers), `docs/CONTEXT.md`, `docs/OWNER-TODO.md`.
- Test: extend the scorecard and definitions tests.

**Interfaces:**
- **Metrics:**
  - **consumerShare:** generated ideas in the set with audience consumer or both ÷ those with audience set. `no_data` if none. Meets at ≥ 0.3.
  - **modelVariety:** distinct `business_model` per run averaged over runs with ≥ 1 set. Meets at ≥ 4.
  - **easyStartHardCopy:** cases whose idea has `barriers.toStart ≤ 2 && toCopy ≥ 4` ÷ cases whose idea has barriers. Meets at ≥ 0.5.
  - **customerReturn:** uses `numbers.results.buyer.valueMultiple ?? roiMultiple`.
  - The `phase` markers on these three metrics in `METRIC_DEFS` are removed.
- **Benchmark:**
  - `BENCHMARKS['bench-v2']` = bench-v1's 4 seeds plus `{ seedType: 'lens', lensIds: ['consumer-earn-side', 'consumer-save-auto'] }`, with the actual ids from Task 1.
  - `costNote` = 'about $15–35 in model calls (5 runs at about $3–7 each)'.
  - `CURRENT_BENCHMARK = 'bench-v2'`.
  - The bench-v1 frozen test is unchanged; add a bench-v2 frozen test.
- **Docs:** explain the new fields, the business models, the value multiple, the barriers, consumer lenses and bench-v2. In OWNER-TODO, add "Run a bench-v2 pass after merging and score the cases".

- [ ] **Step 1: Write the failing tests:**
  - The three metrics on fixtures, including `no_data` for old data.
  - customerReturn prefers the value multiple.
  - The bench-v2 definition is frozen and its lens ids exist in the seed.
  - The glossary-sync and docs-links guards pass.
- [ ] **Step 2: Run** `npm test -w packages/core -- scorecard definitions` and `npm test -w apps/web -- glossary docs-links`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** all gates. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): consumer, model and barrier metrics; bench-v2` and `docs: generation rebuild`.

### Task 7: Merge and measure (controller)

- [ ] **Step 1:** Run the gates and the secret scan. Fast-forward `main`, run `npm install` and `npm run gen -- runs` in the owner's checkout to migrate Supabase, then push and remove the worktree.
- [ ] **Step 2:** Run `npm run gen -- bench run` (bench-v2), then `gen worker --once` × 5, then `gen bench report`. Report the scorecard against baseline-0 and bench-v1 #1 to the owner, with the cost.
