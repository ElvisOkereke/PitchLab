# Phase 3: Idea Generation and Business Case Rebuilt on the Library

Status: the owner approved the direction and all four decisions on 2026-10-27 ("looks good"). Sections marked **Builder's call** were settled by me (Claude). Roadmap: `docs/superpowers/specs/2026-10-25-idea-quality-roadmap-and-benchmark-design.md`. Library: `docs/superpowers/specs/2026-10-26-research-library-design.md`.

## Why

bench-v1 pass #1 (2026-10-27, $11.49, 4 runs) after the library was filled (605 entries):

| Metric | Baseline | Pass #1 |
|---|---|---|
| Real-need evidence | 20% | **100%** |
| Near-duplicates | 12% | **0%** |
| Repetition | 0.68 | 0.64 |
| Wasted gate entrants | 89% | 75% |
| Cases | 9 from 13 runs | **0 from 4 runs** |

The evidence is fixed. The generator is now the bottleneck:
- All 12 gate entrants were killed: `control` 9, `autonomy` 8, `generic` 3, `reachability` 1.
- The ideas are still the niche B2B tools the owner called out (e.g. "Payroll-Gap Collections Engine for Trade-Client Bookkeepers").
- Generation is business-only, uses one implicit business model, and ignores the library's 102 startups and 89 real price points.

## Owner decisions (2026-10-27)

1. **Autonomy:** a hard kill only for mostly-manual services. Ideas where software does most of the work, plus some per-customer setup or review by the owner, pass. That labour is priced into delivery cost and the barrier score.
2. **Control:** stays a kill. The generator is told up front to avoid ideas that depend on access, data, partnerships or platform goodwill we don't control.
3. **Money case:** every idea and case states a **dollar value to the user per year**:
   - money earned;
   - money saved;
   - time saved, at a stated hourly rate;
   - risk avoided, as expected loss.

   It also states the price. **Value ÷ price** (the "value multiple") works the same way for consumers and businesses.
4. **Mix per run is enforced:**
   - at least 30% consumer ideas (`consumer` or `both`);
   - at least 4 distinct business models among the 12 ideas.

Earlier decisions still bind:
- consumer and business ideas, in any market;
- every business model;
- two-sided barrier to entry: easy to start (low) and hard to copy (high), with "easy to start, hard to copy" preferred;
- solo-buildable preferred, not required;
- free data only.

## Goals (measured by a bench-v2 pass)

- **Cases appear again:** on average at least 1 case per run, and wasted gate entrants below 50%, heading toward the 30% target.
- **Mix:** consumer share at least 30%, and at least 4 business models per run. Scorecard metrics 4 and 5 become measurable.
- **Money:** customer return (value multiple) median at least 3×, and our margin at least 60% on cases.
- **Barriers:** at least 50% of cases are easy to start and hard to copy. Metric 11 becomes measurable.
- **No regressions:**
  - real-need evidence stays at or above 50%;
  - near-duplicates stay below 10%;
  - repetition trends down.

## Non-goals

- Slice B research kinds (trends, rule changes, markets) and demand evidence (metric 7). They come next, as their own plan.
- New UI pages, beyond showing the new idea and case fields where ideas and cases are already shown.
- Changing the validation pack.

## Anti-goals

- **Gaming the mix.** No relabelling B2B ideas as "both" to hit 30%. A consumer idea must name an individual buyer who pays, or whose attention or data is the product.
- **Invented money.** Value-to-user and price must cite a library pricing entry or signal, or be a stated assumption. This follows the existing `SourcedSchema` rule: a value needs a source or an assumption.
- **Loosening control or regulation checks.**
- **Breaking existing cases.** Old cases and `NumberInputs` stay valid and render as before. They read as the `subscription` model.

## Design

### 1. Idea fields (migration `0010`)

`ideas` gains these nullable columns, so existing rows stay valid:

- `audience`: business / consumer / both.
- `business_model`: one of `subscription`, `one_off`, `usage`, `marketplace`, `transaction_fee`, `data_sales`, `ads`, `affiliate`, `licensing`, `freemium`, `service_plus_software`. Exported as `BUSINESS_MODELS`.
- `revenue_mechanics`: text. Who pays, for what, and how often.
- `value_to_user` (jsonb):
  - `kind`: earn / save / time / risk
  - `amountPerYear`
  - `basis`: how it was worked out, with the hourly rate if time
  - `source`: library item id or signal URL, optional
- `price_hint` (jsonb): `{ amount, unit, basis, source? }`
- `barriers` (jsonb):
  - `toStart`: 1–5, lower is easier
  - `toStartWhy`
  - `toCopy`: 1–5, higher is harder
  - `toCopyWhy`
  - `soloBuildable`: boolean
- `library_item_ids`: uuid[]. The startup and pricing entries the idea relied on.

### 2. Ideate v8 (`prompts/ideate.v8.md`)

Inputs per lens:
- The run's signals, as now (library signals included).
- **Library context**, retrieved by embedding similarity to the lens and run seed (each list capped):
  - **Already sold:** active, acquired or public startups, up to 15. The rule: do not propose a product that one of these already sells to the same buyer.
  - **Lessons:** dead startups with their `why`, up to 8. The rule: say how the idea avoids the cause of death if it is similar.
  - **What people pay:** pricing entries with price points, up to 15. Anchor `priceHint` and `valueToUser` on these where relevant, and cite their ids.
- **Rules in the prompt:**
  - Avoid dependence on access, data, partnerships or platform goodwill we don't control.
  - Software does most of the work; light per-customer setup or review is OK if stated.
  - Every idea states audience, business model, revenue mechanics, value to user and price hint (both with basis and source), and both barriers.
- **Builder's call:** library context is wrapped as untrusted text like signals, and capped per field.

New consumer lenses are seeded through `seedDefaults` (insert on conflict do nothing, so existing databases gain them). **Builder's call** on the exact set, roughly 6 lenses:
- earn on the side;
- save money automatically;
- life-stage pain (moving, new parent, retirement);
- creator and solo-worker tools;
- leapfrog markets (emerging economies);
- AI assistant for a personal chore.

They are marked with a new `lenses.audience` column (business / consumer / any). Existing lenses are `business`.

**Consumer segments.** Open and sector seeds can only draw from the market's business sectors. Add `CONSUMER_SEGMENTS`, a constant of about 15 consumer segments (renters, freelancers, parents, students, retirees, creators, gig drivers, small landlords, immigrants, pet owners, and so on). Open seeds mix them in. **Builder's call:** keep it as a constant, not in the markets table.

**Enforced mix, in code after generation, per run:** if consumer share < 30% or distinct models < 4, make one targeted re-ask. The re-ask asks for N more ideas from consumer lenses or segments, or with unused models, and states the gaps. If it is still short, the run continues and logs the shortfall. Never loop.

### 3. Screen v4

- **Criteria added:**
  - `moneyCase`: value multiple from the idea's value and price hints, scored 1–5 with stated bands.
  - `barrier`: rewards toStart ≤ 2 and toCopy ≥ 4.
- **Ranking:** `(existing criteria + novelty + moneyCase + barrier) / N`.
- **Diversity cap:** at most 2 gate entrants per business model, replacing the per-mechanism cap. At least 1 consumer entrant whenever any consumer candidate passes the screen thresholds.

### 4. Gate v3

- **`autonomy`:** FAIL only if delivery is mostly human labour (consulting or done-for-you work). Software-led delivery with light per-customer setup or review passes, and the gate's reasoning records the labour.
- **`control`:** wording unchanged.
- **`generic`:** the gate is also given the "already sold" library startups for the idea's space as evidence, together with its own competitor research.
- Other checks are unchanged.

### 5. Business case and numbers

- **`NumberInputs` gains:**
  - `businessModel`, defaulting to `subscription` when absent, for old cases;
  - an optional `revenue` block per model:
    - marketplace: GMV per buyer × take rate;
    - usage: unit price × units;
    - ads: users × impressions × CPM;
    - affiliate: referrals × commission;
    - freemium: users × conversion × price;
    - transaction_fee: transactions × fee;
    - one_off: price × buyers × repeat rate;
    - data_sales / licensing: clients × price;
    - service_plus_software: subscription plus setup fee.
- **`computeNumbers`** picks the formula by model. Every input stays `SourcedSchema` (a source or an assumption).
- **Buyer value:**
  - `valueToUserPerYear` replaces "problem cost × reduction" when present;
  - `valueMultiple = value ÷ annual price`. The existing `roiMultiple` is kept as an alias for old cases.
- **`case-write.v4`** writes model-specific inputs and the value case. The Numbers tab shows the model, the formula and the value multiple. Existing cases render unchanged.

### 6. Scorecard and benchmark

- **Metric 4 (consumer share):** generated ideas with audience consumer or both, over those with audience set.
- **Metric 5 (model variety):** distinct `business_model` per run, averaged.
- **Metric 11 (easy to start, hard to copy):** cases whose idea has toStart ≤ 2 and toCopy ≥ 4.
- **Metric 8 (customer return):** uses the value multiple when present, otherwise ROI.
- **`bench-v2`:** bench-v1's four seeds plus a fifth lens seed of two consumer lenses. bench-v1 stays frozen.

## Constraints

All existing rulings bind:
- R13 and R20;
- verified-evidence rules;
- untrusted text wrapped;
- bounded queries;
- web-safe imports;
- no live model calls in tests;
- merge gates, including core tsc.

New prompts are new versioned files (v8, v4 and v3); old versions are kept. Migration `0010` only adds things.

## Decisions settled after the design review (Builder's calls)

- **Cost stays roughly flat.**
  - Open and sector runs use at most **6 lenses per run**, at least 2 of them consumer lenses when the seed allows it. Lenses are rotated or sampled, so all are covered over time.
  - Lens seeds use exactly the lenses chosen.
  - Library context retrieval is pure SQL plus one embedding per lens, so the cost is negligible.
  - The mix re-ask happens at most once per run.
  - Target: a run costs about the same as today ($3–7).
- **The mix is guaranteed at generation.** Downstream, the screen keeps at least 1 consumer entrant whenever any consumer candidate passes its thresholds. There is no extra backfill after the screen. The scorecard measures generated ideas for metrics 4 and 5, and cases for 8, 9 and 11.
- **Money and barrier scores rank, they don't kill.** `moneyCase` and `barrier` only affect screen ranking. A case with a value multiple below 1× gets a summary gate flag ("value below price") rather than being dropped.
- **The cost side is the same for every model.** It uses the existing delivery-cost and fixed-cost lines. Model-specific costs (payment fees for marketplaces, serving free users) are written as ordinary delivery-cost lines by the case writer. Only revenue formulas vary by model.
- **The named-buyer rule is enforced in the prompt** ("a consumer idea names an individual who pays, or whose attention or data is the product"). Code does not judge it.
- **Old data:** metrics 4, 5 and 11 compute over ideas and cases that have the new fields. Sets with none show `no_data`. baseline-0 and bench-v1 #1 are frozen and keep their "not measured yet" cells.
- **The lens pool is part of the pipeline under test.** bench-v1 and bench-v2 pin their seeds (sectors and lens ids). Open and sector seeds draw from the live lens pool by design, so adding consumer lenses is part of what the benchmark measures.

## Left to the builder

- Exact prompt wording, model-to-formula details, score bands for `moneyCase` and `barrier`, lens and segment lists, and how the re-ask is phrased.
- How to retrieve library context for a lens, as long as it is embedding-based and capped.

## Done when

- A bench-v2 pass produces cases. The scorecard shows consumer share, model variety and barrier metrics measured, against baseline-0 and bench-v1 #1.
- Old cases still render, and their numbers are unchanged.
- Tests cover the new idea schema, the enforced mix and re-ask, the screen ranking and caps, the gate wording, every revenue formula, the value multiple, and the scorecard metrics.
