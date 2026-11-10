# Worth, Difficulty and Idea Engine v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. TDD per task (failing test first, capture RED). No live network or model calls in tests: mock the router, `collectPage`, embeddings and fetch. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace "12 full ideas, absolute scores" with this flow:
1. about 90 cheap sketches;
2. a diversity archive;
3. a swapped-pair Elo tournament judged by another model family and calibrated on the owner's Board;
4. evolution against comps;
5. expansion of the top 12.

Add a `trivial` gate check, company dossiers and a per-entry source assessment.

**Architecture:**
- **Four new resumable stages** between `harvest` and `ideate`: `sketch`, `archive`, `tournament` and `evolve` (evolve includes the final tournament).
  - Each one passes its input through unchanged for `engine: 'v1'` runs and owner-idea seeds.
  - From `ideate` on, the pipeline is unchanged, except that ideate v15 expands sketches.
  - The pure tournament engine (pairing, Elo) lives apart from the model calls.
- **The library** gains an `assessment` column, computed strength, and a worker job `dossiers` that deepens `startup` entries.

**Tech Stack:** existing (TypeScript, Drizzle with PGlite and Supabase, pgvector, Vitest, Next.js 16). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-10-worth-difficulty-engine-v2-design.md`. Binding; read it first.

**Branch:** `engine-v2` in the sibling worktree `Y:/CODING PROJECTS/Business_Case_Gen-engine`, with its own `npm install` and no `.env`.

## Global Constraints

- **Migration `0016` is additive.**
- **Old prompts are kept.** New prompts:
  - `sketch.v1`, `judge.v1`, `evolve.v1`, `ideate.v15`, `gate.v7`, `dossier.v1`, `library-extract.v4`, `library-assess.v1`, `judge-reason.v1`.
- **New model stages:**
  - `sketch`, default `claude-sonnet-5-5`;
  - `judge`, default `gpt-6-sol`, a different family from `ideate`.

  `judge` follows `gate` for overrides, and `sketch` follows `ideate`.
- **Thresholds** (exported constants):

  | Constant | Value |
  |---|---|
  | `SKETCH_DUPLICATE_SIM` | 0.85 |
  | `SKETCH_KILLED_SIM` | 0.75 |
  | `SKETCHES_PER_LENS` | 12–15 (long list 20) |
  | `AVOID_TITLES_MAX` | 60 |
  | `SKETCH_TEXT_MAX` | 600 chars |
  | `ELO_START` | 1200 |
  | `ELO_K` | 24 |
  | `SWISS_ROUNDS` | 5 |
  | `JUDGE_CALLS_MAX` | 300 per run |
  | `FINAL_ROUNDS` | 3 |
  | `FINAL_CALLS_MAX` | 120 |
  | `TOP_SKETCHES` | 12 |
  | `EVOLVE_TOP` | 6 |
  | `COMPS_PER_SKETCH` | 5 |
  | `MAX_PER_CELL` | 2 |
  | `MAX_PER_BUSINESS_MODEL` | 2 |
  | `FEWSHOT_PAIRS_MAX` | 6 |
  | `TRAIN_SHARE` | 0.6 |
- **Judge goals** (reported, never enforced): accuracy at least 0.70, position consistency at least 0.80.
- **Strength:** clamp 1–5, starting from 3:

  | Factor | Effect |
  |---|---|
  | voice operator or customer | +1 |
  | voice vendor | −1 |
  | quote verified | +1 |
  | corroborating domains, 2 or more | +1 |
  | corroborating domains, 5 or more | +2 (instead of +1) |
  | older than 730 days | −1 |
  | source type in `OFFICIAL_SOURCE_TYPES` (`federalregister`, `worldbank`, `yc`) | +1 |

  Corroboration means other active entries at cosine at least 0.9, from other registrable domains.
- **Budgets:**
  - sketch, tournament and evolve together at most $8 per run (logged);
  - `dossiers.dailyUsd` defaults to 2;
  - the backfills stop at $25 total (`--max-usd`, default 25).
- **The judge never sees test-split pairs.** Tournament pairing is seeded by run id, so a resume replays it.
- **Every new model call** goes through the router with `runId` (or a job id) and its prompt version.
- **No founder or person names** in dossiers. Company names are fine. Verified quotes as now.
- **Existing rulings bind:**
  - SSRF guard and pinning, banned and never-fetch hosts;
  - untrusted text wrapped;
  - privacy scrub;
  - bounded queries and bound parameters;
  - R13 and R20;
  - web-safe imports;
  - check-bundle.
- **Merge gates,** one after another with `set -o pipefail`:
  - `npm test -w packages/core -- --maxWorkers=2`, `npm test -w packages/capture`, `npm test -w apps/web -- --maxWorkers=2`;
  - `npx tsc --noEmit -p packages/core`, `npx tsc --noEmit -p packages/capture`, `npm run typecheck -w apps/web`;
  - the web build with dummy env, and `npm run check-bundle -w apps/web`;
  - the secret scan.
- **Never run `gen` or db commands without `DATABASE_URL=pglite://<temp under .data/>`.** Never touch the owner's checkout or Supabase.
- **Commits** end with the committing agent's `Co-Authored-By` trailer.

## Review Focus

1. **A run where the judge model errors or returns junk mid-tournament.** Expected: the match counts as a draw and is logged, and the tournament finishes on the remaining budget. If every call fails, the top 12 are chosen by diversity cell, in sketch order, with a warning, and the run does not fail. Pinned in Task 6.
2. **A run with fewer than 12 sketches left after the archive** (a narrow seed, or everything duplicates). Expected: the tournament ranks what is there, and evolve and ideate expand all of them. With 0 left, the run ends like an empty ideate (EMPTY_KEY `sketchIds`). Pinned in Tasks 5 and 8.
3. **A resumed run** (worker restart during the tournament). Expected: the same pairs, no double-counted Elo, already-judged matches not re-paid. Matches are stored per run, keyed by round and pair. Pinned in Task 6.
4. **Calibration with very few decided pairs** (under 10), or new Board decisions after a split. Expected: the report says "too few pairs" below 10, and existing pairs never change split. Pinned in Task 7.
5. **A dossier page that is a bot wall, a parked domain or an unrelated company with the same name.** Expected:
   - challenge and error pages are never content (existing rule);
   - a dossier whose fetched pages never name the company is discarded and recorded as `dossierStatus: 'unmatched'`;
   - the entry keeps its old facts.

   Pinned in Task 3.

---

### Task 1: Data model, config and stage scaffolding

**Files:**
- Modify:
  - `packages/core/src/db/schema.ts` and new migration `drizzle/0016_engine_v2.sql`;
  - `src/pipeline/types.ts` (`STAGES`, `RunConfig.engine`);
  - `src/pipeline/run.ts` (`DEFAULT_STAGE_IMPLS`, `EMPTY_KEY`);
  - `src/config/models.ts`;
  - `src/library/kinds.ts` (optional startup dossier fields);
  - the web stage list wherever `STAGES` is rendered.
- Create: `src/pipeline/engine/passthrough.ts`.
- Test: `test/db/migration-0016.test.ts`, `test/pipeline/run.test.ts` (extend), `test/config/models.test.ts` (extend), `test/library/kinds.test.ts` (extend).

**Interfaces:**
- **Produces:**
  - Table `sketches`:

    ```
    id, runId, lensId, title, buyer, problem, howItEarns, businessModel, edge, edgeKind, whyNotTrivial, earnOrSave,
    signalIds uuid[], libraryItemIds uuid[], embedding vector(1536), cell text, status ('kept'|'duplicate'|'near_killed'|'evolved'),
    elo real, parentSketchId, operator ('sharpen'|'combine'|'simplify'|null), createdAt
    ```
  - Table `tournament_matches`: `id, runId, phase ('main'|'final'), round, aId, bId, verdictAB ('a'|'b'|'draw'|'error'), verdictBA, result ('a'|'b'|'draw'), confidence, reasons jsonb, createdAt`, unique on `(runId, phase, round, aId, bId)`.
  - Table `judge_pairs`: `id, keptIdeaId, killedIdeaId, pairHash unique, split ('train'|'test'), reason text null, createdAt`.
  - Columns:
    - `ideas.sketch_id uuid null` and `ideas.elo real null`;
    - `knowledge_items.assessment jsonb null`.
  - `EDGE_KINDS = ['data','workflow','regulation','network','ai_capability','distribution','none'] as const`
  - `BUYER_KINDS = ['business','prosumer','consumer'] as const`
  - `STAGES = ['harvest','sketch','archive','tournament','evolve','ideate','dedupe','screen','gate','case','verify','score']`
  - `RunConfig.engine?: 'v1' | 'v2'`, and `usesEngineV2(cfg): boolean`, which is true unless `engine === 'v1'` or `seedType === 'idea'`.
  - `passthrough(input) => input` for v1 runs.
  - `EMPTY_KEY`: sketch, archive, tournament and evolve map to `'sketchIds'`.
  - `MODEL_STAGES` gains `'sketch'` and `'judge'`.
  - Startup facts gain the spec §8 optional fields, plus `dossierStatus?: 'done'|'unmatched'|'failed'`.

- [ ] **Step 1:** Write the failing tests:
  - migration `0016` adds the three tables and three columns and drops nothing (follow the existing additive-migration test pattern);
  - for a v1 config, each new stage's output deep-equals its input, and the run reaches `ideate` with the harvest output;
  - `usesEngineV2` cases: default, `'v1'`, and seedType `'idea'`;
  - `DEFAULT_MODELS.judge` family differs from `DEFAULT_MODELS.ideate`;
  - startup facts with and without the new fields both parse.
- [ ] **Step 2:** Run `npm test -w packages/core -- migration-0016 run models kinds`. Expected: FAIL.
- [ ] **Step 3:** Implement. Until Tasks 4–8 land, the v2 stage impls are the passthrough too; each later task replaces one.
- [ ] **Step 4:** Run the core suite (`--maxWorkers=2`), core tsc, the web suite and the web typecheck. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): engine v2 data model and stage scaffolding`.

### Task 2: Source assessment

**Files:**
- Create:
  - `src/library/assessment.ts`;
  - `prompts/library-assess.v1.md`, `prompts/library-extract.v4.md`;
  - `src/library/assess-job.ts`.
- Modify:
  - `src/research/mission.ts` (`extractDrafts` asks for `directness`, `bias` and `why`; `upsertKnowledgeItem` stores them);
  - `src/maintenance.ts` (recompute strength);
  - `src/library/context.ts` (render the badge);
  - `src/cli.ts` (`gen library assess [--max-usd N]`);
  - the web Library page (badge and why).
- Test: `test/library/assessment.test.ts`, `test/library/assess-job.test.ts`, extend `test/research/mission.test.ts`, `test/maintenance.test.ts`, `test/library/context.test.ts`, and the web library test.

**Interfaces:**
- **Produces:**
  - `type Directness = 'first_hand'|'customer_review'|'vendor'|'press'|'aggregate'|'official'|'unknown'`
  - `type Assessment = { directness: Directness; bias: string | null; strength: 1|2|3|4|5; why: string; corroboration: number }`
  - `computeStrength(i: { voice: string | null; quoteVerified: boolean; corroboration: number; fetchedAt: Date | null; sourceTypes: string[] }, now: Date): 1|2|3|4|5`
  - `countCorroboration(db, itemId): Promise<number>`: distinct registrable domains of other active entries at cosine at least 0.9. Bounded at 50 rows.
  - `refreshAssessments(db, now): Promise<{ updated: number }>`, called by maintenance.
  - `runAssessBackfill(deps: { db; router; log; maxUsd }): Promise<{ assessed: number; spentUsd: number }>`: batches of 20 entries with no `assessment.why`, cheap model stage `library_extract`, prompt `library-assess.v1`.
  - `strengthLabel(a: Assessment): string`, e.g. `"strength 4/5, first-hand"`. Used by ideation, judge and web.

- [ ] **Step 1:** Write the failing tests:
  - `computeStrength`, a table test with every factor from Global Constraints, including the clamp at 1 and 5;
  - `countCorroboration` ignores the same domain and rejected entries;
  - the backfill stops at `maxUsd` and skips entries already assessed;
  - the model's `directness` outside the enum becomes `'unknown'`;
  - maintenance updates strength without touching `why`;
  - the ideation context line includes `strengthLabel`;
  - the Library page shows the badge and why as text (R13: no HTML injection).
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. `library-extract.v4` = v3 plus the three assessment fields per draft. v3 is kept.
- [ ] **Step 4:** Run the core and web suites and both typechecks. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): source assessment with computed strength`.

### Task 3: Company dossiers

**Files:**
- Create: `src/library/dossier.ts`, `src/library/dossier-job.ts`, `prompts/dossier.v1.md`.
- Modify:
  - `src/worker.ts` (an `executeDossiers` hook, idle like feeds, yields to queued runs);
  - `src/cli.ts` (wire the hook; `gen dossiers run [--max-usd N] [--limit N]`);
  - Settings → Connections (dossiers last run);
  - the web library entry view (dossier fields).
- Test: `test/library/dossier.test.ts`, `test/library/dossier-job.test.ts`, extend `test/worker.test.ts` and the web library test.

**Interfaces:**
- **Consumes:** `collectPage` (existing), `upsertKnowledgeItem` (existing), the startup facts fields (Task 1).
- **Produces:**
  - `DOSSIERS_DAILY_USD_KEY = 'dossiers.dailyUsd'` (default 2).
  - `dossierQueue(db, limit): Promise<string[]>`, item ids in priority order:
    1. cited by a case or a kept idea;
    2. in `dossiers.priority` (a setting list, written by evolve);
    3. `businessModel` unknown;
    4. the rest.

    Only startups whose `dossierAt` is null or older than 180 days are included.
  - `buildDossier(item, deps: { collectPage; router; ctx }): Promise<{ status: 'done'|'unmatched'|'failed'; facts?: Partial<StartupFacts>; quotes: string[] }>`
    - **Pages:** homepage (from the entry's source url or a search), pricing (homepage link containing "pricing", else `/pricing`), one search for `"<name>" funding OR acquired OR "shut down"`, and a post-mortem search when the outcome is `dead`.
    - **Unmatched:** when no fetched page contains the company name (case-insensitive).
    - **Fields:** each field is kept only when its quote is verbatim in a fetched page.
    - **Names:** person names are stripped by the existing scrub.
  - `runDossierJob(deps): Promise<{ done; unmatched; failed; spentUsd }>`, stopping at the daily cap.

- [ ] **Step 1:** Write the failing tests:
  - queue priority order and the 180-day refresh;
  - an unmatched company leaves the facts unchanged and stores `dossierStatus: 'unmatched'`;
  - a field without a verbatim quote is dropped;
  - a founder name in the page never reaches the stored facts or summary;
  - a never-fetch host is never requested;
  - the daily cap stops the job;
  - the worker runs dossiers only when idle and after feeds;
  - the web view renders the fields as text.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the core and web suites and both typechecks. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): company dossiers for startup entries`.

### Task 4: Sketch stage

**Files:**
- Create: `src/pipeline/engine/sketch.ts`, `prompts/sketch.v1.md`.
- Modify: `src/pipeline/run.ts` (replace the passthrough).
- Test: `test/pipeline/engine/sketch.test.ts`.

**Interfaces:**
- **Consumes:**
  - the harvest output `{ signalIds, ... }`;
  - `selectLenses`, the library context and the `ideate.ts` helpers for sectors, segments and finds. Factor the shared seed-context builder out of `ideate.ts` into `src/pipeline/seed-context.ts` and reuse it; do not copy it.
- **Produces:**
  - `SketchSchema` (zod, web-safe, in `src/pipeline/engine/schema.ts`): the spec §2 fields plus `edgeKind: z.enum(EDGE_KINDS)`. Text fields together at most `SKETCH_TEXT_MAX`; `signalIds` at least 1.
  - `sketch(deps, run, input): Promise<{ sketchIds: string[]; signalIds: string[] }>`
    - one router call per lens (`'sketch'`, prompt `sketch.v1`);
    - inserts `sketches` rows with status `kept` and `cell` empty (the archive fills it);
    - drops sketches citing signal ids not in the harvest.
  - `avoidTitles(db, runId, queryVector): Promise<string[]>`: up to `AVOID_TITLES_MAX` nearest earlier idea and sketch titles from other runs, plus this run's titles so far.

- [ ] **Step 1:** Write the failing tests (mock the router):
  - one call per lens, and the prompt contains the avoid list and the "Do not repeat or rephrase these" line;
  - the prompt has the long-list-then-differentiate steps and the `whyNotTrivial` rule;
  - invalid sketches (no signals, unknown signal ids, too long) are dropped and counted;
  - a lens call failure skips that lens with a warning, and the stage still returns the others;
  - the output ids match the inserted rows.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the core suite and core tsc. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): sketch stage`.

### Task 5: Archive stage

**Files:**
- Create: `src/pipeline/engine/archive.ts`.
- Modify: `src/pipeline/run.ts`.
- Test: `test/pipeline/engine/archive.test.ts`.

**Interfaces:**
- **Produces:**
  - `buyerKind(buyer: string, lensAudience: string): BuyerKind`: lens audience `consumer` gives `consumer`; a buyer text matching freelancer, creator, solo, independent or "small team" gives `prosumer`; otherwise `business`.
  - `cellOf(s): string` = `${buyerKind}|${edgeKind}|${businessModel ?? 'none'}`
  - `archive(deps, run, input: { sketchIds }): Promise<{ sketchIds: string[]; signalIds: string[]; uniqueShare: number; cells: number }>`
    - embeds sketches (`'embed'`), and sets `duplicate` or `near_killed` by the thresholds in the order of spec §3;
    - stores `cell` and the embedding;
    - writes `uniqueShare` (kept over all) and `cells` (distinct kept cells) into the stage output.

- [ ] **Step 1:** Write the failing tests:
  - a sketch at cosine 0.86 to an earlier-run idea is `duplicate`, and at 0.84 is kept;
  - 0.76 to a gate-killed idea or an owner-killed case gives `near_killed`;
  - within-run twins keep the first;
  - the `buyerKind` and `cellOf` tables;
  - `uniqueShare` and `cells` are correct;
  - all duplicates give `sketchIds: []`, so the run ends quietly;
  - fewer than 12 kept passes them all on.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the core suite and core tsc. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): sketch archive with diversity cells`.

### Task 6: Tournament

**Files:**
- Create:
  - `src/pipeline/engine/elo.ts` (pure);
  - `src/pipeline/engine/judge.ts` (model calls);
  - `src/pipeline/engine/tournament.ts` (stage);
  - `prompts/judge.v1.md`.
- Modify: `src/pipeline/run.ts`.
- Test: `test/pipeline/engine/elo.test.ts`, `test/pipeline/engine/judge.test.ts`, `test/pipeline/engine/tournament.test.ts`.

**Interfaces:**
- **Consumes:**
  - `fewShotPairs(db): Promise<FewShot[]>` (Task 7). Until Task 7 lands, Task 6 defines it in `src/audit/judge-pairs.ts` returning `[]`, and Task 7 replaces the body.
  - `strengthLabel` (Task 2).
- **Produces:**
  - **`elo.ts`:**
    - `expected(ra, rb): number`
    - `update(ra, rb, result: 'a'|'b'|'draw', k = ELO_K): [number, number]`
    - `swissPairs(ratings: { id; elo; cell }[], round: number, played: Set<string>, rand: () => number): [string, string][]`
      - round 1 pairs across different cells where possible;
      - later rounds pair neighbours by Elo without rematches;
      - an odd sketch out gets a bye (no rating change).
    - `combine(ab, ba): 'a'|'b'|'draw'`: the BA verdict is mirrored; disagreement or `error` gives `draw`.
  - **`judge.ts`:** `judgePair(a: SketchView, b: SketchView, deps: { router; ctx; fewShot: FewShot[] }): Promise<{ verdict: 'a'|'b'|'error'; confidence: 1|2|3; reasons: Record<Criterion, string> }>`
    - `Criterion = 'need'|'nonTrivial'|'earn'|'edge'|'evidence'`;
    - router stage `'judge'`, prompt `judge.v1`;
    - a thrown or invalid response gives `{ verdict: 'error' }`.
  - **`tournament.ts`:** `runTournament(deps, run, o: { phase: 'main'|'final'; sketchIds; rounds; maxCalls }): Promise<Map<string, number>>`
    - persists each match to `tournament_matches` before updating Elo;
    - on resume, replays stored matches instead of calling;
    - stops at `maxCalls`;
    - writes `sketches.elo`.
  - **`topByElo(rows, n = TOP_SKETCHES): string[]`**, with `MAX_PER_CELL` and `MAX_PER_BUSINESS_MODEL`; ties are broken by sketch `createdAt`.
  - **Stage:** `tournament(deps, run, input): Promise<{ sketchIds /* top 12 */; signalIds; matches: number; spentUsd: number }>`

- [ ] **Step 1:** Write the failing tests:
  - Elo math: equal ratings with a win give 1212 and 1188 at K 24; a draw between equal ratings changes nothing;
  - `combine` truth table;
  - Swiss: no rematch over 5 rounds of 20, round 1 crosses cells, the bye works, and it is deterministic for the same seed;
  - every pair is judged twice with the order swapped (assert the router call order: A first, then B first);
  - an `error` verdict gives a draw and a log line;
  - all calls failing still returns 12 by cell order with a warning;
  - the budget stop at `maxCalls`;
  - resume: a second run of the stage with stored matches makes 0 router calls and gives the same Elo;
  - the caps in `topByElo`;
  - the judge prompt includes few-shot pairs when given and the strength labels of cited signals.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Seed with `seededRandom(run.id + phase)` (existing in `ideate.ts`; move it to a shared util).
- [ ] **Step 4:** Run the core suite and core tsc. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): swapped-pair Elo tournament judge`.

### Task 7: Judge calibration

**Files:**
- Create: `src/audit/judge-pairs.ts`, `src/audit/judge-calibration.ts`, `prompts/judge-reason.v1.md`.
- Modify: `src/cli.ts` (`gen audit judge [--limit N]`).
- Test: `test/audit/judge-pairs.test.ts`, `test/audit/judge-calibration.test.ts`.

**Interfaces:**
- **Produces:**
  - `syncJudgePairs(db): Promise<{ added: number }>`:
    - every (kept, killed) pair of decided cases' ideas (kept = `validating|pilot|live`), plus pairs of owner-rated ideas (rating > 0 against rating < 0);
    - `pairHash = sha256(sorted ids)`;
    - `split = 'train'` when the first byte of the hash over 255 is below `TRAIN_SHARE`, else `'test'`;
    - insert only (existing rows never change).
  - `fewShotPairs(db, n = FEWSHOT_PAIRS_MAX): Promise<FewShot[]>`:
    - **train only**;
    - fills a missing `reason` once, through `judge-reason.v1` from the owner's tags and notes, and stores it;
    - `FewShot = { kept: SketchView; killed: SketchView; reason: string }`.
  - `calibrateJudge(deps): Promise<JudgeReport>`, with
    `JudgeReport = { pairs; accuracy; consistency; byConfidence: Record<1|2|3,{ n; accuracy }>; reviewerAccuracy; spentUsd; tooFew: boolean }`
    - test pairs only;
    - each judged twice with the order swapped;
    - accuracy counts the kept idea winning the combined result;
    - consistency is the share of pairs where both orders agree;
    - `reviewerAccuracy` uses the stored reviewer scores (sum of reviewer dimensions) as the pairwise prediction;
    - `tooFew` is true under 10 pairs.
  - `renderJudgeReport(r, date): string`, written to `output/audit/judge-<date>.md`.

- [ ] **Step 1:** Write the failing tests:
  - the split is stable (rerunning `syncJudgePairs` changes nothing, and new pairs keep their hash-based split);
  - `fewShotPairs` never returns a test pair (fixture with both splits);
  - the accuracy and consistency arithmetic on a mocked judge;
  - `tooFew` under 10;
  - the report has the 0.70 and 0.80 goal lines with pass or fail;
  - the CLI writes the file and prints the path.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the core suite and core tsc. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): judge calibration against the owner's Board`.

### Task 8: Evolve stage

**Files:**
- Create: `src/pipeline/engine/evolve.ts`, `prompts/evolve.v1.md`.
- Modify: `src/pipeline/run.ts`.
- Test: `test/pipeline/engine/evolve.test.ts`.

**Interfaces:**
- **Consumes:** `runTournament` and `topByElo` (Task 6); startup entries with dossiers (Task 3).
- **Produces:**
  - `nearestComps(db, vec, n = COMPS_PER_SKETCH)`:
    - active `startup` entries, ordered by cosine;
    - entries with `dossierStatus = 'done'` first;
    - plus their `pricing` entries matched by product name.
  - `evolve(deps, run, input: { sketchIds }): Promise<{ sketchIds: string[] /* final top 12 */; signalIds; variants: number }>`
    1. For the top `EVOLVE_TOP`, run one router call each (`'ideate'`, `evolve.v1`) with the sketch, its comps and the other top-12 titles. It returns one variant with `operator`.
    2. The variant's `signalIds` must be a superset of the parent's, drawn from the harvest; otherwise it is discarded.
    3. Insert variants with `parentSketchId`, embed them, and assign their cells.
    4. Append the parents' comp startup ids to setting `dossiers.priority` (at most 50, deduplicated).
    5. Run `runTournament` phase `'final'` over parents plus variants (`FINAL_ROUNDS`, `FINAL_CALLS_MAX`), starting from their current Elo; variants start at their parent's Elo.
    6. Return `topByElo`.

- [ ] **Step 1:** Write the failing tests:
  - a variant that drops a parent signal is discarded;
  - lineage and operator are stored;
  - comps prefer dossier entries;
  - the priority setting is appended and capped at 50;
  - the final tournament uses phase `'final'`, and variants start at their parent's Elo;
  - with fewer than 6 sketches, all are evolved;
  - an evolve call failure keeps the parent alone.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the core suite and core tsc. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): evolve top sketches against comps`.

### Task 9: Ideate v15, screen band and gate v7

**Files:**
- Create: `prompts/ideate.v15.md`, `prompts/gate.v7.md`.
- Modify: `src/pipeline/ideate.ts` (v2 path), `src/pipeline/screen.ts`, `src/pipeline/gate.ts`.
- Test: extend `test/pipeline/ideate.test.ts`, `test/pipeline/screen.test.ts`, `test/pipeline/gate.test.ts`.

**Interfaces:**
- **Consumes:** the final `sketchIds` (Task 8), `nearestComps` (Task 8).
- **Produces:**
  - **ideate, v2 runs:**
    - expands the given sketches, `IDEAS_PER_CALL` per call, through `ideate.v15` (v14 rules plus "expand these sketches; keep their buyer, problem, edge and whyNotTrivial; do not invent new ideas");
    - stores `ideas.sketch_id` and copies `elo`;
    - the input is the evolve output; `signalIds` are the harvest's.
    - v1 runs are unchanged (v14).
  - **screen:** `eloBand(elo, allElos): 0|1|2`: top quartile 2, second quartile 1, else 0. Added to the generated idea's total. Null Elo (v1) gives 0.
  - **gate:**
    - `CHECKS` gains `'trivial'` (model, `gate.v7`);
    - `ORDER` gains `'comps'` (code, advisory, never kills): the verdict text lists up to 5 comps with `whoPays` and outcome, or "no comps found" or "only dead comps";
    - `trivial` kills generated ideas only (owner ideas are advisory, like `scale`).

- [ ] **Step 1:** Write the failing tests:
  - a v2 run calls `ideate.v15` with the sketch fields, and the ideas carry `sketch_id` and `elo`;
  - a v1 run still uses v14;
  - the `eloBand` quartiles and the effect on screen order;
  - the gate schema requires `trivial` exactly once;
  - a trivial fail kills a generated idea and is advisory for an owner idea;
  - the comps verdict text for each of its three cases;
  - comps never kill.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the core suite and core tsc. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): ideate v15 expands sketches; screen Elo band; gate v7 trivial and comps`.

### Task 10: Web, benchmark report and docs

**Files:**
- Modify:
  - the web run page (a tournament section: top 12 with Elo, cell, parent and variant links, dropped duplicates count, unique share and cells);
  - the case page (comps verdict);
  - `src/bench/definitions.ts` and `src/bench/scorecard.ts` (new rows: `uniqueSketchShare`, target ≥ 0.6; `cellsFilled`, ≥ 8; `judgeAccuracy`, latest calibration ≥ 0.70; `trivialKillRate`, reported; `compsCoverage`, ≥ 0.8 of cases with 2 or more dossier comps; `engineCostPerRun`, ≤ $8);
  - the glossary (`docs/glossary.md` and `apps/web/lib/glossary.ts`: Sketch, Tournament, Elo, Diversity cell, Dossier, Source strength, Trivial);
  - README, `docs/architecture.md`, `docs/user-guide.md`, `docs/CONTEXT.md`, `docs/OWNER-TODO.md`.
- Test: the web run page and case page tests, the bench scorecard tests, the glossary sync and docs-link guards.

**Interfaces:**
- **Consumes:** the stage outputs of Tasks 5–8 and the gate `comps` verdict.

- [ ] **Step 1:** Write the failing tests:
  - the run page renders the tournament rows as text, and has no tournament section for v1 runs;
  - the scorecard rows compute on fixtures, with "no data" for v1 passes;
  - the glossary is in sync.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement, and write the docs.
- [ ] **Step 4:** Run all merge gates. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): tournament and comps views; benchmark rows; docs`.

### Task 11: Merge and switch on (controller)

- [ ] Final whole-branch review (opus), then the fix wave, gates, and the secret scan.
- [ ] Rebase onto main and fast-forward. Run `npm install` and `npm run gen -- runs` (migrates `0016`). Push. Remove the worktree and the branch.
- [ ] In the owner's checkout:
  - `gen library assess --max-usd 5`;
  - `gen dossiers run --max-usd 15` (startups cited by cases first);
  - `gen audit judge`.

  Record the costs and the judge report in the quality log.
- [ ] Queue bench-v3 #3 (`gen bench run`) after bench-v3 #2 has finished and the owner has sorted its Board. Then report.
