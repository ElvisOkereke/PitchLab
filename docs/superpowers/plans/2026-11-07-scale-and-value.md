# Scale and Value Round Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. TDD per task (failing test first, capture RED). No live model or network calls in tests: mock the router. Steps use checkbox (`- [ ]`) syntax.

**Goal:**
- Realistic paying buyers and a revenue ceiling, computed in code from a sourced estimate.
- A gate kill line at $1M a year.
- "Earn" ideas preferred over "save" ideas.
- Board decisions count as the owner's verdict.
- The new rule is backtested against the owner's 55 decided cases before the next pass.

**Architecture:**
- Migration `0013` adds:
  - `ideas.scale_estimate` and `ideas.scale_result` (jsonb);
  - the `gate_check` value `scale`.
- `computeScale` is pure, in `business-models.ts`.
- New prompts, kept beside the old ones:
  - ideate v13;
  - a `scale-estimate.v1` stage with `gen audit scale`;
  - screen v6 (scale and upside computed in code);
  - gate v6 (a `scale` code check);
  - reviewer v2.
- Scorecard: `ownerKeeps`, plus Board-aware agreement.
- `gen audit backtest`.

**Tech Stack:** existing.

**Spec:** `docs/superpowers/specs/2026-11-07-scale-and-value-design.md`. Binding.

**Branch:** `scale` in the sibling worktree `Y:/CODING PROJECTS/Business_Case_Gen-scale`, with its own `npm install` and no `.env`. Migration `0013` (`npx drizzle-kit generate --name scale_and_value`; the enum value is added with `ALTER TYPE … ADD VALUE`, so check the generated SQL).

## Global Constraints

- **`ScaleEstimateSchema`:**
  - `buyerUnit`: `'businesses' | 'individuals'`.
  - `population`: `{count ≥ 0, basis ≤ 300, source?}`.
  - `shareWithProblem` and `shareWillingToPay`: `{pct 0–100, basis ≤ 300, source?}`.
  - `shareReachable`: `{pct 0–100, basis ≤ 300}`.
- **Caps** (applied only when the share has no source; a sourced share is just clamped to 0–100):
  - `shareWillingToPay`: individuals 3%, businesses 15%.
  - `shareReachable`: 20% (it never has a source).
  - `shareWithProblem`: 60%.
- **Annual price:** the same unit rules as `valueMultiple`. When the price can't be annualised, the revenue ceiling is null and the band is 2.
- **Bands by revenue ceiling:**
  - under $250k: 1;
  - under $1M: 2;
  - under $5M: 3;
  - under $25M: 4;
  - otherwise: 5.
- **Gate `scale` check:**
  - Generated ideas FAIL when `revenueCeiling < gate.minRevenueCeiling` (default 1,000,000).
  - With no estimate, the check passes with the note "no estimate".
  - With a null ceiling (price unknown), the check passes with a note.
  - For owner ideas the check is advisory.
- **Screen v6:**
  - `scale` is the band from `scale_result` (2 when missing).
  - `upside`: earn 5, time 3, risk 3, save 2, missing 3.
  - All weights 1, except speed 0.5.
- **`ownerKeeps`:** the denominator is cases in the set whose stage is not `new`; kept means validating, pilot or live. It meets at 0.5.
- **Reviewer agreement:** an owner rating of ±1 wins. Otherwise a decided case counts: kept as liked, killed as disliked.
- **Existing rulings bind:**
  - R13 and R20;
  - untrusted text wrapped;
  - bounded queries, bound parameters only;
  - web-safe imports and check-bundle;
  - old prompts kept;
  - migration additive only;
  - plain second-person copy.
- **Merge gates:**
  - `npm test -w packages/core`, `npm test -w apps/web`, `npm run typecheck -w apps/web`, `npx tsc --noEmit -p packages/core`, the web build with dummy env, and `npm run check-bundle -w apps/web`.
  - Chain them with `set -o pipefail`, and run them one after another.
  - Secret scan.
- **Environment:**
  - Never run `gen` or db commands without an explicit `DATABASE_URL=pglite://<temp under .data/>`.
  - Never touch the owner's checkout or Supabase.
  - Commits end with the committing agent's `Co-Authored-By` trailer.

## Review Focus

1. **A price unit that can't be annualised ("per claim", "per use") or a price of 0.** Expected: the revenue ceiling is null, the band is 2, and the gate passes with a note. It never kills on an unknown price. Pinned in Tasks 1 and 4.
2. **A model returns a share of 0, a population of 0, or a population as a string ("about 2 million").** Expected: number text is normalised the way ideate already does it (or the idea is dropped with a reason). A zero gives a ceiling of $0 and a fail at the gate, with the arithmetic shown. Pinned in Tasks 1 and 3.
3. **An idea re-run after an estimate exists (R20), or the estimator run twice.** Expected: the stored estimate is replaced with the run's ideas, and the estimator only fills ideas that lack one. Pinned in Tasks 2 and 3.
4. **A case moved back from killed to validating on the Board.** Expected: `ownerKeeps` reflects the current stage. Pinned in Task 5.
5. **Old passes and frozen benchmarks.** Expected: they render, `ownerKeeps` computes from today's Board, and no frozen definition changes. Pinned in Task 5.

---

### Task 1: Schema, `computeScale`, migration 0013

**Files:**
- Modify: `packages/core/src/pipeline/business-models.ts` and `packages/core/src/db/schema.ts`; generate `0013`.
- Test: `test/pipeline/business-models.test.ts` and `test/db/db.test.ts`.

**Interfaces:**
- `ScaleEstimateSchema` and `type ScaleEstimate`.
- `computeScale(e: ScaleEstimate, priceHint: PriceHint | null): ScaleResult`, where `ScaleResult = { payingBuyers: number; annualPrice: number | null; revenueCeiling: number | null; band: 1|2|3|4|5; capped: string[]; allAssumed: boolean }`.
  - `capped` names the shares that were capped.
  - `allAssumed` is true when no step has a source.
- `annualPrice(priceHint): number | null`, factored out of `valueMultiple`. `valueMultiple` keeps its behaviour.
- Schema: `ideas.scaleEstimate` and `ideas.scaleResult` (jsonb, nullable), and the `gateCheck` enum gains `'scale'`.

- [ ] **Step 1:** Write failing tests:
  - each cap, with and without a source;
  - each band boundary;
  - an unknown price unit;
  - a price of 0;
  - all assumed;
  - `valueMultiple` unchanged on existing fixtures;
  - the migration applies and is additive.
- [ ] **Step 2:** Run `npm test -w packages/core -- business-models db`. Expected: FAIL.
- [ ] **Step 3:** Implement. Generate `0013` and check it.
- [ ] **Step 4:** Run the core and web suites and both typechecks. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): realistic paying buyers and revenue ceiling`.

### Task 2: Scale estimator, `gen audit scale`, backtest

**Files:**
- Create:
  - `packages/core/prompts/scale-estimate.v1.md`;
  - `packages/core/src/audit/scale-estimate.ts`;
  - `packages/core/src/audit/backtest.ts`.
- Modify: the CLI (`gen audit scale [passId] [--last] [--decided] [--dry-run]` and `gen audit backtest`).
- Test: `test/audit/scale-estimate.test.ts`, `test/audit/backtest.test.ts`, and the CLI test.

**Interfaces:**
- `estimateScale(deps, target: { passId } | { decided: true }, opts?: { dryRun? }): Promise<{ estimated; skipped; estimatedUsd; spentUsd }>`.
  - Batches of 8 ideas, on the `review` stage model, with each idea's `ideaBlock` wrapped as untrusted.
  - Each call also shows the 5 nearest live library `market` entries, found with the idea embedding (or the text embedding), capped and wrapped as untrusted.
  - Number text is normalised; invalid entries are skipped and counted.
  - It writes `scaleEstimate` and the computed `scaleResult`, but only for ideas without one. Idempotent.
  - It never reads the case stage.
- `runBacktest(db, { minRevenueCeiling }): Promise<Backtest>`, where `Backtest = { decided: number; agree: number; table: { keptAbove; keptBelow; killedAbove; killedBelow }; disagreements: { title; stage; revenueCeiling; upside }[] }`.
  - The rule's verdict is "keep" when the ceiling is at least the line and `upside` is at least 3; otherwise it is "kill".
  - The markdown is written to `output/audit/backtest-<date>.md`.

- [ ] **Step 1:** Write failing tests:
  - batching;
  - storage;
  - idempotence;
  - `--decided` selects exactly the ideas behind non-`new` cases;
  - the estimator prompt contains no stage or Board words;
  - the backtest math on fixtures;
  - the markdown output;
  - the CLI wiring.
- [ ] **Step 2:** Run `npm test -w packages/core -- scale-estimate backtest cli`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the core suite and core tsc. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): scale estimator and backtest against Board decisions`.

### Task 3: Ideate v13

**Files:**
- Create: `packages/core/prompts/ideate.v13.md`, which is v12 plus spec §2.
- Modify: `packages/core/src/pipeline/ideate.ts`, `pipeline/idea-text.ts` (the paying-buyers line) and the web Summary tab (show the estimate and result as text).
- Test: `ideate.test.ts`, `ideate-prompt.test.ts`, the idea-text test and the web summary test.

**Interfaces:**
- Generated ideas require `scaleEstimate`; `scale` (free text) becomes optional.
- Normalisation:
  - number text for `count` and `pct`, using the conservative rules already in place;
  - basis cut to 300 characters;
  - a source kept only if it was shown, otherwise the basis becomes an "Assumption:".
- Storage: `scaleEstimate`, plus `scaleResult = computeScale(...)` using the idea's price hint.
- `ideaBlock` adds `Realistic paying buyers: N (unit); revenue ceiling: $X/yr` when there is a result.
- `loadPrompt('ideate')` returns v13.

- [ ] **Step 1:** Write failing tests:
  - parse, store and compute;
  - a missing estimate drops the idea with a reason;
  - number strings are normalised;
  - an unshown source becomes an assumption;
  - the prompt has the earn-first rule and the narrow-consumer warning;
  - the idea block line;
  - the Summary renders the estimate, and old ideas render unchanged.
- [ ] **Step 2:** Run `npm test -w packages/core -- ideate idea-text` and `npm test -w apps/web -- summary`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the core and web suites and both typechecks. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): ideate v13 estimates realistic paying buyers and prefers earn`.

### Task 4: Screen v6 and gate v6

**Files:**
- Create: `prompts/screen.v6.md` and `prompts/gate.v6.md`.
- Modify: `pipeline/screen.ts` and `pipeline/gate.ts`.
- Test: `screen.test.ts` and `gate.test.ts`.

**Interfaces:**
- **Screen:**
  - `scale` is computed from `scaleResult.band`, and the model is not asked for it.
  - `upside` is computed from `valueToUser.kind`.
  - `weightedScreenTotal` gains the v6 formula; the v3, v4 and v5 formulas are kept.
- **Gate:**
  - The code check `scale` runs after `evidence` and stores a verdict (`check: 'scale'`, model `rule`, prompt version `scale-rule.v1`).
  - The reasoning shows the arithmetic: population × problem share × paying share × reach share = buyers, × annual price = ceiling, plus any caps.
  - The kill applies to generated ideas only.
  - `gate.minRevenueCeiling` is read from settings, default 1,000,000.
  - gate.v6 differs from v5 only by one line saying scale is checked in code.

- [ ] **Step 1:** Write failing tests:
  - screen: computed scale and upside, the v6 weights, a missing estimate;
  - gate: scale pass, fail, no estimate, null ceiling, owner advisory, and the verdict text includes the arithmetic;
  - old ideas still screen and gate.
- [ ] **Step 2:** Run `npm test -w packages/core -- screen gate`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the core suite and core tsc. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): screen v6 and gate v6 score scale and upside in code`.

### Task 5: Board as verdict, reviewer v2, docs

**Files:**
- Create: `prompts/idea-review.v2.md`.
- Modify:
  - `bench/definitions.ts` and `scorecard.ts`: `ownerKeeps`, Board-aware agreement, and `IDEA_REVIEW_VERSION` set to v2;
  - `audit/review.ts`: the reviewer sees the estimate;
  - the web glossary and its docs: realistic paying buyers, revenue ceiling, upside, owner keeps;
  - README, `docs/user-guide.md`, `docs/architecture.md`, `docs/CONTEXT.md`;
  - `docs/idea-quality-log.md`: a placeholder entry for the backtest.
- Test: the scorecard, definitions, review and glossary-sync tests, and the docs-links test.

- [ ] **Step 1:** Write failing tests:
  - `ownerKeeps` on fixtures, including a case moved back and `no_data`;
  - agreement from Board decisions (ratings win over Board);
  - the reviewer prompt v2 anchors and that it receives the estimate;
  - the glossary sync.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run all gates. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): Board decisions as the owner verdict; reviewer v2` and `docs: scale and value round`.

### Task 6: Merge, backtest, measure (controller)

- [ ] Run the gates and the secret scan. Fast-forward main, run `npm install` and `npm run gen -- runs` (migrates `0013`), push, and remove the worktree.
- [ ] Run `gen audit scale --decided`, then `gen audit backtest`. Log the result. If agreement is below 70%, tune the caps or the line (a Builder's call), re-run, and log again.
- [ ] Run bench-v3 #2, then `gen audit scale --last` (only for any ideas missing an estimate), `gen audit review --last` and `gen bench report`. Log the results and ask the owner to sort the new cases on the Board.
