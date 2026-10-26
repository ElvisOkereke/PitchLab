# Idea Quality: Roadmap and Phase 1 Benchmark

Status: the owner approved the direction on 2026-10-25 ("go with your recommendations"). Sections marked **Builder's call** were settled by me (Claude) and not discussed with the owner. Phases 2 and 3 are recorded here as decided goals; each gets its own design pass before it is built.

## Why

The owner says generated cases are "way too similar, and not unique enough to have a real need". In their words, most ideas are "some type of B2B monitoring system or very niche, without very clear business case", solving edge cases a business "may not see the value of paying to fix or spending time to integrate a new tool for". They want:

- **Breadth:** ideas for businesses **and everyday people**, in any market; "cutting edge ideas that could solve the new problems people have today and in the future". Ideally the end user feels the product makes them money or gives clear value.
- **A clear business case:** "clearly demonstrate the money that could be generated for the end user and how much we can charge for the service".
- **Every kind of business model:** "not all businesses make their money the same way (selling direct to customers, some harvest info and sell that, etc)".
- **Much wider research:** market needs, trends, emerging markets, startup trends and success/failure rates; "we need every bit of info we can get". Free sources only ("we should be able to source all our info for free just by searching the web"), even if that means building a research tool. In short: "really build our knowledge base and the knowledge finding process".
- **Barrier to entry** ranked for every idea.
- **Clear goals**, so progress can be tracked.

## Baseline (measured 2026-10-25 from the live database; no model calls)

Data: 13 runs, 74 ideas (67 generated, 7 owner), 9 cases, 206 signals.

**Repetition**
- 4 of 9 cases are one idea: test leads sent through client forms and calls.
- Each generated idea's closest other idea averages 0.68 cosine similarity (max 0.92). Across all pairs the mean is 0.43, and 7 pairs are at or above 0.80.

**Breadth**
- Every run uses one market: Canada + US small businesses across 20 fixed sectors. Consumer ideas are impossible by construction.
- Buyer types are mostly agencies, home-service firms and property managers.

**Evidence**
- 22 of 206 signals (11%) are in the voice of someone with the problem (operator). 5 are neutral, 62 are vendor and 117 are untagged.
- Sources are web search 164, WordPress forums 28, GitHub 11 and Hacker News 3. The top domain is a vendor blog.
- There is no trend, demand, spending, emerging-market or startup-outcome data at all.

**Business cases**
- Buyer ROI multiples: 0.24, 0.59, 0.72, 1.07, 1.53, 1.83, 2.37, 3.48, 3.7. The median is 1.53; 2 of 9 reach 3× and 4 of 9 are at or below 1.1×.
- 2 of 9 cases have negative gross margin.

**Gate**
- Of 35 gate entrants, 22 failed `generic` ("already sold") and 17 failed `autonomy` (needs manual work per customer).

**Owner scores:** none recorded yet.

## Roadmap (agreed order)

1. **Phase 1: benchmark and scorecard** (this document, full design below). A fixed, repeatable benchmark that measures every change, plus the historical baseline.
2. **Phase 2: knowledge base and research collector** (the biggest piece; own design pass). A growing, browsable library that every run draws from, filled from free sources.
3. **Phase 3: generation and business case rebuilt on the library** (own design pass). Consumer and business ideas, business-model variety, a two-sided barrier-to-entry score, and a higher money bar.

Each phase is measured against the Phase 1 benchmark before and after.

### Decisions already made for Phases 2 and 3 (the owner accepted these recommendations)

- **Free data only.** No paid data subscriptions. Model calls still cost notional spend through the owner's LLM access. Sources to consider:
  - web search through the model;
  - Reddit's public JSON;
  - Hacker News (Algolia);
  - app store reviews;
  - Product Hunt;
  - public startup directories and failure post-mortems;
  - Google Trends;
  - government and open data;
  - GitHub;
  - forums.

  Building a collector to gather these efficiently is in scope.
- **The library is browsable in the dashboard.** The owner can search problems, trends, markets and startup outcomes, each with its source and date, and judge research quality themselves.
- **Barrier to entry is two-sided, and both sides are scored:**
  - **To start:** money, skills, licences, time to first revenue. Lower is better.
  - **To copy:** accumulated data, network effects, relationships, switching costs. Higher is better.

  Prefer "easy to start, hard to copy".
- **Solo-buildable is preferred, not required.** Ideas that need a team or capital are allowed but rank lower.
- **Business models vary.** Each idea names its model: subscription, one-off sale, usage-based, marketplace commission, data or insight sales, ads, affiliate, licensing, freemium, transaction fee, or service plus software. The numbers calculator supports each model's revenue maths, not only "monthly price × buyers".
- **Audience is both** business (B2B) and consumer (B2C), in any market (not only Canada + US).

## Phase 1 design: benchmark and scorecard

### Intent

Before changing how ideas are found, make "better" measurable. The owner gets a scorecard with targets, a historical baseline, and a button to re-run a fixed benchmark after each change, then sees whether the numbers moved.

### Goals

- **B1:** A scorecard of the metrics below, computed from database data with no model calls. It is shown with today's value, the target and pass/fail.
- **B2:** A "baseline-0" snapshot computed now from all existing real (non-example) data, saved permanently for comparison.
- **B3:** A fixed, versioned benchmark (`bench-v1`): a set of run seeds queued together with one action. When they finish, a snapshot is computed over just those runs.
- **B4:** Snapshots are stored and listed side by side, so the owner can see progress over time.
- **B5:** The owner's own verdict ("Would I pursue this?") is part of the scorecard. It uses the existing owner-only `gut` score (1–5) on benchmark cases.

### Non-goals

- Changing how ideas are generated, researched or gated. That is Phases 2 and 3.
- Paid data, or any new LLM judge in Phase 1. All metrics come from data the pipeline already stores, plus the owner's scores.
- Statistical rigour beyond a clear small-sample caveat.

### Anti-goals

- **A scorecard that can be gamed by one number.** For example, low similarity achieved with nonsense ideas. That is why money, evidence and owner-verdict metrics sit alongside breadth.
- **Metrics that silently read the example case or example run.** Exclude `is_example` everywhere.
- **Spending money without an explicit click.** "Run benchmark" shows its cost (about $12–28 for bench-v1, from 4 runs at about $3–7 each) and queues runs only when pressed.
- **Changing a benchmark version's seeds after first use.** Changes create a new version (`bench-v2`), so comparisons stay fair.

### The scorecard

Every metric covers the snapshot's set of runs: all real runs for baseline-0, or the benchmark's runs. A metric that the current pipeline cannot produce yet shows **"not measured yet"** with the phase that will produce it. Defining them now fixes what Phases 2 and 3 must store.

| # | Metric | Definition | Baseline today | Target |
|---|---|---|---|---|
| 1 | Repetition | Mean, over generated ideas, of the cosine similarity to their nearest other idea in the set (embeddings) | 0.68 | below 0.55 |
| 2 | Near-duplicates | Share of generated ideas whose nearest neighbour is at or above 0.80 | (compute) | below 10% |
| 3 | Buyer variety | Distinct buyer types (normalised `buyer_type`) per run, averaged | (compute) | at least 8 per run |
| 4 | Consumer share | Share of ideas aimed at everyday people | 0% | at least 30% (Phase 3 stores audience) |
| 5 | Business-model variety | Distinct business models per run, averaged | not measured | at least 4 per run (Phase 3 stores model) |
| 6 | Real-need evidence | Share of signals cited by ideas that are operator or neutral voice | 11% of all signals | at least 50% |
| 7 | Demand evidence | Share of ideas citing at least one demand signal (trend, search or spending data) | 0% | at least 80% (Phase 2) |
| 8 | Customer return | Share of cases with buyer ROI of at least 3×; also show the median | 2 of 9, median 1.53× | 100%, median at least 3× |
| 9 | Our margin | Share of cases with gross margin of at least 60% | (compute) | 100% |
| 10 | Wasted gate entrants | Share of gate entrants killed for `generic` or `autonomy` | about 22 + 17 checks failed of 35 | below 30% of entrants |
| 11 | Easy to start, hard to copy | Share of cases scoring "easy to start" and "hard to copy" | not measured | at least 50% (Phase 3) |
| 12 | Owner verdict | Mean owner `gut` score (1–5) on the pass's cases, plus how many are scored | none scored | at least 3.5, all scored |
| 13 | Cost per case | Notional spend of the pass ÷ cases produced | (compute) | tracked, no target |

**Notes:**
- Metric 1 compares only within the snapshot's own ideas. The report also shows similarity to all earlier ideas ("new versus history") as a secondary figure.
- Metric 6 uses the signals each idea cites (`ideas.signal_ids`), not all harvested signals. Untagged legacy signals count as not operator or neutral.
- The gate check for metric 10 counts ideas, not checks. An idea killed for both reasons counts once.

**Builder's call:** the exact normalisation for buyer types: lowercase, trim, and collapse obvious variants. No LLM is involved.

### The benchmark (`bench-v1`)

**Builder's call** on the exact seeds, chosen to avoid where current ideas cluster and to stay fixed:

| Seed | Settings |
|---|---|
| Open | 12 ideas, 3 advanced |
| Sectors | dental clinics, restaurants/multi-location food; 12 ideas, 3 advanced |
| Sectors | property management, ecommerce brands (Shopify); 12 ideas, 3 advanced |
| Lenses | platform-change shockwave, public data → paid decision; 12 ideas, 3 advanced |

- No "Your idea" seed: it measures the owner's idea, not generation.
- A consumer seed is added as `bench-v2` when Phase 3 makes consumer markets possible.
- Runs are queued through the existing queue. The worker executes them as normal runs, tagged with the benchmark version and pass id.

### Where it lives

- **Core:** the scorecard computation over a set of run ids, plus snapshot storage, with the version, label, run ids, metric values and created time saved. **Builder's call:** a `benchmark_passes` table, with `runs` tagged by pass id.
- **CLI:**
  - `gen bench baseline` saves baseline-0, once; re-running refuses unless `--force`.
  - `gen bench run` queues bench-v1.
  - `gen bench report [passId]` prints the scorecard as Markdown and writes it to `output/bench/`.
- **Dashboard:** a **Progress** page. It shows:
  - the targets;
  - a table of snapshots side by side (baseline-0, then each pass), each metric marked green when it meets its target;
  - a **Run benchmark** button with the cost note;
  - a pass's status while its runs are in progress;
  - links to the pass's cases so the owner can give their gut score;
  - a "small sample: differences under about 0.05 similarity or one case may be noise" note.
- **Docs:** add the Progress page to the README, user guide and architecture doc, the scorecard terms to the glossary, and one tour step pointing at Progress (an anchor plus copy).

### Constraints

All existing rulings bind:
- escape all text (R13);
- re-runs are idempotent (R20);
- Server Actions use `requireOwnerAction` plus zod;
- web-safe core imports;
- no live LLM calls in tests;
- the merge gates (core and web tests, typecheck, build, check-bundle, secret scan).

The scorecard computation must be pure SQL/TypeScript over stored data. Every query must be bounded and exclude example data.

### Measurement rules (Builder's calls, settled after the design review)

- **Which ideas count (metrics 1, 2 and 6):** every generated idea (`origin = 'generated'`) in the set, whatever its status, including `duplicate`, `screened_out` and `gated_out`. The aim is to measure what the generator produces, not what survives. This matches the baseline's 67 generated ideas. Ideas without an embedding are skipped for metrics 1 and 2.
- **Variety metrics (3 and 5) are per run:** the distinct count within each run, averaged across the set's runs (skip runs where the field is missing for every idea). Targets are per run: **at least 8 buyer types** and **at least 4 business models** out of 12 ideas. This keeps baseline-0 (13 runs) comparable with a 4-run pass.
- **Dedupe against history stays as it is.** Dedupe already compares new ideas with every earlier run (`pipeline/dedupe.ts`), so a benchmark idea can be marked `duplicate` of an old idea. That is real repetition. It still counts in metrics 1 and 2 (within-set) and drives the secondary "new versus history" figure. There is no pipeline change in Phase 1.
- **Snapshots are frozen.** A snapshot stores its run ids and computed values and is never recomputed. baseline-0's owner-verdict metric shows "not applicable (no scores at the time)". `gen bench report --recompute <passId>` saves a new snapshot labelled as a recompute, so gut scores added later can be reflected without changing history.
- **Missing numbers count as a fail.** A case whose `roiMultiple` or `grossMarginPct` is null counts as not meeting metric 8 or 9. It is excluded from the median.
- **Metric 10:**
  - An entrant is an idea with at least one gate verdict.
  - The metric is the share of entrants that ended `gated_out` with a failing `generic` or `autonomy` verdict. Each idea counts once.
  - Owner ideas (advisory-only gate) are excluded.
  - The baseline value is computed from the data, not taken from the rough figures above.

### Left to the builder

- Table and column names, SQL for each metric, Markdown layout and Progress page layout (within the dashboard's existing style).
- How a pass knows it has finished (all its runs succeeded or failed), and what happens when one run fails: the snapshot is computed over the finished runs and flagged incomplete.

### Done when

- baseline-0 is saved, and its numbers match the baseline above, within rounding, for the metrics measured there.
- `gen bench run` and the Progress button queue exactly the 4 bench-v1 runs. After they finish, a snapshot appears beside baseline-0 with every metric either computed or marked "not measured yet (Phase N)".
- Tests cover each metric on fixture data, example exclusion, version immutability and the action's auth and validation.
