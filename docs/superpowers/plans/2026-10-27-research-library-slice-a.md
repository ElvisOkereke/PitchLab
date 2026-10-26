# Phase 2 Slice A: Research Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. TDD per task (failing test first, capture RED). No live model calls and no real network in tests: mock the router, the sources and `fetch`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** a persistent research library of `problem`, `startup` and `pricing` entries, filled by worker-run research missions and an opt-in background trickle, browsable on a Library page. Runs draw verified-quote entries from it as evidence.

**Architecture:**
- **Core** gains a `library/` module:
  - entry storage with hash and near-duplicate merge;
  - a `knowledge_sources` child table;
  - search, coverage and retrieval.
- **Core** gains a `research/` module:
  - new free source collectors with robots.txt and rate limits;
  - the mission engine: plan, collect, extract, verify, embed, store, under a soft budget;
  - a background scheduler.
- **Missions are queued** like validation jobs and claimed by the worker after runs and validation jobs.
- **Harvest** gets a `library` source that upserts signals linked to entries.
- **Web** adds a Library page, research settings and connection badges.

**Tech Stack:** existing (Drizzle + pgvector, the model router with `structured`/`research`/`embed`, undici through the guarded fetcher, Next.js 16, Vitest). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-26-research-library-design.md`. All of it is binding, including "Decisions settled after the design review".

**Branch:** `library` in a sibling worktree `Y:/CODING PROJECTS/Business_Case_Gen-library`, with its own `npm install` and no `.env`. The migration is `0009` (`npx drizzle-kit generate --name research_library`, run in `packages/core`).

## Global Constraints

- **Money:**
  - Missions run only when started (page form or `gen research`).
  - Background collection is **off by default** (`research.background = false`), with cap `research.dailyCapUsd = 5` on the America/Toronto day.
  - Budgets are soft: checked between steps and between source batches, with one in-flight batch allowed to overshoot.
  - The mission form shows "up to $X", plus a typical cost once 1 or more missions have finished.
  - Mission budget range is 0.5–10, default 2. Background missions use a $1 budget.
- **Evidence integrity:**
  - Only `problem` and `pricing` entries whose quote is verified become signals.
  - "Verified" means the quote appears verbatim, after `normalize()` from `pipeline/verify.ts`, in the source text the collector actually fetched (API text or fetched page text). Quotes produced by the model alone are never verified.
- **Public data:**
  - Quotes are 500 characters or less.
  - Store no usernames, profile URLs or author handles, and strip `u/…`, `@handle` and "posted by" patterns from quotes and summaries.
  - Check robots.txt before any collector page fetch; disallowed means skip.
  - Per-source rate limits.
  - Only English-language sources.
  - Banned-source domains (`tools/banned-sources.ts`) are enforced.
- **Untrusted text:** all fetched text reaches prompts only through `wrapUntrusted` and `capField` (`llm/untrusted.ts`). All network goes through the SSRF-guarded `fetchPage` or the existing `getJson`/`getBody` helpers.
- **Existing rulings bind:**
  - R13: escape all text, no `dangerouslySetInnerHTML`.
  - R20: idempotent steps; multi-row writes in one transaction.
  - Server Actions call `requireOwnerAction()` first, then zod; messages never echo values. Each new export gets a SPECS entry in `all-actions-require-session.test.ts`.
  - Web-safe core imports; `check-bundle` stays green.
  - Bounded queries: list and search have a max page of 50, retrieval returns at most 30.
  - Bound parameters only.
  - Pages work at 375px, tap targets are 44px or more, light and dark modes.
- **Copy:** plain, second person; the product name is PitchLab.
- **Merge gates:**
  - Core and web suites, web typecheck, web build with dummy env, `check-bundle`.
  - Chain with `set -o pipefail`; don't pipe test output through tail or head.
  - Secret scan: 0 token hits, and no tracked `.env`, `.data`, `output`, `.next`, `.crt`, `.pem` or `.superpowers`.
- **Environment:**
  - Never run `gen` or db commands without an explicit `DATABASE_URL=pglite://<temp under .data/>`.
  - Never touch the owner's checkout or Supabase.
  - Commits end with the committing agent's `Co-Authored-By` trailer.

## Review Focus

1. **A source fails mid-mission.** Examples: Reddit returns 429, Product Hunt's token is wrong, a page times out. Expected: that source is recorded as a mission warning, the others continue, and the mission ends `done` with warnings, not `failed`. Pinned in Task 4.
2. **The model returns a quote that isn't in the fetched text** (a hallucinated quote). Expected: the entry is still stored, with `quoteVerified = false`, and is never used as a signal. Pinned in Task 4 (extract → verify) and Task 6 (retrieval excludes it).
3. **The same post is collected by two missions, or by two sources.** Expected: exact hash → no new entry; near-duplicate ≥ 0.90 of the same kind → merged. The voice upgrades only toward more independent. A rejected entry stays rejected. Pinned in Task 2.
4. **Background on, with the worker restarted many times a day.** Expected: at most one background mission queued or running at a time, and background spend never starts a new mission once the Toronto-day cap is reached. Pinned in Task 5.
5. **Hostile text in collected content.** Examples: an `<img onerror>` title, a prompt-injection line ("ignore previous instructions"), invisible characters. Expected: it renders as text on the Library page, is wrapped as untrusted in prompts, and invisible characters are stripped before storage. Pinned in Task 4 (wrapping, stripping) and Task 7 (rendering).

---

## File Structure

```
packages/core/
  src/db/schema.ts                         # + knowledge_items, knowledge_sources, research_missions; signals.knowledge_item_id; llm_calls/data_calls.mission_id
  drizzle/0009_research_library.sql
  src/library/kinds.ts                     # KNOWLEDGE_KINDS, SLICE_A_KINDS, per-kind facts zod schemas (web-safe)
  src/library/store.ts                     # upsert/merge, reject/restore, search, coverage, retrieve (web-safe; vectors passed in)
  src/research/robots.ts                   # robots.txt allow check with cache
  src/research/sources/{reddit,producthunt,appreviews,yc}.ts   # new collectors (RawItem-style)
  src/research/privacy.ts                  # username/handle stripping, quote cap
  src/research/mission.ts                  # runMission(deps, missionId)
  src/research/topics.ts                   # BACKGROUND_TOPICS (~40)
  src/dashboard/missions.ts                # queue/list/estimate/settings/background scheduler (web-safe)
  src/llm/types.ts, router.ts              # CallCtx.missionId → logged
  src/config/models.ts                     # + 'research', 'library_extract' stages
  src/pipeline/harvest.ts                  # + library source
  src/worker.ts, cli.ts, cli-program.ts    # claim missions; gen research …
apps/web/
  app/(app)/library/page.tsx, components/library-*.tsx, actions/library.ts
  components/settings-view.tsx (+ research settings form), lib/settings-labels.ts
  components/nav.tsx, lib/glossary.ts, lib/tour/chapters.ts
.env.example, README.md, docs/{user-guide,architecture,glossary,dashboard,CONTEXT,OWNER-TODO}.md
```

---

### Task 1: Schema, kinds and mission-attributed spend

**Files:**
- Modify: `packages/core/src/db/schema.ts`; generate `0009`
- Create: `packages/core/src/library/kinds.ts`
- Modify: `packages/core/src/llm/types.ts` and `router.ts` (`CallCtx.missionId?: string | null`, logged to `llm_calls.mission_id`). Wherever `data_calls` rows are written, accept and store `missionId`.
- Modify: `packages/core/src/config/models.ts`: `MODEL_STAGES` gains `'research'` and `'library_extract'`; `DEFAULT_MODELS.research = 'claude-sonnet-5-5'`, `DEFAULT_MODELS.library_extract = 'claude-haiku-5-5'`.
- Test: `packages/core/test/library/kinds.test.ts`, extend the router and schema tests.

**Interfaces:**
- **Schema:**
  - **Enums:**
    - pgEnum `knowledge_kind` = `['problem', 'startup', 'pricing', 'trend', 'rule_change', 'market']`. All six now, to avoid an enum migration in Slice B.
    - `knowledge_status` = `['active', 'rejected']`
    - `mission_origin` = `['owner', 'background']`
  - **`knowledgeItems`** columns:
    - `id`, `kind`, `title`, `summary`, `quote` (nullable)
    - `quoteVerified` boolean, default false
    - `audience` text `'business' | 'consumer' | 'both'`
    - `countries` text[], `industries` text[]
    - `voice` (nullable, `SIGNAL_VOICES`)
    - `facts` jsonb
    - `embedding` vector(1536) (nullable until embedded)
    - `contentHash` (unique)
    - `status` (default `active`), `rejectReason` (nullable)
    - `missionId` (nullable FK)
    - `createdAt`, `updatedAt`
    - indexes: `(kind, status)` and `(updated_at)`
  - **`knowledgeSources`** columns:
    - `id`, `itemId` (FK)
    - `url`, `domain`, `sourceType` text
    - `publishedAt` (nullable), `fetchedAt`
    - `quote` (nullable), `quoteVerified` boolean
    - unique `(item_id, url)`; indexes `(source_type)` and `(domain)`
  - **`researchMissions`** columns:
    - `id`, `topic`, `kinds` text[], `countries` text[]
    - `audience` (nullable)
    - `budgetUsd` numeric, `costUsd` numeric default '0'
    - `origin`
    - `status` (`runStatus` enum: queued / running / succeeded / failed)
    - `itemsAdded` int default 0, `itemsMerged` int default 0
    - `warnings` jsonb `string[]` default `[]`
    - `error` (nullable)
    - `startedAt`, `finishedAt`, `createdAt`
    - index `(status, created_at)`
  - **New nullable columns:** `signals.knowledgeItemId` (FK), `llmCalls.missionId` (FK), `dataCalls.missionId` (FK).
- **`kinds.ts`:**
  - `KNOWLEDGE_KINDS`
  - `SLICE_A_KINDS = ['problem', 'startup', 'pricing'] as const`
  - `FactsSchemas: { problem; startup; pricing }` (zod):
    - `problem` = `{ persona: string; frequencyOrCost?: string; workaround?: string }`
    - `startup` = `{ name: string; whatItDoes: string; businessModel: string; outcome: 'active' | 'dead' | 'acquired' | 'public' | 'unknown'; why?: string; foundedYear?: number; endedYear?: number; funding?: string }`
    - `pricing` = `{ product: string; pricePoints: { amount: number; currency: string; unit: string }[]; buyer: string; complaints: string[] }`
  - `type KnowledgeDraft = { kind; title; summary; quote?: string; audience; countries: string[]; industries: string[]; voice?: SignalVoice; facts: unknown; source: { url; domain; sourceType; publishedAt?: Date; quote?: string; quoteVerified: boolean } }`
  - `parseFacts(kind, facts)` returns the parsed facts or throws a named error.

- [ ] **Step 1: Write the failing tests:**
  - Each facts schema accepts a valid sample and rejects missing fields.
  - The migration applies and `createTestDb()` works.
  - A router call with `{ missionId }` logs `llm_calls.mission_id`; the existing calls with `runId` still log as before.
  - `DEFAULT_MODELS` has both new stages.
- [ ] **Step 2: Run** `npm test -w packages/core -- library router models`. Expected: FAIL.
- [ ] **Step 3: Implement.** Generate the migration and confirm it only adds.
- [ ] **Step 4: Run** `npm test -w packages/core && npm test -w apps/web && npm run typecheck -w apps/web`. Expected: PASS (update the web fixtures for new non-null fields if needed).
- [ ] **Step 5: Commit** `feat(core): research library schema and mission-attributed spend`

### Task 2: Library store: upsert and merge, reject and restore, search, coverage, retrieval

**Files:**
- Create: `packages/core/src/library/store.ts`
- Test: `packages/core/test/library/store.test.ts`

**Interfaces:**
- Consumes: Task 1 tables, `KnowledgeDraft`, `parseFacts`.
- Produces:
  - `contentHash(d: KnowledgeDraft): string`: sha256 of the kind, the normalised title, and the quote or summary.
  - `upsertKnowledgeItem(db, d: KnowledgeDraft, embedding: number[], ctx: { missionId?: string }): Promise<{ outcome: 'added' | 'merged' | 'duplicate'; itemId: string }>`. In one transaction:
    1. Exact hash match → add the source if new; outcome `duplicate`.
    2. Otherwise, a same-kind entry with cosine ≥ `MERGE_SIMILARITY = 0.90` → add the source, bump `updatedAt`, set voice to the most independent of (existing, new) using the order operator > neutral > vendor; outcome `merged`. The existing title, summary, quote and facts are kept. If the existing entry has no verified quote and the new one does, adopt the new quote and set `quoteVerified`.
    3. Otherwise insert the entry plus its source; outcome `added`.

    Rejected entries can be merge targets and stay rejected.
  - `rejectItem(db, id, reason?)` and `restoreItem(db, id)`: `Promise<boolean>`.
  - `searchLibrary(db, f: { text?: string; queryVector?: number[]; kinds?; audience?; country?; industry?; voice?; sourceType?; maxAgeDays?; status?: 'active' | 'rejected' | 'all'; page?: number }): Promise<{ rows: LibraryRow[]; total: number }>`. Page size 50. Text uses ILIKE on the title and summary. When `queryVector` is given, rows are ordered by similarity, otherwise by `updatedAt` desc.
  - `type LibraryRow = { id; kind; title; summary; quote; quoteVerified; audience; countries; industries; voice; status; sourceCount: number; newestSourceAt: Date | null; updatedAt }`
  - `getLibraryItem(db, id): Promise<(LibraryRow & { facts: unknown; sources: SourceRow[] }) | null>`
  - `libraryCoverage(db): Promise<{ byKind: Record<string, number>; bySourceType: Record<string, number>; byVoice: Record<string, number>; problemIndependentShare: number | null; verifiedQuoteShare: number | null; countries: string[]; industries: string[]; newest: Date | null; oldest: Date | null }>`. Counts active entries only, and lists at most 100 countries and industries.
  - `retrieveForRun(db, queryVector: number[], opts: { limit: number; kinds?: ('problem' | 'pricing')[]; countries?: string[] }): Promise<LibraryRow[]>`. It returns active entries of kind problem or pricing with `quoteVerified = true`, and enforces `limit ≤ 30`. The rank is similarity, plus a +0.05 bonus for operator or neutral voice, minus 0.05 for each year of age beyond 2. Variety: at most 3 entries per domain.

- [ ] **Step 1: Write the failing tests** (PGlite with `unit(i)` vectors):
  - added → duplicate (same hash) → merged (similarity 0.95 and same kind);
  - a different kind is not merged;
  - voice vendor + operator → operator, and operator + vendor stays operator;
  - a verified quote is adopted on merge;
  - merging into a rejected entry keeps it rejected;
  - reject and restore;
  - search filters and paging (51 rows → 50 + total);
  - coverage counts;
  - retrieval excludes unverified, rejected and startup entries, applies the voice bonus and age penalty, caps at 3 per domain, and enforces limit ≤ 30.
- [ ] **Step 2: Run** `npm test -w packages/core -- store`. Expected: FAIL.
- [ ] **Step 3: Implement.** The module is web-safe.
- [ ] **Step 4: Run** `npm test -w packages/core`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): library store with merge, search, coverage and retrieval`

### Task 3: New collectors, robots.txt and privacy

**Files:**
- Create:
  - `packages/core/src/research/robots.ts`
  - `packages/core/src/research/privacy.ts`
  - `packages/core/src/research/sources/{reddit,producthunt,appreviews,yc}.ts`
- Check first: `packages/core/src/tools/sources/appstore.ts`. If it already reads reviews, reuse it and don't duplicate.
- Test: `packages/core/test/research/{robots,privacy,sources}.test.ts`, with fetch mocked through the existing helpers' injection points.

**Interfaces:**
- **`robots.ts`:** `robotsAllows(url: string, opts?: { fetch?: typeof fetch; userAgent?: string; now?: () => number }): Promise<boolean>`.
  - Parses `User-agent: *` and the PitchLab UA groups, plus `Disallow`/`Allow` with longest match.
  - Caches per origin for 24 h.
  - A robots.txt that is unreachable or returns 404 allows the fetch. A 5xx or timeout disallows it (fail closed).
- **`privacy.ts`:**
  - `scrubPersonal(s: string): string` removes `u/name`, `/u/name`, `@handle`, "posted by …", email addresses and profile URLs.
  - `capQuote(s: string): string` caps at 500 characters on a word boundary.
- **Collectors** each return `RawItem[]` (`tools/sources/types.ts`) plus `sourceType`, and never return author fields:
  - **`reddit.ts`:** `redditSearch(q: string, opts: { clientId?: string; clientSecret?: string; limit?: number; fetch? }): Promise<RawItem[]>`.
    - App-only OAuth (`grant_type=client_credentials`); the token is cached until it expires.
    - Search across Reddit; posts plus their top comments.
    - Without keys it returns `[]` and logs once.
    - 429 is a `SourceError('rate_limited')`.
  - **`producthunt.ts`:** `productHuntSearch(topic: string, opts: { token?: string; limit?: number; fetch? }): Promise<ProductHuntItem[]>`.
    - Uses the GraphQL `posts` query by topic or keyword.
    - `ProductHuntItem = { name; tagline; url; launchedAt; votes; pricingHint?: string }`.
    - Without a token it returns `[]`.
  - **`appreviews.ts`:** `appReviews(appIdOrQuery: string, opts: { country?: string; limit?: number; fetch? }): Promise<RawItem[]>`. Apple's customer-review RSS JSON, no key.
  - **`yc.ts`:** `ycCompanies(filter: { query?: string; industries?: string[]; limit?: number }, opts: { fetch? }): Promise<YcCompany[]>`.
    - Source: the yc-oss public dataset JSON, cached per process.
    - `YcCompany = { name; oneLiner; url; status: 'Active' | 'Inactive' | 'Acquired' | 'Public'; batch; industries: string[]; regions: string[] }`.
  - **Mappers (pure):** `ycToDraft(c): KnowledgeDraft` (kind startup; outcome mapped Active→active, Inactive→dead, Acquired→acquired, Public→public) and `productHuntToDraft(p): KnowledgeDraft` (kind startup, outcome active). Neither makes a model call.
  - **Rate limits:** each collector waits at least `MIN_INTERVAL_MS` between requests to the same host (Reddit 1000, Product Hunt 1000, Apple 500, yc-oss once per process).

- [ ] **Step 1: Write the failing tests** for the robots parsing cases (disallow, allow override, cache, 404 allows, 5xx disallows) and the privacy patterns. Then, for each collector with mocked responses: maps fields, returns no author fields, returns `[]` without keys, raises the rate-limit error on 429, makes no network call when keys are missing. Then the mappers' outcome mapping.
- [ ] **Step 2: Run** `npm test -w packages/core -- research`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -w packages/core`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): research collectors with robots.txt, rate limits and privacy scrub`

### Task 4: Mission engine

**Files:**
- Create: `packages/core/src/research/mission.ts`
- Test: `packages/core/test/research/mission.test.ts`, with a mocked router (`structured`, `research`, `embed`), mocked collectors and a mocked `fetchPage`.

**Interfaces:**
- Consumes: Tasks 1–3; `fetchPage`; `normalize` from `pipeline/verify.ts`; `wrapUntrusted`, `capField` and `stripInvisible`; `isBannedSource`.
- Produces:
  - `type MissionDeps = { db; router: ModelRouter; fetchPage: typeof fetchPage; collectors: Collectors; log: (m: string) => void; now?: () => Date }`
  - `type Collectors = { reddit?; productHunt?; appReviews?; yc?; hn?; stackexchange?; github? }`, all injectable.
  - `runMission(deps: MissionDeps, missionId: string): Promise<'succeeded' | 'failed'>`
- **Steps:**
  1. **Plan:** `router.structured('research', …)` returns `{ queries: { source: 'web' | 'reddit' | 'hn' | 'stackexchange' | 'github' | 'appreviews' | 'producthunt' | 'yc'; q: string }[] }` (at most 12), restricted to the mission's kinds.
  2. **Collect:**
     - **API sources:** collectors per query.
     - **Web:** `router.research('research', { maxSearches: 3 })`, then fetch each cited URL through `robotsAllows` and `fetchPage`, skipping banned domains.
     - **Structured sources (yc, producthunt):** map straight to drafts through the Task 3 mappers.
  3. **Extract:** batches of up to 8 source texts per `router.structured('library_extract', …)`.
     - The prompt holds the mission's kinds and countries, with each text in `wrapUntrusted('source', capField(stripInvisible(text), 6000))`.
     - It returns drafts that follow `FactsSchemas` for each kind. Invalid drafts are dropped and counted in the warnings.
  4. **Verify:** `quoteVerified = normalize(text).includes(normalize(quote))` against that draft's own source text. Then `scrubPersonal`, then `capQuote`, applied to the quote, summary and title.
  5. **Embed:** `router.embed` on the title and summary, in one batch.
  6. **Store:** `upsertKnowledgeItem` for each draft. The mission's counters are updated.
- **Budget:**
  - Before each step and each batch, the mission's spend is the sum of `llm_calls` plus `data_calls` with `mission_id = id`.
  - When spend ≥ `budgetUsd`, remaining steps are skipped and a warning is added: "Budget reached; stopped early."
  - The finished mission records `costUsd`.
- **Failures:**
  - A collector or page failure is a warning (`"<source>: <short reason>"`, at most 20 warnings) and the mission continues.
  - A plan-step failure, or no drafts at all because every source failed, ends as `failed` with the scrubbed error.
  - Every `CallCtx` carries `{ runId: null, missionId }`.

- [ ] **Step 1: Write the failing tests:**
  - **Happy path:** plan → collect from 2 sources plus web → extract → verify → embed → store. Counters are right, `costUsd` is recorded, and the mission is `succeeded`.
  - **Hallucinated quote:** a quote not in the text is stored with `quoteVerified = false`.
  - **robots.txt:** a disallowed page is never fetched and becomes a warning.
  - **Banned domains** are skipped.
  - **Rate limits:** a Reddit 429 becomes a warning and the other sources continue.
  - **Budget:** reached after the plan step (seed `llm_calls` with mission spend), so it stops early and `succeeded` carries the warning.
  - **Privacy:** a quote with `u/someone` is stored without it.
  - **Untrusted text:** an injection line in the source appears only inside the untrusted wrapper in the prompt the router received.
  - **Structured sources:** YC and Product Hunt map with no `library_extract` call for them.
  - **Re-running** a mission doesn't duplicate entries (they come back as duplicate or merged).
- [ ] **Step 2: Run** `npm test -w packages/core -- mission`. Expected: FAIL.
- [ ] **Step 3: Implement.** Write the prompts in the same style as `harvest-research.v5`: prefer owner communities and neutral bodies, tag the voice, use English-language sources only.
- [ ] **Step 4: Run** `npm test -w packages/core`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): research mission engine`

### Task 5: Mission queue, settings, background scheduler, worker and CLI

**Files:**
- Create:
  - `packages/core/src/dashboard/missions.ts` (web-safe)
  - `packages/core/src/research/topics.ts`
- Modify:
  - `packages/core/src/worker.ts`: `claimNextMission`, and `WorkerOptions.executeMission`. The order is runs → validation jobs → missions → (if background is on) `maybeQueueBackgroundMission`.
  - `packages/core/src/cli.ts` and `cli-program.ts`: `gen research <topic> [--kinds problem,pricing] [--countries CA,US] [--audience business|consumer|both] [--budget 2]` queues a mission and prints its id and "up to $X". `gen research status` lists the last 10 missions.
- Test: `packages/core/test/dashboard/missions.test.ts`, extend `worker.test.ts` and `cli-program.test.ts`.

**Interfaces:**
- **Inputs and limits:**
  - `MissionInputSchema = z.object({ topic: z.string().trim().min(3).max(200), kinds: z.array(z.enum(SLICE_A_KINDS)).min(1).max(3).default(['problem', 'pricing', 'startup']), countries: z.array(z.string().regex(/^([A-Z]{2}|global)$/)).max(10).default([]), audience: z.enum(['business', 'consumer', 'both']).optional(), budgetUsd: z.number().min(0.5).max(10).default(2) })`
  - `MAX_QUEUED_MISSIONS = 3`, `BACKGROUND_BUDGET_USD = 1`
  - `RESEARCH_KEYS = { background: 'research.background', dailyCapUsd: 'research.dailyCapUsd' }`
- **Functions:**
  - `queueMission(db, input, origin: 'owner' | 'background' = 'owner'): Promise<{ ok: true; id } | { ok: false; reason: 'too_many_queued' }>`, serialised with its own advisory lock key.
  - `listMissions(db, limit = 20)`
  - `typicalMissionCost(db): Promise<number | null>`: the mean `costUsd` of the last 10 succeeded missions.
  - `getResearchSettings(db): Promise<{ background: boolean; dailyCapUsd: number }>` (defaults false and 5) and `saveResearchSettings(db, s)`. The cap is validated to 0–50.
  - `backgroundSpendToday(db, now)`: mission spend for background missions created since `torontoDayStart(now)` (reuse it from `dashboard/command.ts`).
  - `maybeQueueBackgroundMission(db, now): Promise<'queued' | 'off' | 'cap_reached' | 'busy'>`. It returns `busy` when any background mission is queued or running. Otherwise it picks the next topic, rotating through `BACKGROUND_TOPICS` from a stored index in setting `research.topicIndex`. Every 4th pick is instead a "gap" topic built from the least-covered industry or country in `libraryCoverage`.
- **Topics:** `BACKGROUND_TOPICS: readonly { topic: string; audience: 'business' | 'consumer' | 'both'; countries: string[] }[]`, with 40 entries. They span:
  - consumers: personal finance, health, parenting, creators, gig work, housing, education;
  - small and mid businesses across many industries;
  - emerging markets and regions: Africa, South Asia, Latin America, Southeast Asia, Europe;
  - new tech: AI agents, climate, ageing population.
- **`claimNextMission(db)`** uses the SKIP LOCKED pattern. The CLI's `executeMission` builds `MissionDeps` with the real router, collectors (keys from env) and `fetchPage`, then calls `runMission`.
- **Env:** `loadEnv` gains optional `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` and `PRODUCTHUNT_TOKEN`. `workerStatus.providers` gains `reddit` and `producthunt` booleans.

- [ ] **Step 1: Write the failing tests:**
  - **Schema:** budget bounds, topic length, kinds outside Slice A rejected.
  - **Queue:** queue → claim → only one claim when two workers race; a 4th queued mission → `too_many_queued`.
  - **Settings:** defaults are `{ background: false, dailyCapUsd: 5 }`.
  - **Background:**
    - with background off → `off`;
    - on but over the cap (seed mission spend today) → `cap_reached`;
    - on with one background queued → `busy`;
    - otherwise → `queued`, and the topic index advances;
    - a gap topic on every 4th pick;
    - a day boundary in Toronto resets the cap.
  - **Worker order:** with a queued run, job and mission, the run executes first. The mission executes only when the others are empty.
  - **CLI:** parsing.
- [ ] **Step 2: Run** `npm test -w packages/core -- missions worker cli-program`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -w packages/core`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): mission queue, background research and gen research`

### Task 6: Harvest uses the library

**Files:**
- Modify: `packages/core/src/pipeline/harvest.ts`
- Test: extend `packages/core/test/pipeline/harvest.test.ts`

**Interfaces:**
- Consumes: `retrieveForRun` (Task 2) and `router.embed`.
- **Behaviour:**
  1. At the start of harvest, build a query text from the run's seed: the sector names, lens patterns, idea text, or "small business and consumer problems" for open seeds. Embed it, then call `retrieveForRun` with `kinds: ['problem', 'pricing']`, `countries` from the run's market, and a limit of `LIBRARY_SIGNAL_MAX = 15`.
  2. If the library holds at least `LIBRARY_MIN_ENTRIES = 50` relevant active verified entries, it supplies up to half of the run's signals. Otherwise it supplies everything it returned. Library signals come first, before the per-run harvest fills the rest.
  3. Each entry's sources (or its verified quote with its best source URL) are upserted as signals using the existing `(url, quote_hash)` upsert. The run's `market_id`, the entry's voice and `sourceType` are set, and `knowledge_item_id = entry.id`.
  4. The returned `signalIds` include them. Log `harvest: N signals (M from library)`.
  5. An empty library, or an embed failure, falls back to the current behaviour with a log line. Harvest never fails because of the library.

- [ ] **Step 1: Write the failing tests:**
  - with library entries seeded, harvest returns signal ids including library-linked rows with the right voice and `knowledge_item_id`;
  - unverified and rejected entries are never used;
  - the half-cap applies when 50 or more entries exist;
  - an empty library behaves exactly as before (the existing harvest tests stay green);
  - an embed error falls back;
  - re-running harvest doesn't duplicate signals.
- [ ] **Step 2: Run** `npm test -w packages/core -- harvest`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -w packages/core`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): harvest draws verified evidence from the library`

### Task 7: Library page, research settings, connections, help, tour and docs

**Files:**
- Create: `apps/web/app/(app)/library/page.tsx`, `apps/web/components/library-view.tsx`, `apps/web/components/library-item.tsx`, `apps/web/components/mission-form.tsx` (client), `apps/web/actions/library.ts`
- Modify:
  - `apps/web/components/nav.tsx`: Library tab after Board.
  - Settings: a research settings card with a "Background research" checkbox, a daily cap input and a save button through a new action.
  - Connections panel: Reddit and Product Hunt rows.
  - `apps/web/lib/glossary.ts` and `docs/glossary.md`: terms `library` and `researchMission`.
  - `apps/web/lib/tour/chapters.ts`: one step in chapter `generate`, before the queue form, on `/library` with target `library-missions`. Body: the library is where research builds up, and you can start a mission on any topic; the cost shows first.
  - `.env.example`: the three keys, with comments.
  - `README.md`, `docs/user-guide.md` (a "Build the research library" section), `docs/architecture.md` (library and research modules, tables, worker order, sources and their rules), `docs/dashboard.md`, `docs/CONTEXT.md`.
  - `docs/OWNER-TODO.md`: confirm the Reddit and Product Hunt items, and add:
    - "turn on Background research in Settings when ready";
    - "after a few missions, run a benchmark pass on the Progress page and compare real-need evidence with baseline-0".
  - The coverage card shows the library health targets next to their values: problem entries in operator or neutral voice ≥ 60%, and 10 or more countries.
- Test: `apps/web/test/actions/library.test.ts`, `apps/web/test/components/library-view.test.tsx`, plus the SPECS entries, tour, anchor, glossary and docs-links guards.

**Interfaces:**
- **Actions:**
  - `queueMissionAction(prev, fd)` parses the form with `MissionInputSchema`. The kinds are checkboxes and the countries are a comma list, uppercased.
    - Refusal: `too_many_queued` → "3 research missions are already waiting. Wait for the worker."
    - Invalid fields get named messages.
  - `rejectItemAction(fd)` (id uuid, reason ≤ 200) and `restoreItemAction(fd)`. Both redirect back to the same Library URL using `safeNext`.
  - `saveResearchSettingsAction(prev, fd)`.
- **Page** (server component, query-string filters via a zod-parsed `lib/library-query.ts`):
  - **Search box:** text only; semantic search is out of scope for the page in Slice A.
  - **Filter selects:** kind, audience, country, voice, source type, age, status.
  - **Results:** 50 per page with a pager. Each row shows a kind badge, title, summary, voice, countries, age, source count, and a "verified quote" or "unverified" badge.
  - **Entry detail:** `?item=<id>` expands the entry to show the quote, the sources (`ExternalLink`) and the facts rendered as a definition list, plus Reject or Restore.
  - **Coverage card.**
  - **Missions card** (`data-tour="library-missions"`):
    - the form with topic, kinds, countries, audience and budget, plus "up to $X" and "typical: $Y" when known;
    - the last 20 missions with status, items added and merged, cost, warnings (collapsible) and error;
    - background status: "Background research is off (turn it on in Settings)", or "on: $A of $B spent today".
  - `AutoRefresh` every 10 s while any mission is queued or running.
  - An empty library shows: "The library is empty. Start a research mission below."

- [ ] **Step 1: Write the failing tests:**
  - **Actions:** each one's auth (SPECS) and validation messages; the refusal copy; reject and restore change the status.
  - **View:** filters reflected in the query string; the rows and badges; a hostile title renders as text; detail with sources; the coverage numbers; the mission list with warnings; the background-off text; the empty-library text.
  - **Settings form:** saves and reflects the values.
  - **Guards:** connections show Reddit and Product Hunt; the tour, anchor, glossary and docs-links guards pass.
- [ ] **Step 2: Run** `npm test -w apps/web -- library settings`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -w apps/web && npm run typecheck -w apps/web`, then the build with dummy env and `check-bundle`. Expected: all pass, 0 bundle hits.
- [ ] **Step 5: Commit** `feat(web): library page, research missions and settings` and `docs: research library`

### Task 8: Whole-branch gates, merge, first live check (controller)

- [ ] **Step 1: Gates** (all exit 0). Then a fresh-copy check with `DATABASE_URL=pglite://.data/lib-check`:
  1. `npm run gen -- runs` (migrates);
  2. `npm run gen -- research "test topic" --budget 0.5` (queues);
  3. `npm run gen -- research status` (lists it).

  Delete the folder afterwards. Don't run the worker, so no model spend.
- [ ] **Step 2: Secret scan; fast-forward `main`.** Run `npm install` and `npm run gen -- runs` in the owner's checkout to migrate Supabase, push, and remove the worktree.
- [ ] **Step 3: Tell the owner how to start their first mission** (page or CLI), and that background research stays off until they turn it on. Update `docs/OWNER-TODO.md`.
