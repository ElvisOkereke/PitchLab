# Idea Quality Loop and Ambition Round Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. TDD per task (failing test first, capture RED). No live model or network calls in tests: mock the router and HTTP. Steps use checkbox (`- [ ]`) syntax.

**Goal:**
- **Part A:** a standing audit loop. It has owner ratings on ideas, an automatic idea reviewer, a funnel and source audit with flags, and a holdout comparison.
- **Part B:** the approved ambition round, measured by that loop:
  - opportunity harvest;
  - ambition lenses;
  - ideate v12 with edge and scale;
  - gate v5;
  - screen v5;
  - bench-v3.

**Architecture:**
- **Migration `0012` adds only:**
  - idea owner-rating, edge and scale columns;
  - `signals.kind`;
  - `lenses.weight`;
  - an `idea_reviews` table.
- **New modules:**
  - `audit/`: `review.ts`, `pass-audit.ts`, `holdout.ts`.
  - `gen audit` commands.
  - New versioned prompts.
- **Scorecard:** gains `ownerLikes`, `medianEdge`, `medianScale`, `nicheShare` and `reviewerAgreement`.
- **Benchmark:** bench-v3 becomes current.

**Tech Stack:** existing. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-04-idea-quality-loop-and-ambition-design.md`. It is binding.

**Branch:** `quality` in the sibling worktree `Y:/CODING PROJECTS/Business_Case_Gen-quality`, with its own `npm install` and no `.env`. The migration is `0012` (`npx drizzle-kit generate --name idea_quality` in `packages/core`).

## Global Constraints

- **Owner tags:** `OWNER_IDEA_TAGS` = `['too niche', 'no edge', 'not scalable', 'already exists', 'boring', 'platform-dependent', 'wordpress or plugin', 'love it', 'would build']`. `owner_rating` is −1, 0 or 1.
- **Reviewer:**
  - It scores 1–5 for `scale`, `edge`, `novelty` and `niche`, plus `reasons`.
  - The niche share counts `niche >= 4 || scale <= 2`.
  - "Liked" means `edge >= 4 && scale >= 3`, and "disliked" means `edge <= 2 || scale <= 2`.
  - Agreement is shown once 10 or more ideas are rated.
  - It works in batches of 10 ideas per call, using the model stage `review` (default: the `score` stage's model).
- **Audit flags:**
  - top domain > 15%;
  - vendor voice > 40%;
  - one lens > 35% of ideas;
  - one gate check > 50% of kills;
  - niche share > 30%.
- **Holdout:**
  - The setting `audit.holdout` holds ≤ 10 items, each ≤ 1,000 characters.
  - It is never read by prompt code; a guard test enforces this.
  - It is compared by cosine similarity with the library embedding model.
- **Harvest:**
  - `opportunityShare` = 0.4.
  - `signals.kind` is `'pain' | 'opportunity'`, default `'pain'`.
  - The setting `harvest.techForums` defaults to false (wordpress and github off; hn and stackexchange are unaffected unless they are part of the same switch today — check and keep their current behaviour).
- **Lenses:**
  - Six ambition lenses: `ai-replaces-labour`, `ten-x-incumbent`, `new-capability`, `marketplace-network`, `data-flywheel`, `picks-and-shovels`.
  - Open and sector runs get at least 2 ambition lenses and at least 2 consumer lenses among at most 6.
  - `review-gap` and `platform-shockwave` get a weight of 0.5.
- **Ideate v12:**
  - `edge` is `{ kind ∈ ai|cost|speed|accuracy|data|network|new_capability|distribution, claim ≤ 300, versus ≤ 200, whyNow ≤ 300 }`.
  - `scale` is `{ buyers ≤ 200, basis ≤ 300, source? }`.
  - The evidence rule is 3 operator or neutral complaint signals from 3 domains, **or** 1 operator or neutral signal plus 1 demand source. A demand source is a cited library trend, market, rule_change or pricing entry, or an opportunity signal from another domain.
- **Gate v5:** `generic` passes a concrete, checkable edge against named incumbents. The evidence code rule matches ideate's.
- **Screen v5:** it adds `edge` and `scale` criteria (1–5), and `speed` has weight 0.5.
- **bench-v3 seeds:**
  - open;
  - open;
  - sector [logistics and freight, construction and trades];
  - sector [healthcare clinics, education and tutoring];
  - lens [ai-replaces-labour, ten-x-incumbent];
  - lens [consumer-ai-chore, new-capability].

  ideaCount 12, advanceCount 3. bench-v1 and bench-v2 stay frozen.
- **Existing rulings bind:**
  - R13 and R20;
  - verified quotes;
  - untrusted text wrapped;
  - bounded queries, bound parameters only;
  - web-safe imports and check-bundle;
  - the Server Action pattern;
  - old prompts kept;
  - plain second-person copy.
- **Merge gates:**
  - `npm test -w packages/core`, `npm test -w apps/web`, `npm run typecheck -w apps/web`, `npx tsc --noEmit -p packages/core`, the web build with dummy env, and `npm run check-bundle -w apps/web`.
  - Chain them with `set -o pipefail`.
  - Secret scan.
- **Environment:**
  - Never run `gen` or db commands without an explicit `DATABASE_URL=pglite://<temp under .data/>`.
  - Never touch the owner's checkout or Supabase.
  - Commits end with the committing agent's `Co-Authored-By` trailer.

## Review Focus

1. **The owner rates an idea, then the run is re-run (R20 replaces the run's ideas).** Expected: ratings on ideas that were replaced are gone with them. A re-run never copies ratings onto different ideas. A pass's `ownerLikes` reflects only current ideas. Pinned in Task 1.
2. **The reviewer returns fewer reviews than ideas, unknown idea ids, or scores out of range.** Expected: valid reviews are stored, the rest are skipped with a count, and a re-run reviews only what's missing. Pinned in Task 3.
3. **A pass with no signals or no gate entrants** (an old pass, or one where every run failed early). Expected: the audit renders "no data" lines with no division by zero, and flags are skipped. Pinned in Task 4.
4. **An idea claims a demand source that it was never shown, or that is the same domain as its only signal.** Expected: it doesn't count. The idea fails the evidence rule in ideate's storage and in the gate's code rule. Pinned in Tasks 7 and 8.
5. **Old ideas without edge or scale, and old passes reviewed under the new metrics.** Expected: the old cases and ideas render unchanged. Screen v5 treats a missing edge or scale as 2 (computed) and doesn't crash. The bench-v2 report still renders. Pinned in Tasks 7–9.

---

### Task 1: Migration 0012 and owner ratings (core)

**Files:**
- Modify: `packages/core/src/db/schema.ts`; generate `0012`.
- Create: `packages/core/src/audit/owner-tags.ts` (web-safe) and `packages/core/src/dashboard/idea-ratings.ts`.
- Modify: `packages/core/src/bench/definitions.ts` and `scorecard.ts` (`ownerLikes`).
- Test: the db test, `test/dashboard/idea-ratings.test.ts`, the scorecard and definitions tests.

**Interfaces:**
- **Schema** (all additive):
  - `ideas`: `ownerRating` smallint null, `ownerTags` text[] null, `ownerRatedAt` timestamptz null, `edge` jsonb null, `scale` jsonb null.
  - `signals`: `kind` text not null default `'pain'`.
  - `lenses`: `weight` real null.
  - `ideaReviews` table: `id`, `ideaId` FK, `scale`, `edge`, `novelty`, `niche` (int, check 1–5), `reasons` jsonb, `model`, `promptVersion`, `createdAt`, with a unique index on `(idea_id, prompt_version)`.
- **`OWNER_IDEA_TAGS`** and `type OwnerIdeaTag`.
- **`rateIdea(db, { ideaId, rating: -1 | 0 | 1 | null, tags: OwnerIdeaTag[] }): Promise<void>`**:
  - A null rating clears the rating and the tags.
  - Unknown tags are rejected with zod.
  - At most 9 tags, deduped.
- **Scorecard `ownerLikes`:** the share of rated (non-null, non-zero) generated ideas rated 1. It meets at 0.5, and is `no_data` when none are rated. The display adds "top tags: a ×n, b ×m, c ×k".

- [ ] **Step 1: Write the failing tests:**
  - The migration applies and is additive.
  - `rateIdea` sets, clears and validates.
  - `ownerLikes` on fixtures, including `no_data`.
  - Ratings vanish with replaced ideas: re-running ideate deletes old ideas with their ratings, and no rating carries over.
- [ ] **Step 2: Run** `npm test -w packages/core -- db idea-ratings scorecard definitions`. Expected: FAIL.
- [ ] **Step 3: Implement.** Generate `0012` and check it only adds things.
- [ ] **Step 4: Run** the core and web suites and both typechecks. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): owner idea ratings and quality columns`.

### Task 2: Rating ideas on the run page (web)

**Files:**
- Modify: the run page idea list component under `apps/web/components` (find the one that lists a run's ideas).
- Create: `apps/web/app/actions/ideas.ts` (a Server Action that calls `rateIdea`, following the existing action pattern with auth, origin and zod).
- Modify: the run query, so it includes `ownerRating` and `ownerTags`.
- Test: web component and action tests, plus the guard tests (core-imports, no `dangerouslySetInnerHTML`).

**Interfaces:**
- **Controls:** each generated idea row gets thumbs up, thumbs down and clear buttons, plus tag chips (toggle) from `OWNER_IDEA_TAGS`.
- **Saving:** changes save right away (optimistic, with an error message on failure), as plain buttons that work without JavaScript through forms.
- **Copy:** the help tip reads "Rate ideas so PitchLab can tell whether changes make them better. Your ratings are never shown to the idea generator."

- [ ] **Step 1: Write the failing tests:**
  - The controls render for generated ideas and not for owner ideas.
  - The action validates and calls `rateIdea`.
  - It rejects without auth.
  - Tags round-trip.
- [ ] **Step 2: Run** `npm test -w apps/web -- run ideas`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the web suite, the web typecheck, the build with dummy env and check-bundle. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): rate ideas on the run page`.

### Task 3: Idea reviewer

**Files:**
- Create:
  - `packages/core/prompts/idea-review.v1.md`;
  - `packages/core/src/audit/review.ts`.
- Modify:
  - the router model stages (add `review`, defaulting to the `score` stage's model, overridable via `MODEL_OVERRIDES`);
  - `packages/core/src/cli-program.ts` / `cli.ts` (`gen audit review [passId] [--last] [--dry-run]`);
  - `bench/definitions.ts` and `scorecard.ts` (`medianEdge`, `medianScale`, `nicheShare`, `reviewerAgreement`).
- Test: `test/audit/review.test.ts`, plus the CLI and scorecard tests.

**Interfaces:**
- **`reviewPassIdeas(deps: { db; router; log }, passId: string, opts?: { dryRun?: boolean }): Promise<{ reviewed: number; skipped: number; estimatedUsd: number }>`**
  - It reviews the pass's generated ideas that have no review for the current prompt version.
  - It sends batches of 10, with each idea rendered via `ideaBlock` and wrapped as untrusted.
  - The structured output is `{ reviews: [{ ideaId, scale, edge, novelty, niche, reasons: { scale, edge, novelty, niche } }] }`.
  - It drops unknown ids and out-of-range scores, with a count.
  - It is idempotent.
- **Prompt rubric (`idea-review.v1`):** anchors per score.
  - Edge: 1 = none or "uses AI"; 3 = a modest, credible improvement; 5 = a large, checkable advantage or a new capability.
  - Scale: 1 = a few hundred buyers or one niche; 3 = tens of thousands of buyers or a mid-size market; 5 = millions or a very large market.
  - Novelty: 1 = exists widely; 5 = genuinely new.
  - Niche: 1 = broad; 5 = one tiny segment.
  - The reviewer never sees owner ratings or holdout items.
- **Scorecard metrics:**
  - **medianEdge** and **medianScale:** the median over reviewed generated ideas in the set; each meets at ≥ 3.5.
  - **nicheShare:** meets at ≤ 0.3.
  - **reviewerAgreement:** the share of owner-rated ±1 ideas where the reviewer's verdict (liked or disliked, per the constraints) matches. Neither verdict counts as a miss. It meets at ≥ 0.7, and is `no_data` under 10 rated.

- [ ] **Step 1: Write the failing tests:**
  - Batching.
  - Storage.
  - Idempotence (a second run reviews 0).
  - Malformed reviews are skipped and counted.
  - The dry run estimates cost without calling.
  - The metrics on fixtures, including `no_data` and the agreement threshold.
  - The CLI wiring.
- [ ] **Step 2: Run** `npm test -w packages/core -- review scorecard cli`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the core suite and core tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): idea reviewer for scale, edge, novelty and niche`.

### Task 4: Pass audit, flags, holdout, and the report and Progress page

**Files:**
- Create:
  - `packages/core/src/audit/pass-audit.ts`;
  - `packages/core/src/audit/holdout.ts`.
- Modify:
  - `bench/markdown.ts` (the Audit section);
  - `cli` (`gen audit holdout add|list|clear`; `gen bench report` includes the audit);
  - the Progress page component and its query (the audit under each pass);
  - the Settings page (the holdout list editor via a Server Action);
  - `apps/web/lib/glossary.ts` and `docs/glossary.md` (owner likes, idea reviewer, niche share, audit flags, holdout examples).
- Test: `test/audit/pass-audit.test.ts`, `test/audit/holdout.test.ts`, a guard test that no file under `packages/core/src/pipeline/` or `prompts/` references `audit.holdout` or `holdout`, plus web tests.

**Interfaces:**
- **`computePassAudit(db, passId): Promise<PassAudit>`**:
  - `PassAudit = { signals: { total; byVoice; bySource; topDomains: { domain; share }[] }; lenses: { lensId; ideas; screenedIn; advanced; cases }[]; gateKills: Record<string, number>; dropReasons: Record<string, number>; demandShare: number | null; flags: string[] }`.
  - The flags use the plain-language thresholds from the constraints, for example "wordpress.org supplied 18% of the evidence (limit 15%)".
- **Holdout:**
  - `holdoutAdd(db, text)`, `holdoutList(db)`, `holdoutClear(db)`.
  - `holdoutCompare(deps, passId): Promise<{ items: { text; bestIdeaTitle; similarity }[]; median: number | null }>`. It uses one embed call for the holdout items plus stored idea embeddings, or embeds idea text if ideas have none (check).
- **Rendering:** the report and the Progress page render the audit and holdout as text, with "no data" where empty.

- [ ] **Step 1: Write the failing tests:**
  - Each audit field on fixtures.
  - The flags at their thresholds.
  - The empty pass.
  - Holdout CRUD with caps.
  - The comparison math.
  - The isolation guard.
  - The web renders and the actions.
  - The glossary sync.
- [ ] **Step 2: Run** `npm test -w packages/core -- audit holdout markdown` and `npm test -w apps/web -- progress settings glossary`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** all gates. Expected: PASS.
- [ ] **Step 5: Commit** `feat: pass audit, flags and holdout examples`.

### Task 5: Opportunity harvest and opt-in tech forums

**Files:**
- Create: `packages/core/prompts/harvest-research.v7.md` (pain and opportunity angles).
- Modify: `packages/core/src/pipeline/harvest.ts`, plus the extract step so it stores `signals.kind`.
- Test: `test/pipeline/harvest.test.ts`.

**Interfaces:**
- **Angles:**
  - `OPPORTUNITY_SHARE = 0.4`.
  - Research calls are split deterministically per run (R20): `round(n × 0.4)` calls use the opportunity angle, at least 1 when n ≥ 2.
  - Opportunity extraction keeps findings that show growth, spend, adoption, paid manual work or what's working, each with a verified quote, and stores `kind: 'opportunity'`.
- **Tech forums:** `wordpress` and `github` are queried only when the setting `harvest.techForums` is true. Their prior seed rule stays, inside that switch. hn and stackexchange keep today's rule.
- **Stage output:** it records `{ painCalls, opportunityCalls, techForums: boolean }`.

- [ ] **Step 1: Write the failing tests:**
  - The split counts and determinism.
  - Opportunity signals are stored with their kind.
  - With the switch off, wordpress and github are never called for a Shopify seed; with it on, they behave as before.
  - Old signals read `pain`.
- [ ] **Step 2: Run** `npm test -w packages/core -- harvest`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the core suite and core tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): opportunity harvest; tech forums opt-in`.

### Task 6: Ambition lenses and weighted sampling

**Files:**
- Modify: `packages/core/src/db/seed.ts` (the six lenses with pattern and promptHint per spec B2, `audience: 'any'`, plus weight 0.5 for `review-gap` and `platform-shockwave`, applied with an update so existing databases get it) and `packages/core/src/pipeline/ideate.ts` (`selectLenses`).
- Test: the seed test and `test/pipeline/ideate.test.ts`.

**Interfaces:**
- `AMBITION_LENS_IDS` (exported).
- `selectLenses(all, cfg, rng)`:
  - Open and sector runs pick at most 6, with at least 2 consumer and at least 2 ambition lenses when they're available.
  - The remaining slots are weighted by `weight ?? 1`.
  - The choice is deterministic per run id.
  - Lens seeds are exact.

- [ ] **Step 1: Write the failing tests:**
  - After seeding, the 6 ambition lenses exist and the two weights are set, on a fresh database and on an existing one.
  - Sampling meets the minimums.
  - Weights affect the frequency, checked over many seeded run ids.
  - The choice is deterministic.
  - Lens seeds are exact.
- [ ] **Step 2: Run** `npm test -w packages/core -- seed ideate`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the core suite and core tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): ambition lenses and weighted lens sampling`.

### Task 7: Ideate v12 (edge, scale, evidence rule)

**Files:**
- Create: `packages/core/prompts/ideate.v12.md` (v11 plus spec B3: the new identity line, edge and scale with rubric anchors, the evidence alternative; keep every v11 variable).
- Modify: `packages/core/src/pipeline/ideate.ts` (schema, normalisation of the new fields, storage, and the evidence alternative counted against what the idea was shown) and the Summary tab in `apps/web` (show edge and scale as text when present).
- Test: `test/pipeline/ideate.test.ts`, `ideate-prompt.test.ts`, and the web summary tests.

**Interfaces:**
- `EdgeSchema` and `ScaleSchema` in `pipeline/business-models.ts` (web-safe).
- Generated ideas require `edge` and `scale`; owner ideas leave them optional.
- `hasDemandEvidence(idea, shownLibraryKinds: Map<id, kind>, signals): boolean`, exported.
- An idea that meets neither evidence route is dropped with the reason `evidence:insufficient`.
- `loadPrompt('ideate')` returns v12.

- [ ] **Step 1: Write the failing tests:**
  - The new fields are parsed, normalised (cut to their limits) and stored.
  - An idea missing edge or scale drops with a reason.
  - The evidence route passes for 1 signal plus a shown trend entry.
  - It fails for 1 signal plus an id that wasn't shown, or an opportunity signal from the same domain.
  - The 3-signal route still passes.
  - The prompt contains the identity line and has no "small", "pilot fast" or "he".
  - The Summary tab renders edge and scale, and old ideas look the same.
- [ ] **Step 2: Run** `npm test -w packages/core -- ideate` and `npm test -w apps/web -- summary`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the core and web suites and both typechecks. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): ideate v12 asks for edge and scale; demand evidence route`.

### Task 8: Gate v5 and Screen v5

**Files:**
- Create: `packages/core/prompts/gate.v5.md` and `screen.v5.md`.
- Modify: `packages/core/src/pipeline/gate.ts` (the evidence code rule's alternative route, reusing `hasDemandEvidence` logic on the idea's stored citations and signals) and `screen.ts` (the `edge` and `scale` criteria, the speed weight of 0.5, and a missing edge or scale scored 2); `ideate.ts` `MOAT_KEYWORDS` (the additions from spec B5).
- Test: `test/pipeline/gate.test.ts` and `screen.test.ts`.

**Interfaces:**
- **gate.v5 `generic`:** the spec B4 wording. The idea block shows the edge and scale lines (via `ideaBlock`).
- **Screen:** the criteria gain `edge` and `scale`, and the rank is a weighted mean (all 1, speed 0.5).

- [ ] **Step 1: Write the failing tests:**
  - The gate's `generic` wording, including that "uses AI" alone fails.
  - The evidence rule's two routes in code, with the Review Focus 4 cases.
  - The screen's weighted rank.
  - A missing edge or scale is scored 2.
  - The moat keywords.
  - Old ideas still screen.
- [ ] **Step 2: Run** `npm test -w packages/core -- gate screen ideate`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the core suite and core tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): gate v5 allows competition with a concrete edge; screen v5 scores edge and scale`.

### Task 9: bench-v3 and docs

**Files:**
- Modify:
  - `packages/core/src/bench/definitions.ts` (`bench-v3` per the constraints, `CURRENT_BENCHMARK`, and the cost note "about $30–50 in model calls (6 runs)");
  - `db/seed.ts` (add any sector strings missing from `CA_US.sectors`, additively);
  - README, `docs/user-guide.md` (rating ideas, the audit, holdout examples, the new idea fields), `docs/architecture.md`, `docs/CONTEXT.md`, `docs/OWNER-TODO.md` (rate about 10 ideas per pass and optionally add holdout examples);
  - create `docs/idea-quality-log.md` (the format and an empty first entry for the bench-v2 baseline).
- Test: the frozen-benchmark tests (bench-v1 and bench-v2 unchanged, bench-v3 frozen), a check that the seed sectors exist, the docs-links and glossary guards.

- [ ] **Step 1: Write the failing tests.**
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** all gates. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): bench-v3 with wider seeds` and `docs: idea quality loop and ambition round`.

### Task 10: Merge, baseline, measure (controller)

- [ ] **Merge:**
  1. Run the gates and the secret scan.
  2. Fast-forward `main`.
  3. Run `npm install` and `npm run gen -- runs` (migrates `0012`) in the owner's checkout.
  4. Push and remove the worktree.
- [ ] **Baseline:** run `gen audit review` on bench-v2 #4, #5 and #6, then `gen bench report`. Write the baseline entry in the quality log.
- [ ] **Measure:** run bench-v3 #1 (6 runs), `gen audit review --last` and `gen bench report`. Report against the baseline, and write the log entry. Ask the owner to rate about 10 ideas and, optionally, add holdout examples.
