# Diversity and Buyer Base

Status: owner approved on 2026-11-11. Owner decisions are quoted; everything else is a **Builder's call** (Claude). This round is small and comes before bench-v3 #3, which measures it together with the judge tuning.

## Why

The owner reviewed recent ideas and found:

> "a lot of similarity across the Ideas, for example main small business, a lot of B2C, a lot of fairly simple problems that could be solved by better bookkeeping from the buyers … and very narrow buyer markets. I just want a bit more diversity, stronger buyer bases, and more important [problems]."

The last 346 generated ideas, measured on 2026-11-11, show four problems:

- **Every sector a run can draw from is a local small business.** The `ca-us` market lists 24 sectors (agencies, trades, dental, landlords, Shopify brands, restaurants…), and every sector and open seed draws only from that list.
- **40% of ideas are for consumers.** The generator forces at least 2 consumer lenses per run (`MIN_CONSUMER_LENSES`), and v1 ideation re-asks until consumer ideas reach 30% (`MIN_CONSUMER_SHARE`).
- **The most-used lenses look for operational leaks.** These are platform-shockwave, money-leak, review-gap, silent-failure and compliance-demand, and they tend to produce trackers and reconcilers.
- **About 70% of ideas have fewer than 10,000 buyers, or no estimate at all.** The gate's revenue line is $100k.

## Owner decisions (2026-11-11)

1. **Market scope:** "(a)", a broad, multi-tier market profile, with the current small-business list kept as an optional profile.
2. **Consumer ideas:** drop the forced consumer quota. Consumer ideas are allowed only when the buyer pool is large and sourced (at least 1M individuals).
3. **Minimum buyer base:** at least 20,000 businesses or at least 1M individuals, with the population sourced rather than assumed. A generated idea below that line is killed. For owner ideas the check is advisory.

## Goals (measured on bench-v3 #3 against #2)

- **Sector spread:** no single sector has more than 15% of a pass's ideas, and at least 40% of ideas come from mid-market or enterprise sectors.
- **Consumer share:** at most 20% of ideas, and every consumer idea has a sourced population of at least 1M.
- **Buyer floor:** every generated idea that passes the gate clears the floor with a sourced population.
- **Owner keep rate rises** against bench-v3 #2. This is the primary measure.

## Design

### 1. Market profiles

- **Migration `0018`, data only:** insert market `broad`, named "North America, all tiers", with countries `CA`, `US`, language `en`, currency `USD`.
- **The `broad` market holds about 40 sectors across three tiers:**
  - **Enterprise and regulated:** insurance carriers, banks and credit unions, health systems and hospitals, health insurers and payers, pharma and life sciences, utilities and energy, telecom, manufacturing, chemicals, aerospace and defence suppliers, government agencies, universities.
  - **Mid-market and B2B:** logistics shippers and 3PLs, wholesale and distribution, commercial real estate, construction general contractors, engineering firms, staffing agencies, law firms, accounting firms, HR and payroll, fintech and payments, B2B SaaS companies, data and AI teams, cybersecurity, ecommerce marketplaces, media and publishers, automotive dealers, agriculture and food processing, mining, specialty retail chains, hospitality groups.
  - **Small business (kept, narrower):** franchise groups, multi-location clinics, field services, ecommerce brands.
- **Defaults:** `ca-us` stays as the small-business profile. `defaultRunConfig.marketId` becomes `broad`, and so do the benchmark pass definitions. bench-v3 #3 then measures the new market, and that change is recorded in the quality log.
- **Builder's call:** each run samples at most 8 focus sectors, as today, with at least half from the enterprise and mid-market tiers whenever the market has tiers. Tiers are stored as a sector-name prefix map in code (`MARKET_TIERS`), not as a schema change.

### 2. Consumer quota removed

- **`MIN_CONSUMER_LENSES = 0`.** Consumer lenses still compete for the lens slots by weight.
- **v1 ideation:** `MIN_CONSUMER_SHARE = 0`, so the consumer re-ask never fires. The constants are kept, so the old behaviour is one edit away.
- **Prompt rules** (sketch v2, ideate v16 for expansion, and v14 kept for v1 runs): "Consumer ideas only when the buyer pool is at least 1M individuals with a cited source."

### 3. Buyer floor (gate check `buyers`, code)

- **The rule:**
  - Kill a generated idea when its `scaleEstimate` is missing, when the population has no `source`, or when the population count is under the floor for its buyer unit. The floors are `gate.minBuyers.businesses` (default 20,000) and `gate.minBuyers.individuals` (default 1,000,000).
  - **Advisory** for owner ideas, like `scale`.
  - `buyers` joins the code verdicts. Migration `0018` adds `buyers` to the `gate_check` enum (additive).
- **The verdict text:** the population, its source or "no source", and the floor.
- **Sketches (Builder's call):** the sketch prompt asks for a one-line buyer pool with a source hint. The archive does not kill on this, because sketches carry no scale estimate. The gate stays the binding check.

### 4. Lens mix toward important problems

- **Weights** (a data change in migration `0018`):
  - set `weight = 0.5` for money-leak, silent-failure, review-gap and platform-shockwave;
  - set `weight = 1.5` for new-capability, ai-replaces-labour, data-flywheel, compliance-demand (at scale), picks-and-shovels and ten-x-incumbent.
- **New lens `industry-shift`** (business, active, weight 1.5): "A structural change across a large industry (regulation, technology, labour, capital) that forces thousands of companies to change how they work; build what they will all need."
- **`MIN_AMBITION_LENSES` stays 2.**

### 5. Judge

The judge uses `judge.v2` (the owner's taste rules, including broad buyer bases and important problems) once the judge-tuning experiments confirm it, as part of the judge-tuning work. This round adds no judge change of its own.

### 6. Docs and reporting

- **Benchmark scorecard rows:**
  - `topSectorShare` (target ≤ 0.15);
  - `upperTierShare` (target ≥ 0.4);
  - `consumerShare` (target ≤ 0.2);
  - `buyerFloorPass` (share of gate-passed generated ideas with a sourced population at or above the floor; target 1.0).
- **Docs to update:** README, architecture, user guide, glossary ("Buyer floor", "Market profile"), CONTEXT and OWNER-TODO.

## Constraints

- All existing rulings bind.
- Migration `0018` is additive: data inserts and updates, plus enum add-value.
- Old prompts are kept. Runs stored before the merge keep their `marketId`.
- No live network or model calls in tests.
- Merge gates and the secret scan as usual.

## Done when

- **Tests cover:**
  - the market seed and its tiers;
  - the tier-balanced sector sampling;
  - the quota at 0, with no consumer re-ask;
  - the buyer floor for each unit, for a missing estimate, for an unsourced population, and for owner ideas;
  - the new gate enum value;
  - the lens weights and the new lens;
  - the prompt rules;
  - the scorecard rows.
- **bench-v3 #3 has run** on `broad` with engine v2 and the tuned judge, and the owner has sorted its Board.
