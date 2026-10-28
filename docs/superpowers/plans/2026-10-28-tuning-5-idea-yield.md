# Tuning 5: Idea Yield Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. TDD per task: failing test first, capture RED. No live model or network calls in tests; mock the router and adapters' transports. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Keep at least 9 of 12 ideas per run, with visible drop reasons. Score hard-to-copy honestly on an anchored scale. Restore startup coverage in missions.

**Architecture:**
- **Adapters and router:** adapters report cut-off answers; the router re-asks with cut-off wording and tells the caller.
- **`ideate.ts`:** asks for at most 3 ideas per call; normalises more fields; counts drop reasons; tops up inside the single re-ask; applies a code check on toCopy.
- **`ideate.v9`:** anchors the barrier scales.
- **`mission.ts`:** reserves queries for startup sources and asks YouTube for fewer comments.

**Tech Stack:** existing. No new dependencies, no migration.

**Spec:** `docs/superpowers/specs/2026-10-28-tuning-5-idea-yield-design.md`. It is binding.

**Branch:** `tuning5` in the sibling worktree `Y:/CODING PROJECTS/Business_Case_Gen-tuning5`, with its own `npm install` and no `.env`.

## Global Constraints

- **Ideate limits:**
  - `IDEAS_PER_CALL = 3`.
  - Ideate output limit is 16,000 tokens.
  - At most one re-ask round per run. The top-up asks for at most 6 ideas, in calls of at most 3.
- **Strict fields:** an unknown `businessModel`, `audience` or `valueToUser.kind` still drops the idea. An unknown `mechanism` becomes `other`.
- **Drop reasons:** each one is a field path plus a zod issue code, never content.
- **toCopy check:** a toCopy of 4 or 5 whose `toCopyWhy` matches none of the moat keywords is stored as 3 and counted.
- **Startup reservation:** when kinds include `startup`, at least max(2, ⌈15% of queries⌉) queries go to startup sources (YC first, then Product Hunt when available), within the query cap.
- **YouTube:** 40 comments per video by default.
- **Existing rulings bind:**
  - Untrusted text is wrapped.
  - Verified-evidence rules.
  - R13 and R20: calls of 3 are deterministic per run.
  - Bounded queries; bound parameters only.
  - Web-safe imports and check-bundle.
  - v8 and the other old prompts are kept.
- **Merge gates:**
  - `npm test -w packages/core`, `npm test -w apps/web`, `npm run typecheck -w apps/web`, `npx tsc --noEmit -p packages/core`, the web build with dummy env, and `npm run check-bundle -w apps/web`.
  - Chain them with `set -o pipefail`.
  - Secret scan.
- **Environment:**
  - Never run `gen` or db commands without an explicit `DATABASE_URL=pglite://<temp under .data/>`.
  - Never touch the owner's checkout or Supabase.
  - Commits end with the committing agent's `Co-Authored-By` trailer.

## Review Focus

1. **The model returns more ideas than asked for in a call of 3, or an empty `ideas` array.** Expected: extra ideas are cut to the requested count and an empty array counts as returned 0. Neither crashes, and later calls still run. Pinned in Task 2.
2. **Every call for a lens is cut off, even after the router's re-asks.** Expected: that lens contributes 0 ideas and the run continues with the other lenses. `truncatedCalls` counts each cut-off response. Pinned in Tasks 1 and 2.
3. **Number strings the model formats oddly** (`"$1,200/yr"`, `"about 300"`, `"2.5"`, `"N/A"`). Expected: a leading number is used, rounded or clamped where the field needs it. A string with no number stays a string and fails validation as before, so the idea is dropped with a reason. Pinned in Task 2.
4. **A re-run of ideate for the same run id (R20).** Expected: the same lenses, the same split into calls and the same idea set replace the earlier ones, with no duplicates. Pinned in Task 2.
5. **The planner returns only startup-source queries, or the query cap is smaller than the reservation.** Expected: the reservation never pushes the total over the cap, and other sources keep at least one query when the cap allows. Pinned in Task 4.

---

### Task 1: Cut-off answers in adapters and router

**Files:**
- Modify: `packages/core/src/llm/types.ts`, `packages/core/src/llm/anthropic.ts`, `packages/core/src/llm/openai.ts`, `packages/core/src/llm/router.ts`.
- Test: `packages/core/test/llm/anthropic.test.ts`, `packages/core/test/llm/router.test.ts` (add an openai mapping test next to the existing openai tests, or create `test/llm/openai.test.ts` if there are none).

**Interfaces:**
- Produces:
  - `AdapterResponse.truncated?: boolean`: true when Anthropic `stop_reason === 'max_tokens'` or OpenAI `finish_reason === 'length'`.
  - `CallCtx.onTruncated?: () => void`: the router calls it once for every response with `truncated: true`, for any method.
  - `router.structured`: when a response was truncated and invalid, the re-ask message is `Your output was cut off before it finished. Return the same number of items, each shorter, as complete JSON only.`, instead of the generic invalid-output text.

- [ ] **Step 1: Write the failing tests:**
  - anthropic: a mocked message with `stop_reason: 'max_tokens'` maps to `truncated: true`, and `end_turn` maps to falsy.
  - openai: `finish_reason: 'length'` maps to `truncated: true`.
  - router: a truncated invalid first response calls `onTruncated` once, and the second request's last user message equals the cut-off text above. A truncated but valid response is returned and still calls `onTruncated`.
- [ ] **Step 2: Run** `npm test -w packages/core -- anthropic openai router`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the core suite and core tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): report cut-off model answers`.

### Task 2: Ideate yield: calls of 3, normalisation, drop reasons, top-up

**Files:**
- Modify: `packages/core/src/pipeline/ideate.ts`.
- Test: `packages/core/test/pipeline/ideate.test.ts`.

**Interfaces:**
- Consumes: `CallCtx.onTruncated` (Task 1).
- Produces: `IdeateOutput` gains:
  - `requested: number`: ideas asked for across all calls, re-ask included;
  - `returned: number`: array items the model gave back, before validation;
  - `dropReasons: Record<string, number>`: keys like `functionalGap:too_big` or `barriers.toCopy:invalid_type`;
  - `truncatedCalls: number`.

  The whole object is stored as the stage output, as today. The log prints `ideate: dropped N invalid (top reasons: a ×2, b ×1)`.
- Exported for tests: `IDEAS_PER_CALL = 3`, `normalizeIdea(raw: unknown): unknown`, `splitCounts(total: number, perCall: number): number[]` (for example `splitCounts(6, 3)` is `[3, 3]`, `splitCounts(7, 3)` is `[3, 3, 1]` and `splitCounts(2, 3)` is `[2]`).
- Structured calls in ideate pass `maxTokens: 16000`.

- [ ] **Step 1: Write the failing tests** (mock router):
  - **Splitting:** a lens seed with 2 lenses and `ideaCount` 12 makes 4 lens calls, each with `count` 3. Later calls of the same lens see earlier titles in `priorIdeas`.
  - **Extra ideas:** a call returning 5 ideas keeps 3.
  - **Determinism:** the same run id gives the same call sequence on a re-run, and the second run replaces the stored ideas without duplicating them.
  - **Normalisation:**
    - `functionalGap` of 900 characters is kept, cut to 600;
    - 10 incumbents of 200 characters are kept, cut to 8 entries of 120;
    - `"$1,200/yr"` becomes 1200 and `"2.5"` becomes toStart 3;
    - toCopy 7 is clamped to 5;
    - `"One-off"` becomes `one_off`, `"Consumers"` becomes `consumer` and `"b2b"` becomes `business`;
    - an unknown mechanism becomes `other`;
    - `"N/A"` for an amount drops the idea with reason `valueToUser.amountPerYear:invalid_type`.
  - **Still strict:** an unknown businessModel drops the idea with reason `businessModel:invalid_value` (use the actual zod 4 code the schema emits).
  - **Stage output:** `requested`, `returned`, `dropReasons` and `truncatedCalls` appear. `truncatedCalls` counts router `onTruncated` calls.
  - **Top-up:** when the lens calls keep 5 valid ideas of 12 and the mix is met, the single re-ask asks for 6 ideas in calls of 3 (two calls). When both the mix and the count are short, the gap instruction lists both. There is never a second round.
- [ ] **Step 2: Run** `npm test -w packages/core -- ideate`. Expected: FAIL.
- [ ] **Step 3: Implement.** Collect drop reasons in the per-idea `.catch` callback (it receives the zod error). Use the issue path joined with `.` and the issue `code`. Never record input values.
- [ ] **Step 4: Run** the core suite and core tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): ideate asks for 3 ideas per call, keeps more, and says why it drops`.

### Task 3: `ideate.v9` barrier scales and the toCopy check

**Files:**
- Create: `packages/core/prompts/ideate.v9.md` (copy of v8 plus the anchored scales and rules from spec §3, word for word in meaning).
- Modify: `packages/core/src/pipeline/ideate.ts`.
- Test: `packages/core/test/pipeline/ideate.test.ts`, `packages/core/test/pipeline/ideate-prompt.test.ts`.

**Interfaces:**
- Produces:
  - `MOAT_KEYWORDS: readonly RegExp[]`, exported, case-insensitive: proprietary or usage data, network effect, liquidity, two-sided, integration, switching cost, lock-in, licen[cs]e, certification, distribution, community.
  - `checkToCopy(b: Barriers): { barriers: Barriers; lowered: boolean }`.
  - `IdeateOutput.toCopyLowered: number`.
- `loadPrompt('ideate')` now returns v9 (the highest version wins).

- [ ] **Step 1: Write the failing tests:**
  - The v9 prompt text contains each toStart and toCopy anchor (1, 3, 5 and 1–5 respectively) and the rule "at least one idea aiming for toStart ≤ 2 and toCopy ≥ 4".
  - `checkToCopy`: toCopy 4 with why "customers' usage data builds a benchmark no newcomer has" is kept. toCopy 5 with why "great UX" becomes 3 with `lowered: true`. toCopy 3 is unchanged.
  - Ideate stores the lowered value and counts `toCopyLowered`.
  - The prompt version recorded on calls is `ideate.v9`.
- [ ] **Step 2: Run** `npm test -w packages/core -- ideate`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the core suite and core tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): ideate v9 anchors the barrier scales and checks toCopy claims`.

### Task 4: Startup reservation, lighter YouTube, and docs

**Files:**
- Modify:
  - `packages/core/src/research/mission.ts`: add `withStartupQueries` next to `withPricingQueries`, applied when kinds include `startup`.
  - `packages/core/src/research/sources/youtube.ts`: default `commentsPerVideo` 40.
  - Docs:
    - `docs/architecture.md`: ideate calls of 3, drop reasons and the startup reservation.
    - `docs/user-guide.md`: where to see drop reasons, if the run page shows stage output; otherwise skip.
    - `docs/CONTEXT.md`: a status line.
    - `docs/plan-1-followups.md`: anything deferred.
- Test: `packages/core/test/research/mission.test.ts`, `packages/core/test/research/sources/youtube.test.ts`.

**Interfaces:**
- Produces `withStartupQueries(queries: PlannedQuery[], topic: string, max: number, available: { yc: boolean; producthunt: boolean }): PlannedQuery[]`:
  - It guarantees at least max(2, ⌈0.15 × queries⌉) startup-source queries (`yc`, `producthunt`).
  - Added queries are built from the topic's keywords (the first 1–2 significant words), YC first, then alternating with Product Hunt when available.
  - It keeps the total within `max` by dropping trailing queries of other sources, never the reserved pricing queries, and never the last query of any other source when the cap allows.
  - When no startup source is available, it returns the queries unchanged.
- Apply it after the pricing reservation.

- [ ] **Step 1: Write the failing tests:**
  - A plan with 0 yc queries and 20 total gets 3 startup queries and stays at 20.
  - A cap of 12 is never exceeded.
  - A plan of only startup queries is unchanged.
  - Pricing queries survive.
  - With no producthunt, the added queries are yc only.
  - A plan with yc unavailable and producthunt unavailable is unchanged.
  - The mission calls `youtubeSearch` with 40 comments per video (or the youtube default is 40 when the option is omitted).
- [ ] **Step 2: Run** `npm test -w packages/core -- mission youtube`. Expected: FAIL.
- [ ] **Step 3: Implement**, and update the docs.
- [ ] **Step 4: Run** all gates. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): reserve startup queries in missions, lighter YouTube` and `docs: tuning 5`.

### Task 5: Merge and measure (controller)

- [ ] Run the gates and the secret scan. Fast-forward `main`, run `npm install` and `npm run gen -- runs` in the owner's checkout, then push and remove the worktree.
- [ ] Run a bench-v2 pass with `gen bench run`, then `gen worker --once` × 5, then `gen bench report`. Report it against bench-v2 #1 and #2. Also report the ideate stage outputs: requested, returned, kept, drop reasons, cut-off calls and toCopy lowered.
- [ ] Repeat the property-manager / Shopify mission at $5 (CA, US, business) and compare startup entries with mission c7c3cc24 (8) and d43e6364 (20).
