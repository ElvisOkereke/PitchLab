# Scale and Value Round: Realistic Paying Buyers, Earn Over Save, the Board as Verdict

Status: owner approved on 2026-11-07 ("go ahead"). Owner decisions are quoted. Everything else is a **Builder's call** (Claude).

## Why

The owner sorted 55 cases on the Board on 2026-11-07: 44 killed, 10 Validating, 1 Pilot. Their reason for most kills:

> "realistically there are not a lot of buyers for this even if we had great margins (for example selling to niche groups of individuals like parent, medical patients, people for order delivery from apps often) these are too narrow and dont have the scalability even if the idea is good."

Also:

> "ideas that generate new value of users, normally do better than ideas that may save them money so we should tweak our model to prioritize revenue increase businesses over cost saving services/businesses."

Today the scale of an idea is a free-text guess (`scale: { buyers, basis }`) that counts people who *have* the problem, not people who would *pay*. The reviewer runs backwards against the owner:
- kept cases average reviewer scale 2.6;
- killed cases average 3.6;
- agreement is 12 of 33.

## Owner decisions (2026-11-07)

1. **Realistic paying buyers and a revenue ceiling, worked out step by step from sourced numbers,** scored in code. A gate kill line at **$1M a year** realistic revenue ceiling ("go with your suggestion").
2. **Earn over save:** ideas that increase the user's revenue are preferred over ideas that save money, in ranking and in the prompt. This is a preference, not a kill.
3. **The Board is the verdict:** keeping (Validating, Pilot, Live) or killing a case on the Board counts as the owner's verdict in the scorecard. Idea ratings stay optional.

## Goals

- **Backtest** on the owner's 55 sorted cases, using the new scale estimator for old ideas:
  - the kill line plus the earn preference agree with the owner's keep or kill on at least 70% of decided cases (today: 36% for the reviewer);
  - at least 80% of the owner's consumer-niche kills fall below the line, or rank bottom.
- **bench-v3 #2** against #1:
  - ideas with a revenue ceiling of $1M or more make up at least 60% of the ideas reaching the gate;
  - "earn" ideas make up at least 40% of generated ideas;
  - the owner keeps at least 50% of cases.

## Non-goals

Finds and capture (the next round), automatic feeds, and any change to the case writer's numbers model beyond showing the estimate.

## Anti-goals

- **Inflated arithmetic:**
  - a share stated without a source is capped by the code;
  - the population must cite a source or be marked as an assumption;
  - an all-assumption estimate is flagged.
- **Killing good business tools for being "small":** the line is $1M, not $10M. Owner ideas are advised, never killed.
- **Hiding the line:** every gate kill on scale shows the arithmetic.

## Design

### 1. The estimate (`ScaleEstimateSchema`, web-safe, in `business-models.ts`)

```
scaleEstimate: {
  buyerUnit: 'businesses' | 'individuals',
  population:       { count: number, basis: string ≤ 300, source?: string },   // how many have the problem's setting
  shareWithProblem: { pct: number (0–100), basis: string ≤ 300, source?: string },
  shareWillingToPay:{ pct: number (0–100), basis: string ≤ 300, source?: string },
  shareReachable:   { pct: number (0–100), basis: string ≤ 300 },            // reachable in 3 years through the stated channel
}
```

`computeScale(estimate, priceHint)` is pure and in code. It returns:

```
{ payingBuyers, annualPrice, revenueCeiling, band (1–5), capped: string[], allAssumed: boolean }
```

- **Annual price:** the price hint, made yearly with the same rules as `valueMultiple`. If it can't be made yearly, `revenueCeiling` is null and the band is 2.
- **Caps (Builder's call):** applied when the share has no source.
  - `shareWillingToPay`: individuals at most 3%, businesses at most 15%.
  - `shareReachable`: at most 20%.
  - `shareWithProblem`: at most 60%.
  - A sourced share is used as given, still clamped to 0–100.
- **Bands by revenue ceiling:**
  - under $250k is 1;
  - under $1M is 2;
  - under $5M is 3;
  - under $25M is 4;
  - otherwise 5.

### 2. Ideate v13

v12 plus three changes:

- **The estimate:** `scaleEstimate` replaces the free-text `scale`.
  - The old `scale` stays readable for old ideas; new ideas don't need it.
  - The prompt explains each step and the caps.
  - It asks the model to use library `market` entries and public statistics for the population.
  - It says plainly that a narrow consumer group, such as parents of a specific condition, patients of one procedure or frequent users of one app, rarely clears $1M at consumer prices unless the price or paying share is unusually strong.
- **Earn first:** `valueToUser.kind` order of preference is earn, then time and risk, then save. Look for the revenue angle first ("help them win or earn more" before "cut a cost"). A savings idea is still allowed, but it must be big for the buyer.
- **Storage:** stored as `ideas.scale_estimate` jsonb (migration `0013`, additive), plus the computed result `ideas.scale_result` jsonb, so ranking, the gate and the UI read one number.
- **Prompt text:** `ideaBlock` shows "Realistic paying buyers: N (…); revenue ceiling: $X/yr" for downstream prompts.

### 3. Scale estimator for existing ideas (`scale-estimate.v1`)

- **What it does:** a model stage writes the same `scaleEstimate` for an idea that has none. It reuses the idea's text, its price hint and the library `market` entries closest to it.
- **Command:** `gen audit scale [passId|--last|--decided]` (idempotent, cost shown first, `--dry-run`).
- **`--decided`:** covers every idea behind a case the owner kept or killed, for the backtest.
- **Model:** the `review` model stage. The estimator never sees the Board decision.

### 4. Screen v6 and gate v6

- **Screen:**
  - `scale` comes from `scale_result.band` in code. Ideas without an estimate are scored 2. The model no longer judges scale.
  - A new computed criterion, `upside`: earn 5, time 3, risk 3, save 2, missing 3.
  - Both are weighted 1 (speed stays 0.5).
- **Gate:** a new code check, `scale`, sits next to `evidence`.
  - It FAILs a generated idea whose `revenueCeiling` is below the setting `gate.minRevenueCeiling` (default 1,000,000).
  - The reasoning shows the arithmetic and any caps applied.
  - It is skipped, with a pass verdict noting "no estimate", when the idea has no estimate (old data).
  - Owner ideas are advisory.
  - The `gate_check` enum gains `scale` (migration `0013`).
- The prompt check wording is unchanged, apart from a line saying scale is checked in code.

### 5. The Board as verdict, and reviewer v2

- **Scorecard `ownerKeeps`:** the share of the set's cases the owner has decided (stage is not `new`) that were kept (validating, pilot or live).
  - It meets at 0.5.
  - It is `no_data` when none are decided.
  - The display reads "kept N of M decided".
  - `ownerLikes` (idea ratings) stays.
- **`reviewerAgreement`:** also counts decided cases. Kept counts as liked and killed as disliked. Ratings win when both exist.
- **`idea-review.v2`:**
  - scale anchors use realistic paying buyers and the revenue ceiling, and the reviewer sees the estimate when present;
  - edge anchors are tightened ("a checkable advantage over a named option, that the buyer would pay for");
  - it adds `upside` (earn against save) in the reasons.
- **Backtest report (`gen audit backtest`):** for decided cases it prints:
  - agreement between the kill line plus `upside` and the owner's decisions;
  - a confusion table (kept or killed, against above or below the line);
  - the cases where the rule and the owner disagree.

  It is written to `output/audit/backtest-<date>.md`.

### 6. Docs

- README, user guide (Board as verdict, the scale estimate on the Summary tab, the backtest), architecture, glossary (realistic paying buyers, revenue ceiling, upside, owner keeps).
- The quality log gets an entry per run of the backtest and bench-v3 #2.

## Constraints

All existing rulings bind:
- R13 and R20;
- untrusted text wrapped;
- bounded queries, bound parameters only;
- web-safe imports and check-bundle;
- old prompts kept;
- migration `0013` additive only;
- no live model calls in tests;
- merge gates and a secret scan.

Old ideas, cases and passes render and compute as before.

## Done when

- Tests cover:
  - `computeScale` (caps, bands, the unknown-price case, all-assumed);
  - ideate v13 storage;
  - the estimator's idempotence;
  - screen v6's computed scale and upside;
  - gate v6's scale check (pass, fail, no estimate, owner advisory);
  - `ownerKeeps`;
  - reviewer agreement from Board decisions;
  - the backtest report.
- The backtest has been run on the owner's 55 decided cases and its results logged. If agreement is below 70%, the caps and the line are tuned (Builder's call) before bench-v3 #2.
- bench-v3 #2 has been run and reported against #1 and the owner's next Board sort.
