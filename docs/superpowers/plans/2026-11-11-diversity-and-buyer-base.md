# Diversity and Buyer Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. TDD per task (failing test first, capture RED). No live network or model calls in tests. Steps use checkbox (`- [ ]`) syntax.

**Goal:**
- A broad, tiered default market.
- No forced consumer quota.
- A sourced buyer-floor gate check.
- A lens mix weighted toward important problems.
- Scorecard rows that measure all of this.

**Architecture:**
- **Migration `0018`** (data and enum only) adds:
  - market `broad`;
  - gate check `buyers`;
  - lens weights and the lens `industry-shift`.
- **Code changes:** tier-aware open-seed sector sampling, constants set to 0, a code gate verdict, and prompt bumps (sketch v2, ideate v16).
- **Benchmarks:** bench-v3 seeds are unchanged so passes stay comparable. Only the queue market changes, to `broad`.

**Tech Stack:** existing.

**Spec:** `docs/superpowers/specs/2026-11-11-diversity-and-buyer-base-design.md` (binding).

**Branch:** `diversity`, in worktree `Y:/CODING PROJECTS/Business_Case_Gen-div`.

## Global Constraints

- **Migration `0018` is additive:** inserts and updates, plus `ALTER TYPE gate_check ADD VALUE 'buyers'`. Old prompts are kept, and stored runs keep their `marketId`.
- **Exact values:**
  - `gate.minBuyers.businesses` default 20000; `gate.minBuyers.individuals` default 1000000.
  - `MIN_CONSUMER_LENSES = 0`; `MIN_CONSUMER_SHARE = 0`.
  - Open seeds sample 6 sectors, at least 3 of them from the enterprise or mid-market tiers whenever the market has tiers.
  - Lens weights: 0.5 for money-leak, silent-failure, review-gap and platform-shockwave. 1.5 for new-capability, ai-replaces-labour, data-flywheel, compliance-demand, picks-and-shovels, ten-x-incumbent and the new industry-shift.
  - Scorecard targets: `topSectorShare` ≤ 0.15; `upperTierShare` ≥ 0.4; `consumerShare` ≤ 0.2; `buyerFloorPass` = 1.0.
- **Prompt rule text:** "Consumer ideas only when the buyer pool is at least 1M individuals with a cited source."
- **`buyers` verdict:**
  - It kills generated ideas only; for owner ideas it is advisory, like `scale`.
  - The verdict text gives the population, its source or "no source", and the floor.
  - `buyers` is not an `ADVISORY_GATE_CHECKS` member, because it can kill.
- **Existing rulings bind.** Merge gates and the secret scan as usual. Core tests run with `--maxWorkers=2`.

## Review Focus

1. **A `scaleEstimate` with a population source that is an empty string or only whitespace.** Expected: treated as unsourced, so the idea is killed.
2. **Runs and benchmark passes stored before the merge, with `marketId` `ca-us`.** Expected: unchanged behaviour on resume.
3. **Market `broad` missing** (migration not yet run). Expected: queueing fails with a clear error instead of a silent fallback.

---

### Task 1: Market profile, tiers, lens mix (migration 0018)

**Files:**
- Create: the migration `drizzle/0018_diversity.sql` and its meta, `src/pipeline/market-tiers.ts`.
- Modify:
  - `src/pipeline/harvest.ts` (open-seed sector pick at about line 274 becomes tier-balanced);
  - `src/pipeline/seed-context.ts` (`MIN_CONSUMER_LENSES = 0`);
  - `src/pipeline/ideate.ts` (`MIN_CONSUMER_SHARE = 0`);
  - `src/dashboard/runs.ts` (`QUEUE_MARKET_ID = 'broad'`);
  - `src/pipeline/types.ts` (`defaultRunConfig.marketId = 'broad'`);
  - wherever the market seed data lives (follow how `ca-us` was seeded).
- Test: a migration-0018 test, plus tests for harvest sector picking, seed-context, ideate mix, and the queue default.

**Interfaces:**
- **Produces:**
  - `MARKET_TIERS: Record<string, Record<string, 'enterprise' | 'mid' | 'small'>>`, keyed by market id then sector. The `broad` market's sectors are exactly the spec §1 lists; `ca-us` has no tiers.
  - `pickTieredSectors(sectors: string[], tiers: Record<string, Tier> | undefined, n: number, random: () => number): string[]`, with at least `ceil(n/2)` from enterprise or mid when tiers exist, and otherwise the current random pick.
  - The `industry-shift` lens row, with the spec §4 pattern text.

- [ ] **Step 1:** Write failing tests:
  - 0018 inserts market `broad` with every spec sector, adds enum value `buyers`, applies the lens weights and the new lens, and is additive;
  - `pickTieredSectors` gives at least 3 upper-tier sectors out of 6 over 20 seeds and is deterministic per seed;
  - `ca-us` picking is unchanged;
  - `MIN_CONSUMER_LENSES` 0 means a run may have 0 consumer lenses;
  - the consumer re-ask never fires;
  - `queueRun` and bench passes default to `broad`;
  - queueing with `broad` missing throws a clear error.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the core suite and core tsc. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): broad tiered market, no consumer quota, lens mix toward important problems`.

### Task 2: Buyer floor gate check and prompts

**Files:**
- Create: `prompts/sketch.v2.md` (v1 plus the consumer rule and a "buyer pool: <who, about how many, source hint>" line in the sketch's problem or buyer text) and `prompts/ideate.v16.md` (v15 plus the consumer rule).
- Modify:
  - `src/pipeline/gate.ts` (code verdict `buyers`);
  - `src/validation/settings.ts` (getters for `gate.minBuyers.*`);
  - `src/pipeline/engine/sketch.ts` and `src/pipeline/ideate.ts` (use the new versions; v1 runs stay on v14);
  - web gate labels ("Buyer floor").
- Test: the gate tests, sketch and ideate prompt tests, settings tests and the web label test.

**Interfaces:**
- **Produces:** `buyerFloorVerdict(estimate: ScaleEstimate | null, floors: { businesses: number; individuals: number }): { pass: boolean; text: string }`.
  - Unsourced means `population.source` is missing or blank after trimming.
  - The unit comes from `buyerUnit` (`businesses` | `individuals`; anything else uses the businesses floor).

- [ ] **Step 1:** Write failing tests:
  - pass at exactly the floor, for each unit;
  - fail just under the floor;
  - fail for no estimate;
  - fail for a blank or whitespace-only source;
  - an owner idea is advisory, not killed;
  - the verdict text has the count, the source and the floor;
  - the settings override changes the floor;
  - sketch v2 and ideate v16 carry the consumer rule;
  - v1 runs still load ideate v14;
  - the web label.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the core and web suites and both typechecks. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): buyer floor gate check; consumer rule in sketch v2 and ideate v16`.

### Task 3: Scorecard rows and docs

**Files:**
- Modify:
  - `src/bench/definitions.ts` and `src/bench/scorecard.ts` (the four rows);
  - README, `docs/architecture.md`, `docs/user-guide.md`;
  - `docs/glossary.md` and `apps/web/lib/glossary.ts` ("Buyer floor", "Market profile");
  - `docs/CONTEXT.md`, `docs/OWNER-TODO.md`.
- Test: the scorecard tests, plus the glossary and docs-link guards.

**Interfaces:**
- **The four rows:**
  - `topSectorShare`: the largest single focus sector's share of the pass's generated ideas, using the idea's sector or the run's focus sector.
  - `upperTierShare`: the share of ideas whose sector is enterprise or mid in `MARKET_TIERS`.
  - `consumerShare`: the share with audience `consumer`.
  - `buyerFloorPass`: the share of gate-passed generated ideas whose `buyers` verdict passed.
- **No data:** when the pass predates the `broad` market or has no `buyers` verdicts.

- [ ] **Step 1:** Write failing tests: each row computes on fixtures, and each shows "no data" for old passes.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement, and write the docs.
- [ ] **Step 4:** Run all merge gates. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): diversity scorecard rows; docs`.
