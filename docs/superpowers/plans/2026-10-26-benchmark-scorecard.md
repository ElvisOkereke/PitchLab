# Phase 1 Benchmark and Scorecard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. TDD per task (failing test first, capture RED). No live LLM calls and no real network in tests. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make idea quality measurable. Build a 13-metric scorecard computed from stored data, a frozen baseline-0 snapshot, and a fixed `bench-v1` benchmark queued with one action. A Progress page shows snapshots side by side against targets.

**Architecture:**
- **Core** (`packages/core/src/bench/`) holds the pieces:
  - the metric computations over a set of run ids (pure SQL/TypeScript over stored data, no model calls);
  - the frozen benchmark definitions;
  - pass and snapshot storage in a new `benchmark_passes` table, with `runs.benchmark_pass_id` tagging the runs that belong to a pass.
- **The worker** finalises a pass once all its runs are finished.
- **The CLI** gets `gen bench baseline|run|report`.
- **The web app** gets a Progress page and a "Run benchmark" Server Action.

**Tech Stack:** existing (Drizzle + pgvector on PGlite/pg, commander, Next.js 16, Vitest + Testing Library). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-idea-quality-roadmap-and-benchmark-design.md`. The "Phase 1 design" section and "Measurement rules" are binding.

**Branch:** `benchmark`, in a sibling git worktree at `Y:/CODING PROJECTS/Business_Case_Gen-benchmark`, with its own `npm install` and no `.env`. The new migration is `0008` (`npx drizzle-kit generate --name benchmark_passes`, run in `packages/core`).

## Global Constraints

- **Example data is excluded from every metric and pass.** Exclude `runs.is_example = true` and `cases.is_example = true`.
- **No model calls in Phase 1 metrics.** Everything is computed from stored rows. All queries are bounded: at most 200 runs per snapshot and at most 3000 ideas per similarity computation. If a set is over the bound, use the newest runs and add a note.
- **Snapshots are frozen:** values and run ids are stored once and never recomputed in place. Recomputing creates a new snapshot with `kind: 'recompute'`.
- **`bench-v1` seeds are immutable.** A changed set is a new version.
- **Money:** "Run benchmark" shows "about $12–28 in model calls (4 runs at about $3–7 each)" and queues runs only when pressed.
- **Existing rulings bind:**
  - R13: escape all text.
  - R20: idempotent re-runs; multi-row writes in one transaction.
  - Server Actions call `requireOwnerAction()` first, then zod, and never echo values. Each new export gets an entry in the `all-actions-require-session.test.ts` SPECS table.
  - Web-safe core imports: `core-imports.test.ts` and `check-bundle` stay green.
  - Bound parameters only; no `sql.raw` in dashboard, bench or web code.
  - Pages work at 375px with no sideways scroll, tap targets ≥ 44px, light and dark.
- **Copy:** plain and second person. The product name is PitchLab. Small-sample note text: "Small sample: differences under about 0.05 similarity or one case may be noise."
- **Merge gates:**
  - `npm test -w packages/core`, `npm test -w apps/web`, `npm run typecheck -w apps/web`, the web build with dummy env, then `npm run check-bundle -w apps/web`.
  - Chain them with `set -o pipefail`, without piping test output through tail/head.
  - Secret scan: 0 token hits, and no tracked `.env`, `.data`, `output`, `.next`, `.crt`, `.pem` or `.superpowers`.
- **Environment:** never run `gen` or db commands in the worktree without an explicit `DATABASE_URL=pglite://<temp under .data/>`. Never touch the owner's checkout or Supabase. Commits end with the committing agent's `Co-Authored-By` trailer.

## Review Focus

1. **A benchmark queued while other runs are waiting.** The existing `MAX_QUEUED = 3` would block the 4 runs half-way. Expected: refuse cleanly with "Wait until the queue is empty before running the benchmark." and queue nothing. Pinned in Task 3 (`busy → no rows inserted`).
2. **A pass run that fails, or is resumed after the pass was frozen.** Expected: the pass is finalised as `incomplete`, with metrics over all its runs and a visible flag. A later resume doesn't change the frozen snapshot, and `--recompute` makes a new one. Pinned in Task 3.
3. **Sets with too little data**, such as a run with no cases, no embeddings or no buyer types. Expected: the metric shows `value: null` and status `no_data` with a short reason, never NaN or a crash. Pinned in Task 2 (an empty set gives every metric `no_data` or `not_measured`).
4. **Gut scores changed several times.** Expected: only the latest owner `gut` row per case counts. Pinned in Task 2.
5. **Pressing "Run benchmark" twice.** Expected: the second press is refused with "A benchmark pass is already running." Pinned in Task 3 (`pass_running`).

---

## File Structure

```
packages/core/
  src/db/schema.ts                     # + benchmarkPasses table, runs.benchmarkPassId
  drizzle/0008_benchmark_passes.sql    # generated
  src/bench/definitions.ts             # BENCHMARKS (frozen seeds), METRIC_DEFS (ids, labels, targets, phase)  (web-safe)
  src/bench/scorecard.ts               # computeScorecard(db, runIds)  (web-safe: drizzle + schema only)
  src/bench/passes.ts                  # baseline / queue / finalize / list / recompute  (web-safe)
  src/bench/markdown.ts                # renderScorecardMarkdown  (web-safe, pure)
  src/cli-program.ts, src/cli.ts       # gen bench …; worker finalises passes after each run
apps/web/
  app/(app)/progress/page.tsx, components/progress-view.tsx, actions/bench.ts
  components/nav.tsx                   # + Progress tab
  lib/glossary.ts, docs/glossary.md    # + benchmark term
  lib/tour/chapters.ts                 # + one step (anchor progress-scorecard)
README.md, docs/user-guide.md, docs/architecture.md, docs/CONTEXT.md
```

---

### Task 1: Schema and benchmark definitions

**Files:**
- Modify: `packages/core/src/db/schema.ts`
- Generate: `packages/core/drizzle/0008_benchmark_passes.sql`
- Create: `packages/core/src/bench/definitions.ts`
- Test: `packages/core/test/bench/definitions.test.ts`

**Interfaces:**
- Produces (schema):
  - pgEnum `benchmark_kind` = `['baseline', 'pass', 'recompute']`
  - pgEnum `benchmark_status` = `['running', 'complete', 'incomplete']`
  - table `benchmarkPasses`:
    - `id` uuid
    - `version` text (e.g. `'bench-v1'`, or `'baseline'` for baseline-0)
    - `label` text (e.g. `'baseline-0'`, `'bench-v1 #1'`)
    - `kind`, `status`
    - `runIds` uuid[] not null
    - `metrics` jsonb `$type<Scorecard | null>` (null while running)
    - `sourcePassId` uuid nullable → `benchmark_passes.id` (for recomputes)
    - `createdAt`, `completedAt`
  - New column: `runs.benchmarkPassId` uuid nullable → `benchmark_passes.id`.
  - Index: `runs(benchmark_pass_id)`.
- Produces (`definitions.ts`):
  - `type BenchSeed = { seedType: 'open' } | { seedType: 'sector'; sectors: string[] } | { seedType: 'lens'; lensIds: string[] }`
  - `BENCHMARKS: Readonly<Record<'bench-v1', { seeds: readonly BenchSeed[]; ideaCount: 12; advanceCount: 3; costNote: string }>>`. The seeds, in order, are:
    1. `{ seedType: 'open' }`
    2. sectors `['dental clinics', 'restaurants/multi-location food']`
    3. sectors `['property management', 'ecommerce brands (Shopify)']`
    4. lenses `['platform-shockwave', 'public-data-decision']`

    `costNote: 'about $12–28 in model calls (4 runs at about $3–7 each)'`.
  - `CURRENT_BENCHMARK = 'bench-v1'`
  - `type MetricId = 'repetition' | 'nearDuplicates' | 'buyerVariety' | 'consumerShare' | 'modelVariety' | 'realNeed' | 'demandEvidence' | 'customerReturn' | 'margin' | 'wastedEntrants' | 'easyStartHardCopy' | 'ownerVerdict' | 'costPerCase'`
  - `METRIC_DEFS: readonly { id: MetricId; label: string; target: string; phase?: 2 | 3 }[]`, with the 13 rows in the spec's table order. The labels and targets are copied from the spec table, using the "per run" wording for metrics 3 and 5. `phase` is set for consumerShare (3), modelVariety (3), demandEvidence (2) and easyStartHardCopy (3).

- [ ] **Step 1: Write the failing tests:**
  - `bench-v1 is frozen`: deep-equals the literal above. Failure message: "bench-v1 is immutable; add bench-v2 instead".
  - Every sector exists in `CA_US.sectors` and every lens id exists in the seeded `LENSES` (import from `db/seed.ts`).
  - `METRIC_DEFS` has 13 unique ids in the specified order.
  - The migration applies on a test DB, `runs.benchmark_pass_id` exists, and `createTestDb()` still works.
- [ ] **Step 2: Run** `npm test -w packages/core -- bench`. Expected: FAIL.
- [ ] **Step 3: Implement.** Generate the migration, then check that it only adds things.
- [ ] **Step 4: Run** `npm test -w packages/core`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): benchmark pass storage and bench-v1 definition`

### Task 2: Scorecard computation

**Files:**
- Create: `packages/core/src/bench/scorecard.ts`
- Test: `packages/core/test/bench/scorecard.test.ts`

**Interfaces:**
- Consumes: `METRIC_DEFS`, `MetricId` (Task 1).
- Produces:
  - `type MetricResult = { id: MetricId; value: number | null; display: string; meets: boolean | null; status: 'measured' | 'not_measured' | 'no_data'; note?: string }`
  - `type Scorecard = { metrics: MetricResult[]; extra: { runs: number; ideas: number; cases: number; scoredCases: number; medianRoi: number | null; newVsHistory: number | null }; notes: string[] }`
  - `computeScorecard(db: Db, runIds: string[]): Promise<Scorecard>`. Example runs and cases are filtered out even if their ids are passed.
- **Metric rules** (spec "Measurement rules"; G = generated ideas of the set, any status):
  - **repetition:** mean over G-with-embedding of the max cosine similarity to another idea in G, via pgvector `<=>`. Meets when < 0.55. Display has 2 dp.
  - **nearDuplicates:** share of G-with-embedding whose nearest neighbour is ≥ 0.80. Meets when < 10%.
  - **buyerVariety:** per run, the count of distinct normalised `buyer_type` (lowercase, trim, collapse spaces, strip a trailing "s"), averaged over runs with ≥ 1 non-null value. Meets when ≥ 8.
  - **realNeed:** the distinct signal ids cited by G (`ideas.signal_ids`). Share whose `voice` is `operator` or `neutral`; null or vendor counts as no. Meets when ≥ 50%.
  - **customerReturn:** cases whose idea's run is in the set. Share with `sections.numbers.results.buyer.roiMultiple` ≥ 3 (null = fail). `extra.medianRoi` is the median of the non-null values. Meets when 100%.
  - **margin:** share with `…unit.grossMarginPct` ≥ 60 (null = fail). Meets when 100%.
  - **wastedEntrants:**
    - entrants are generated ideas in the set with ≥ 1 `gate_verdicts` row;
    - wasted = status `gated_out` and at least one failing verdict with check `generic` or `autonomy`;
    - each idea counts once.

    Meets when < 30%.
  - **ownerVerdict:** for each case in the set, the latest owner `gut` score (by `createdAt`). Value is the mean over scored cases; display is like "3.7 (5 of 9 scored)". With 0 scored: `no_data` and display "no scores yet". Meets when ≥ 3.5 and every case is scored.
  - **costPerCase:** the sum of `llm_calls.cost_usd` plus `data_calls.cost_usd` for `run_id` in the set, ÷ cases. With 0 cases: `no_data`. `meets` is always null.
  - **consumerShare, modelVariety, demandEvidence, easyStartHardCopy:** status `not_measured`, display "not measured yet (Phase N)".
  - **newVsHistory** (extra): mean over G-with-embedding of the max similarity to generated ideas in real runs *outside* the set. Null if there are none.
  - Any measured metric with an empty denominator → `no_data` with a reason note, never NaN.

- [ ] **Step 1: Write the failing tests.** Build fixtures with core test helpers (`insertRun`, `insertIdea`, `unit(i)` vectors, the cases, scores, gate_verdicts, signals and llm_calls rows), then cover:
  - **Repetition and near-duplicates:** a set with known vectors gives exact values. For example, 3 ideas where two are identical (`unit(1)`, `unit(1)`) and one is orthogonal (`unit(2)`) give repetition = (1 + 1 + 0)/3 ≈ 0.667 and nearDuplicates = 2/3.
  - **Buyer variety:** normalisation merges "Property Managers" and "property manager". The value is averaged per run, and a run with all-null buyer types is skipped.
  - **Real need:** the share is over the distinct cited signals. Untagged counts as no.
  - **Customer return and margin:** a null ROI counts as a fail and is excluded from the median.
  - **Wasted entrants:** an idea failing both `generic` and `autonomy` counts once; an advanced idea with a failing verdict is not wasted; owner-origin ideas are excluded.
  - **Owner verdict:** only the latest gut row counts (old 1, newer 5 → 5). With 0 scored: `no_data` and "no scores yet".
  - **Cost per case:** sums llm and data costs for the set's runs only.
  - **Example exclusion:** passing the example run's id (after `ensureExample`) changes nothing.
  - **Empty set:** every measured metric is `no_data`, the four Phase 2–3 metrics are `not_measured`, and nothing is NaN.
  - **newVsHistory:** compares only against runs outside the set.
- [ ] **Step 2: Run** `npm test -w packages/core -- scorecard`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use one SQL query per metric family; follow the pgvector style in `pipeline/dedupe.ts`.
- [ ] **Step 4: Run** `npm test -w packages/core`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): idea-quality scorecard`

### Task 3: Passes: baseline, queue, finalise, list, recompute

**Files:**
- Create: `packages/core/src/bench/passes.ts`
- Modify: `packages/core/src/cli.ts`. After each run the worker executes, call `finalizeBenchmarkPasses(db)` in a try/catch that logs `benchmark finalise failed` (no details).
- Test: `packages/core/test/bench/passes.test.ts`

**Interfaces:**
- Consumes: `computeScorecard`, `Scorecard` (Task 2); `BENCHMARKS`, `CURRENT_BENCHMARK` (Task 1); `defaultRunConfig`; `QUEUE_MARKET_ID` from `dashboard/runs`.
- Produces:
  - `type PassRow = { id; version; label; kind; status; runIds: string[]; metrics: Scorecard | null; sourcePassId: string | null; createdAt: Date; completedAt: Date | null }`
  - `saveBaseline(db, { force?: boolean } = {}): Promise<{ ok: true; pass: PassRow } | { ok: false; reason: 'exists' }>`. It covers all real runs whose status is `succeeded` or `failed` (newest 200 at most), with label `'baseline-0'`, kind `baseline`, status `complete`. `force` adds a new baseline row labelled `baseline-N`; it never overwrites.
  - `queueBenchmarkPass(db, version = CURRENT_BENCHMARK): Promise<{ ok: true; pass: PassRow } | { ok: false; reason: 'busy' | 'pass_running' }>`.
    - Runs in one transaction, under the same advisory lock key as `queueRun` (`0x6263_7131`).
    - `pass_running` if any pass has status `running`; `busy` if any run is `queued` or `running`.
    - Otherwise it inserts the pass (status `running`, label `'<version> #<n>'`) and one queued run per seed, each with `defaultRunConfig({ ...seed, marketId: QUEUE_MARKET_ID, ideaCount: 12, advanceCount: 3 })` and `benchmarkPassId` set. `runIds` is set to those run ids.
    - Bypassing `MAX_QUEUED` is intentional, because the empty-queue check replaces it.
  - `finalizeBenchmarkPasses(db): Promise<number>`. For each `running` pass whose runs are all `succeeded` or `failed`, it computes the scorecard and sets `metrics`, `completedAt`, and status `complete` (or `incomplete` if any run failed, adding the note "1 of 4 runs failed"). It returns the count finalised and is idempotent.
  - `recomputePass(db, passId): Promise<{ ok: true; pass: PassRow } | { ok: false; reason: 'not_found' | 'running' }>`. It creates a new row with kind `recompute`, label `'<label> (recomputed <yyyy-mm-dd>)'` and `sourcePassId`, using the same run ids.
  - `listBenchmarkPasses(db, limit = 50): Promise<PassRow[]>`, newest first.
  - `passProgress(db, passId): Promise<Record<RunStatus, number>>`.
  - `passCases(db, passId): Promise<{ slug: string; title: string; gut: number | null }[]>`, with gut being the latest owner gut score.
  - Refusal copy constants:
    - `BENCH_REFUSAL = { busy: 'Wait until the queue is empty before running the benchmark.', pass_running: 'A benchmark pass is already running.' }`

- [ ] **Step 1: Write the failing tests:**
  - **Baseline:** covers the finished real runs only, excluding queued, running and example runs. A second call returns `exists`; `force` adds `baseline-1`.
  - **Queue:** inserts 4 runs with the bench-v1 configs and the pass id, even when `MAX_QUEUED` would block.
  - **Refusals:** `busy` inserts nothing when a run is queued; `pass_running` on a second call.
  - **Finalise:**
    - does nothing while any run is queued or running;
    - all succeeded → `complete` with metrics;
    - one failed → `incomplete` plus the note;
    - a second call finalises 0.
  - **Frozen:** after finalising, changing a gut score leaves `metrics` unchanged, and `recomputePass` creates a new row that reflects it.
  - **Listing and progress:** `listBenchmarkPasses` returns newest first and is bounded; `passProgress` counts statuses.
- [ ] **Step 2: Run** `npm test -w packages/core -- passes`. Expected: FAIL.
- [ ] **Step 3: Implement**, including the worker hook in `cli.ts`.
- [ ] **Step 4: Run** `npm test -w packages/core`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): benchmark passes, baseline and finalisation`

### Task 4: CLI and Markdown report

**Files:**
- Create: `packages/core/src/bench/markdown.ts`
- Modify: `packages/core/src/cli-program.ts` (a `bench` command group), `packages/core/src/cli.ts` (handlers)
- Test: `packages/core/test/bench/markdown.test.ts`, extend `packages/core/test/cli-program.test.ts`

**Interfaces:**
- Consumes: Task 3 functions; `METRIC_DEFS`.
- Produces:
  - `renderScorecardMarkdown(passes: PassRow[]): string`. A Markdown table with one row per metric (label, target) and one column per pass (display, then ✓ when it meets the target, ✗ when it doesn't, nothing when null). Below it: extra figures, notes, and the small-sample note. Cell text is escaped for `|` and newlines.
  - CLI commands:
    - `gen bench baseline [--force]`
    - `gen bench run` (prints the cost note and the queued run ids, refusal copy on refusal, exit 1)
    - `gen bench report [passId] [--recompute]`

    `report` first calls `finalizeBenchmarkPasses`. Without an id it renders the baseline plus the 5 newest passes. It prints and writes `output/bench/<yyyy-mm-dd>-<label-slug>.md`.
  - `CliHandlers` gains `benchBaseline(opts)`, `benchRun()` and `benchReport(passId, opts)`.

- [ ] **Step 1: Write the failing tests:**
  - Markdown: renders ✓/✗/blank correctly, escapes `|` in a label, and includes the small-sample note.
  - `cli-program`: parses `bench baseline --force`, `bench run`, and `bench report <id> --recompute` into the handler calls (mock handlers, as in the existing tests).
- [ ] **Step 2: Run** `npm test -w packages/core -- markdown cli-program`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -w packages/core`, then `DATABASE_URL=pglite://.data/bench-check npm run gen -- bench baseline` and `… bench report`. Expected: tests pass, and baseline-0 prints with `no_data` metrics on the empty DB, no crash. Delete `.data/bench-check`.
- [ ] **Step 5: Commit** `feat(core): gen bench commands and markdown report`

### Task 5: Progress page, action, nav, help, tour, docs

**Files:**
- Create: `apps/web/app/(app)/progress/page.tsx`, `apps/web/components/progress-view.tsx`, `apps/web/actions/bench.ts`
- Modify:
  - `apps/web/components/nav.tsx`: Progress tab after Leaderboard, `data-tour: 'nav-progress'`.
  - `apps/web/lib/glossary.ts` plus `docs/glossary.md`: term `benchmark`.
  - `apps/web/lib/tour/chapters.ts`: one step in chapter `decide`, before its final step, on route `/progress` with target `progress-scorecard`. Body: the Progress page compares each benchmark pass with the starting baseline, and you score each pass's cases with "Your gut".
  - `README.md`, `docs/user-guide.md`, `docs/architecture.md` (bench module, `benchmark_passes`, worker finalise), `docs/CONTEXT.md` (status and session log).
- Test: `apps/web/test/actions/bench.test.ts`, `apps/web/test/components/progress-view.test.tsx`, plus the all-actions SPECS entry, tour-chapters, tour-anchors, glossary-sync and docs-links staying green.

**Interfaces:**
- Consumes: `listBenchmarkPasses`, `passProgress`, `passCases`, `queueBenchmarkPass`, `BENCH_REFUSAL`, `BENCHMARKS`, `CURRENT_BENCHMARK`, `METRIC_DEFS`, `PassRow`.
- Produces: `runBenchmarkAction(prev: FormState, fd: FormData): Promise<FormState>`. It calls `requireOwnerAction()` first, takes no user input, and calls `queueBenchmarkPass`. A refusal returns `BENCH_REFUSAL[reason]`. Success revalidates `/progress`, `/runs` and `/command` and returns `{ ok: true }`.
- **Page layout:**
  - **Header:** "Progress", plus one sentence: "Measures how varied, well-evidenced and valuable your generated ideas are. Run the benchmark after each change and compare."
  - **Scorecard table** (`data-tour="progress-scorecard"`): rows are `METRIC_DEFS` (label with the target under it). Columns are the newest baseline plus up to 5 newest complete or incomplete passes and recomputes, each headed with label, date and an "incomplete" badge if relevant. Cells show `display` plus a green (meets) or red (doesn't) badge using the existing badge classes, or muted text for not_measured or no_data. The table scrolls inside `.scroll-x` on narrow screens.
  - **A running pass:** "bench-v1 #n running: X of 4 runs finished", with a link to /runs. The page uses `AutoRefresh` every 10 s while a pass is running.
  - **A "Run benchmark" form:** the button, the cost note, and the line "Runs execute when `npm run worker` is running.", rendered as text. Shown when no pass is running.
  - **"Score these cases":** for the newest finished pass, the list of `passCases`, each linking to `/cases/<slug>?tab=score` and showing "Your gut: n" or "not scored".
  - **Baseline missing:** the text "No baseline yet. Run: npm run gen -- bench baseline".
  - The small-sample note.

- [ ] **Step 1: Write the failing tests:**
  - The action rejects without a session (SPECS), maps `busy` and `pass_running` to the copy, and returns ok after queueing 4 runs on a test DB.
  - The view renders each status style, the incomplete badge, the running-pass line, the hidden button while running, score links, and the baseline-missing text. A hostile label (`<img onerror>`) renders as text.
  - The tour, anchor, glossary and docs-links guards pass with the new step, anchor, term and docs.
- [ ] **Step 2: Run** `npm test -w apps/web -- bench progress`. Expected: FAIL.
- [ ] **Step 3: Implement** the page, action, nav, glossary, tour step and docs.
- [ ] **Step 4: Run** `npm test -w apps/web && npm run typecheck -w apps/web`, then the build with dummy env and `check-bundle`. Expected: all pass, 0 bundle hits.
- [ ] **Step 5: Commit** `feat(web): progress page and run-benchmark action` and `docs: benchmark and progress page`

### Task 6: Whole-branch gates, merge, baseline on the live database

- [ ] **Step 1: Gates.** Run, chained with `set -o pipefail`, the core and web suites, the web typecheck, the web build with dummy env, and `check-bundle`. Expected: all exit 0.
- [ ] **Step 2: Fresh-copy check.** `DATABASE_URL=pglite://.data/bench-check npm run gen -- runs`, then `bench baseline`, then `bench report`. Expected: it migrates, baseline-0 is saved, and the report prints. Delete the folder.
- [ ] **Step 3: Secret scan, then fast-forward `main`.** Run `npm install` and `npm run gen -- runs` in the owner's checkout so Supabase is migrated right after the merge. Push, and remove the worktree.
- [ ] **Step 4: Baseline on the owner's database.** Run `npm run gen -- bench baseline` and `npm run gen -- bench report`. Expected: repetition ≈ 0.68, customer return 2 of 9 with median ≈ 1.53, and real-need evidence computed over the cited signals. Report the numbers to the owner and note any that differ from the spec baseline (for example, cited signals versus all signals).
