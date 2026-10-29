# Slice B: What's Changing and Where the Market Is — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. TDD per task (failing test first, capture RED). No live network or model calls in tests: mock HTTP and the router. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Trend, rule-change and market entries from free official sources. Ideation sees them and cites them. Demand evidence (metric 7) is measured.

**Architecture:**
- Facts schemas for the three reserved kinds.
- Four free collectors (Federal Register, Wikipedia pageviews, HN yearly counts, World Bank) plus web extraction.
- Mission kinds widened from Slice A to all six.
- `ideationContext` gains `changing` and `markets` sections, fed to `ideate.v10`.
- The scorecard computes metric 7.

**Tech Stack:** existing. No new dependencies. No migration expected (kinds already exist in the enum). If one is needed, it is additive and named `0012`.

**Spec:** `docs/superpowers/specs/2026-10-29-slice-b-changes-and-markets-design.md`. It is binding.

**Branch:** `sliceb` in the sibling worktree `Y:/CODING PROJECTS/Business_Case_Gen-sliceb`, with its own `npm install` and no `.env`.

## Global Constraints

- **Collectors:**
  - Fixed hosts only, through `request()` / `getJson` (the guarded lookup and pinning), with the PitchLab `USER_AGENT`. No key.
  - Hosts: `www.federalregister.gov`, `en.wikipedia.org`, `wikimedia.org`, `hn.algolia.com` (existing), `api.worldbank.org`.
- **Direction thresholds:** at least +20% is `rising`, at most −20% is `falling`, anything else is `steady`.
- **Thin-data skips:**
  - pageviews under 1,000 in the window;
  - HN under 20 stories in total.
- **Windows:**
  - pageviews: the last 36 full months, comparing the last 12 with the previous 12;
  - HN: the last 4 calendar years, comparing the last full year with the year before.
- **Federal Register:** types RULE and PRORULE, published in the last 24 months, at most 10 per query.
- **World Bank:** indicators `SP.POP.TOTL`, `NY.GDP.PCAP.CD`, `IT.NET.USER.ZS`, `IT.CEL.SETS.P2`, `IC.BUS.NDNS.ZS`, `SP.URB.TOTL.IN.ZS`, with `mrv=6`, once per mission per non-global country.
- **Stale rules dropped before storage:** published more than 3 years ago, or effective more than 2 years ago.
- **Ideation sections:** `changing` holds at most 10 entries, `markets` at most 6. Both are live entries only, follow the country rule, and are wrapped as untrusted.
- **Metric 7:** ideas whose `libraryItemIds` include a trend, rule_change or market entry, over ideas with `libraryItemIds` set. It meets at 0.8; `no_data` when nothing is set.
- **Existing rulings bind:**
  - robots.txt for web pages;
  - the privacy scrub;
  - verified quotes for text items, at least 6 words or 30 characters;
  - soft budgets and bounded queries, bound parameters only;
  - R13 and R20;
  - web-safe imports and check-bundle;
  - old prompts kept;
  - Copy is plain and second person.
- **Merge gates:**
  - `npm test -w packages/core`, `npm test -w apps/web`, `npm run typecheck -w apps/web`, `npx tsc --noEmit -p packages/core`, the web build with dummy env, and `npm run check-bundle -w apps/web`.
  - Chain them with `set -o pipefail`.
  - Secret scan.
- **Environment:**
  - Never run `gen` or db commands without an explicit `DATABASE_URL=pglite://<temp under .data/>`.
  - Never touch the owner's checkout or Supabase.
  - Commits end with the committing agent's `Co-Authored-By` trailer.

## Review Focus

1. **Wikipedia OpenSearch resolves a topic to an unrelated or disambiguation article** (for example "Mercury"). Expected: a disambiguation page (title ending "(disambiguation)", or the series under the thin threshold) is skipped. The entry title names the article that was actually used, so a mismatch is visible. Pinned in Task 2.
2. **An API returns HTTP 200 with an unexpected shape** (World Bank's error object `[{"message":[...]}]`, a missing `nbHits`, Federal Register `results` absent). Expected: that source yields nothing for the query, adds a mission warning, and the mission continues. Pinned in Task 2.
3. **A rule change whose dates are missing or malformed.** Expected: a null date is allowed, a malformed date is stored as null, and the stale filter keeps null-dated entries only when they were published within 3 years or the publication date is unknown but came from the Federal Register query window. Pinned in Tasks 2 and 3.
4. **Missions created before this change, with kinds limited to Slice A, and older stored kinds arrays.** Expected: they run exactly as before, and the planner offers no new sources unless their kinds are selected. Pinned in Task 3.
5. **Ideation with an empty Slice B library.** Expected: both sections render "none found", ideas are generated as before, and metric 7 counts them as not citing (not `no_data`, since `libraryItemIds` is set). Pinned in Task 4.

---

### Task 1: Facts schemas, kind labels, mission kinds widened

**Files:**
- Modify:
  - `packages/core/src/library/kinds.ts`: `FactsSchemas.trend`, `rule_change` and `market` per spec §1, plus `KIND_LABELS: Record<KnowledgeKind, string>` (web-safe).
  - `packages/core/src/dashboard/missions.ts`: kinds accept all six, at most 6, defaults unchanged.
  - `packages/core/src/cli-program.ts`: `--kinds` accepts all six.
  - `apps/web/components/mission-form.tsx` and `apps/web/lib/library-query.ts`: the new kinds, labelled from `KIND_LABELS`.
  - The library entry detail: render the facts of the new kinds as text (trend evidence lines, rule dates and status, market clues).
- Test: `packages/core/test/library/kinds.test.ts`, the missions dashboard test, the CLI test, and web tests for the mission form, library filter and entry detail.

**Interfaces:**
- Produces:
  - `FactsSchemas.trend | rule_change | market`, plus `parseFacts` accepting them;
  - `KIND_LABELS` with:
    - `trend`: "What's growing or shrinking"
    - `rule_change`: "A rule or platform change"
    - `market`: "Market size clues"
    - The labels for the existing kinds keep their current copy, if the web already has one; move it here.
  - `MissionInputSchema.kinds`: `z.array(z.enum(KNOWLEDGE_KINDS)).min(1).max(6)`.
- `SLICE_A_KINDS` stays exported and keeps its meaning. Do not change `research/mission.ts` in this task.

- [ ] **Step 1: Write the failing tests:**
  - Valid and invalid samples per schema: a trend needs 1–6 evidence items; a market needs 1–8 size clues; dates are ISO or null.
  - Kinds accepted by the dashboard and the CLI.
  - The web form shows the labels.
  - The entry detail renders the facts of each new kind as text.
- [ ] **Step 2: Run** `npm test -w packages/core -- kinds missions cli` and `npm test -w apps/web -- mission library`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the core and web suites and both typechecks. Expected: PASS.
- [ ] **Step 5: Commit** `feat: trend, rule-change and market kinds`.

### Task 2: Free collectors

**Files:**
- Create: `packages/core/src/research/sources/federalregister.ts`, `wikipageviews.ts`, `worldbank.ts`, `hntrend.ts`.
- Test: one test file per collector under `packages/core/test/research/sources/`.

**Interfaces** (each takes `opts: { request?/getJson?; now?: () => Date; log }` in the style of the existing collectors):
- `federalRegisterSearch(q: string, opts): Promise<RawItem[]>`: one text item per document, `sourceType: 'federalregister'`, with `hints: { effectiveDate: string | null; publishedDate: string | null; status: 'final' | 'proposed' }`. Add `hints?: Record<string, unknown>` to `RawItem` if it isn't there.
- `wikiTrend(topic: string, opts): Promise<KnowledgeDraft | null>`: a structured trend with basis `measured` and `sourceType: 'wikipedia'`.
- `hnTrend(q: string, opts): Promise<KnowledgeDraft | null>`: a structured trend with `sourceType: 'hn'`.
- `worldBankMarket(countryIso2: string, opts): Promise<KnowledgeDraft | null>`: a structured market with `sourceType: 'worldbank'`.
- `trendDirection(prev: number, last: number): 'rising' | 'falling' | 'steady'`, exported and shared by the two trend collectors. When `prev` is 0 and `last` is above 0, the result is `rising`.
- A 429 from any source throws `SourceError('rate_limited')`, so the mission can stop that source with a warning (the existing pattern).

- [ ] **Step 1: Write the failing tests** (mocked HTTP):
  - **Federal Register:** mapping, the type and date conditions in the request URL, 10 results at most, a missing `results` returns `[]`.
  - **Wikipedia pageviews:** OpenSearch resolution; a disambiguation page or a thin series returns null; the direction for +25%, −25% and +5%; the entry title names the resolved article; the window covers 36 full months.
  - **HN trend:** 4 yearly counts with the correct numeric filters; fewer than 20 stories returns null; a missing `nbHits` returns null.
  - **World Bank:** the six indicators; the error-object shape returns null; nulls in a series are skipped; growth clues are computed.
  - **Direction thresholds:** exactly +20% is rising and exactly −20% is falling.
- [ ] **Step 2: Run** `npm test -w packages/core -- federalregister wikipageviews hntrend worldbank`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the core suite and core tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): free trend, rule-change and market collectors`.

### Task 3: Mission integration, planner v4, extraction v5

**Files:**
- Create: `packages/core/prompts/library-plan.v4.md`, `packages/core/prompts/extract-signals.v5.md`.
- Modify: `packages/core/src/research/mission.ts`. Background research topic rotation, wherever it lives (find it), adds the new kinds.
- Test: `packages/core/test/research/mission.test.ts` and the background research test.

**Interfaces:**
- `MISSION_SOURCES` gains `federalregister`, `wikipedia` and `worldbank`.
- `SOURCES_FOR_KIND` becomes a `Record<KnowledgeKind, …>`:
  - trend: `['wikipedia', 'hn', 'web']`
  - rule_change: `['federalregister', 'web']`
  - market: `['worldbank', 'web']`
- `hn` serves two roles. For trend-kind queries the planner marks them `{ source: 'hn', q, purpose: 'trend' }`, and those go to `hnTrend`. Keep the existing hn search for problem queries.
- `worldbank` is not planned. It runs once per mission per non-global country whenever `market` is among the kinds.
- `filterStaleRules(drafts: KnowledgeDraft[], now: Date): { kept: KnowledgeDraft[]; dropped: number }`, exported.
- Mission kinds come from `m.kinds` filtered to `KNOWLEDGE_KINDS`. When the result is empty, the mission uses the Slice A defaults.
- The extraction schema accepts the new kinds and their facts. Federal Register hints are merged into the `rule_change` facts when the model leaves the dates null.

- [ ] **Step 1: Write the failing tests:**
  - **Planner:** it offers each new source only when its kind is selected.
  - **Old missions:** a mission with Slice A kinds behaves exactly as before, with the same planned sources.
  - **Federal Register:** its items go through extraction, and the hints fill dates.
  - **Structured entries:** wiki, HN-trend and World Bank drafts are stored with no extraction call.
  - **Stale rules:** dropped, and counted in the warnings.
  - **World Bank:** runs once per non-global country.
  - **Rate limits:** a 429 from wiki or World Bank stops that source with a warning, and the mission continues.
  - **Background research:** it rotates the new kinds.
- [ ] **Step 2: Run** `npm test -w packages/core -- mission background`. Expected: FAIL.
- [ ] **Step 3: Implement**, with the prompt text per spec §3.
- [ ] **Step 4: Run** the core suite and core tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): missions collect trends, rule changes and markets`.

### Task 4: Ideation sections, ideate v10, metric 7

**Files:**
- Create: `packages/core/prompts/ideate.v10.md` (v9 plus the two blocks and rules from spec §4).
- Modify: `packages/core/src/library/context.ts`, `packages/core/src/pipeline/ideate.ts`, `packages/core/src/bench/definitions.ts`, `packages/core/src/bench/scorecard.ts`.
- Test: `test/library/context.test.ts`, `test/pipeline/ideate.test.ts`, `test/pipeline/ideate-prompt.test.ts`, the scorecard and definitions tests, and web tests that render the scorecard row.

**Interfaces:**
- `IdeationContext` gains `changing: CtxChange[]` and `markets: CtxMarket[]`:
  - `CtxChange = { id; kind: 'trend' | 'rule_change'; gist; keyFact; url }`
  - `CtxMarket = { id; segment; geography; keyFact; url }`
  - Option caps: `changingMax` defaults to 10, `marketsMax` to 6.
  - Rule changes come first when their effective date falls within 18 months of `now`; the rest go by similarity.
- `renderIdeationContext` returns `changing` and `markets` strings as well, with "none found" when empty.
- Ideate passes the two new variables wrapped as `changing` and `markets`. The library ids shown include them, so citations are stored.
- `computeScorecard` adds `demandEvidence: { value: number | null; n: number; d: number }`, and the phase marker on its definition is removed.

- [ ] **Step 1: Write the failing tests:**
  - **Context:** the classification, both caps, rule-first ordering, the country rule, expired or rejected entries excluded, and "none found".
  - **Prompt:** v10 contains both blocks and the "cite only when the idea depends on it" rule. `loadPrompt('ideate').version` is `ideate.v10`.
  - **Citations:** a cited trend id is stored in `libraryItemIds`, and an id that wasn't shown is dropped.
  - **Metric 7:** 3 of 4 ideas citing gives 0.75; old ideas with no `libraryItemIds` give `no_data`; with an empty Slice B library the count is 0 out of n.
  - **Web:** the scorecard row renders metric 7 without "not measured yet".
- [ ] **Step 2: Run** `npm test -w packages/core -- context ideate scorecard definitions`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the core and web suites and both typechecks. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): ideation sees what's changing and market size; demand evidence metric`.

### Task 5: Docs

**Files:**
- Modify: README (sources table and keys: none new), `docs/user-guide.md` (mission kinds), `docs/architecture.md` (collectors, kinds, ideation sections, metric 7), `docs/glossary.md` and `apps/web/lib/glossary.ts` (trend, rule change, market, demand evidence), `docs/CONTEXT.md`, `docs/OWNER-TODO.md` (nothing to sign up for; score the bench-v2 #5 cases when they appear).
- Test: the glossary-sync and docs-links guards.

- [ ] **Step 1:** Update the docs and the glossary.
- [ ] **Step 2: Run** all gates. Expected: PASS.
- [ ] **Step 3: Commit** `docs: slice B`.

### Task 6: Merge, fill and measure (controller)

- [ ] **Merge:**
  1. Run the gates and the secret scan.
  2. Fast-forward `main`.
  3. Run `npm install` and `npm run gen -- runs` in the owner's checkout.
  4. Push and remove the worktree.
- [ ] **Fill:** 3 missions at $5 with `--kinds trend,rule_change,market`:
  - (a) dental clinics and restaurants, CA and US;
  - (b) property managers and Shopify store owners, CA and US;
  - (c) everyday personal finance, side income, housing and health admin, global, consumer.

  Report entry counts per kind and the share of measured trends.
- [ ] **Measure:** bench-v2 #5 (`gen bench run`, `gen worker --once` × 5, `gen bench report`), reported against #4.
