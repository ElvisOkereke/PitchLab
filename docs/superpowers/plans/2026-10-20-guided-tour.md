# Guided Tour, In-App Help and Repo Docs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. TDD per task (failing test first, capture RED). No live LLM calls and no real network in tests. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A first-time user (possibly a stranger) can go from an empty install to a scored, validated case with outreach logged and a stage decision, guided by an interactive in-app tour, without opening a terminal except to start the worker. The repo explains what the app is and how it works.

**Architecture:**
- **Core** (`packages/core`) gains:
  - an `is_example` flag on `runs` and `cases`, plus a fixture example case inserted by a separate `ensureExample` step (not `seedDefaults`, which test DBs use);
  - a `validation_jobs` queue the worker drains after runs;
  - a `tour.state` setting.
- **Web** (`apps/web`) gains:
  - a driver.js tour driven by a pure step machine and static chapter definitions that target `data-tour` anchors;
  - a "Generate validation pack" form;
  - example-case badges and controls;
  - `<details>`-based help tips fed by one glossary module.
- **Docs:** a README, a user guide, an architecture doc and a glossary.

**Tech Stack:** existing (Next.js 16.3, React 19.2, Drizzle, PGlite/pg, Vitest, Testing Library, jsdom) plus `driver.js@1.9.0` (MIT, no deps, published 2026-10-03), pinned exactly in `apps/web/package.json`.

**Spec:** `docs/superpowers/specs/2026-10-20-guided-tour-design.md`. Context: `docs/CONTEXT.md`, `docs/dashboard.md`.

**Branch:** `guided-tour`, cut from `main`. The new migration is `0007` (generated with `npx drizzle-kit generate --name example_validation_jobs`, run in `packages/core`).

## Global Constraints

- All earlier rulings bind:
  - **R13:** escape all case/LLM/web text; no `dangerouslySetInnerHTML`, no HTML strings.
  - **R20:** re-runnable writes are idempotent; multi-row writes go in one transaction.
- **Web-safe core imports:** every new core module the web imports must pass `apps/web/test/core-imports.test.ts`, which means no env loader, PGlite, router, SDKs, `db/client`, `validation/outreach` or `validation/emails`. `npm run check-bundle -w apps/web` stays green.
- **Server Actions:**
  - Every new one calls `requireOwnerAction()` first and validates input with zod.
  - Messages name fields and never echo values.
  - `apps/web/test/actions/all-actions-require-session.test.ts` must cover each new export (it iterates every export, so adding the file is enough; check that it does).
- **driver.js text:** driver.js writes popover `title`/`description` with `innerHTML`, so they come only from string literals in `apps/web/lib/tour/chapters.ts`. Never pass case, prospect, LLM or user text to driver.js.
- **Example data:** only reserved domains (`example.com`, `example.org`, `example.net`, `*.example`), obviously fictional names, no `llm_calls`/`data_calls` rows. Generating validation on the example is refused.
- **Money:** nothing spends money without the user pressing the real "Queue run" or "Generate validation pack" button. The tour never submits forms. Copy shows "about $3–7 per run" and "about $0.60–1.50 per validation pack" (prospect search ≈ $0.45–0.60 of that, avoidable with "Skip new prospect search").
- **Layout:** no JS needed for forms or help tips (the tour may need JS). It works at 375px with no sideways scroll, tap targets ≥ 44px, in light and dark (CSS variables in `globals.css`).
- **Copy:** plain, second person, short. No internal jargon (no "R13", "gate.v2", "SDD"). The product name is **PitchLab**.
- **Merge gates:**
  - `npm test -w packages/core`, `npm test -w apps/web`, `npm run typecheck -w apps/web` and `npm run build -w apps/web` (with dummy env) must pass, plus `npm run check-bundle -w apps/web` after the build.
  - Chain them with `set -o pipefail`, without piping test output through tail/head.
  - Secret scan of history: 0 token hits, and no tracked `.env`, `.data`, `output`, `.next`, `.crt` or `.pem`.
- Commits end with the committing agent's `Co-Authored-By` trailer. Use Edit/Write tools for code.

## Review Focus

1. **A tour step whose target is missing.** Examples: a phone shows one board column, there are no prospects, or the user is on another page. The machine must fall back to a centred popover or a "Take me there" route, never hang or throw. Pinned in Task 7 (`machine.test.ts`: missing target → `fallback: 'centred'`) and Task 8 (anchor coverage).
2. **Hiding the example while a worker runs.** The next `gen` command must not bring it back, and reset must not duplicate it. Pinned in Task 1 (`ensureExample` after `hideExample` → `'hidden'`; `resetExample` twice → one example case).
3. **Double-clicking "Generate validation pack" or two tabs open.** Only one queued or running job per case. Pinned in Task 3 (`already_queued`).
4. **A worker that dies mid-validation.** The job stays `running`; the tab shows it as running with its start time and says "If the worker stopped, start it again and press Run validation again". A new job is allowed when the latest is `running` and older than 2 hours. Pinned in Task 3 (`stale running job → allowed`).
5. **Stored tour state that is corrupt or from an older version.** It reads as "no state" or "new steps" without crashing the layout. Pinned in Task 6 (`getTourState` on `{"bad":1}` → null).

---

## File Structure

```
packages/core/
  src/db/schema.ts                     # + runs.isExample, cases.isExample, validationJobs
  drizzle/0007_example_validation_jobs.sql   # generated
  src/example/fixture.ts               # EXAMPLE_* constants and fixture data (web-safe, data only)
  src/example/example.ts               # ensureExample / hideExample / resetExample / exampleState (web-safe)
  src/dashboard/validation-jobs.ts     # queue + read (web-safe)
  src/validation/job.ts                # executeValidationJob (worker side; not web-safe)
  src/dashboard/tour.ts                # tour state (web-safe)
  src/worker.ts                        # + claimNextValidationJob, runWorker executeValidation
  src/cli.ts                           # ensureExample on open; worker wires validation jobs
  src/db/migrate.ts                    # ensureExample after seedDefaults
  src/dashboard/{runs,command,board,leaderboard}.ts   # example exclusions / isExample fields
apps/web/
  package.json                         # + driver.js 1.9.0 (exact)
  app/layout.tsx                       # title PitchLab
  app/(app)/layout.tsx                 # TourProvider + TourButton
  actions/validation.ts, actions/example.ts, actions/tour.ts
  components/validation-job-form.tsx, components/validation-job-status.tsx
  components/example-badge.tsx, components/example-settings.tsx
  components/help-tip.tsx              # <details> tip
  components/tour/tour-provider.tsx, tour-button.tsx, chapter-picker.tsx
  lib/glossary.ts
  lib/tour/chapters.ts                 # static chapter/step definitions
  lib/tour/machine.ts                  # pure step machine
README.md, docs/user-guide.md, docs/architecture.md, docs/glossary.md   # new
docs/dashboard.md, docs/CONTEXT.md, .env.example                        # updated
```

---

### Task 1: Example case (schema, fixture, ensure/hide/reset)

**Files:**
- Modify: `packages/core/src/db/schema.ts`. Add `isExample: boolean('is_example').notNull().default(false)` to `runs` and `cases`. Also add the `validationJobs` table here, so there is only one migration. Columns:
  - `id`
  - `caseId` → `cases.id`, not null
  - `options` jsonb (typed in Task 3), not null
  - `status` `runStatus`, not null, default `'queued'`
  - `steps` jsonb, nullable
  - `error` text
  - `costUsd` numeric, not null, default `'0'`
  - `startedAt`, `finishedAt`, `createdAt`
  - index `(status, created_at)`

  Task 3 uses this table; no other task changes it.
- Generate: `packages/core/drizzle/0007_example_validation_jobs.sql`
- Create: `packages/core/src/example/fixture.ts`, `packages/core/src/example/example.ts`
- Modify: `packages/core/src/cli.ts:53` (call `ensureExample(db)` after `seedDefaults(db)`), `packages/core/src/db/migrate.ts:24` (same)
- Test: `packages/core/test/example/example.test.ts`

**Interfaces:**
- Produces:
  - `EXAMPLE_SLUG: string`: the value is the builder's call, but it must start with `example-`.
  - `EXAMPLE_HIDDEN_KEY = 'example.hidden'`
  - `ensureExample(db: Db): Promise<'inserted' | 'present' | 'hidden'>`
  - `hideExample(db: Db): Promise<void>`: sets `example.hidden` to `true` and deletes every example row.
  - `resetExample(db: Db): Promise<void>`: deletes the example rows, sets `example.hidden` to `false`, and inserts a fresh copy.
  - `exampleState(db: Db): Promise<{ hidden: boolean; slug: string | null }>`
- **What the fixture inserts, in one transaction:**
  - one `runs` row (`isExample: true`, `status: 'succeeded'`, `costUsd: '0'`, config from `defaultRunConfig({ seedType: 'idea', marketId: 'ca-us', ideaText: … })`);
  - one `ideas` row (`status: 'advanced'`);
  - one `cases` row (`isExample: true`, `stage: 'new'`, `gateAdvisory: true` with one gate flag, so the gate banner shows);
  - about 8 `claims` (a mix of `verified`, `unverified` and `needs_review`);
  - AI `scores` (`by: 'ai'`) for every criterion, and no owner scores;
  - one `validation_packs` row;
  - one `landing_pages` row;
  - 4 `prospects`: at least one each with CASL `self_published`, `third_party` and `unknown`, plus one with no email;
  - drafts (cold, followup1, followup2) for the prospects with email;
  - no outreach events, no `llm_calls`, no `data_calls`.
- **Delete order** (FK-safe, one transaction): outreach_events → outreach_drafts → suppressions for example prospects (if any) → prospects → landing_pages → validation_packs → validation_jobs → stage_events → scores → claims → cases → gate_verdicts for the idea → ideas → runs.

- [ ] **Step 1: Write the failing tests** in `example.test.ts`:
  - `ensureExample inserts once`: first call `'inserted'`, second `'present'`. Exactly 1 case with `isExample = true` and slug `EXAMPLE_SLUG`.
  - `hidden stays hidden`: after `hideExample`, `ensureExample` returns `'hidden'` and 0 example rows exist in `runs`, `ideas` and `cases`.
  - `reset restores one copy`: insert, add an owner score and an outreach event on an example prospect, `resetExample` twice. Result: 1 example case, 0 owner scores, 0 outreach events, and `exampleState` is `{ hidden: false, slug: EXAMPLE_SLUG }`.
  - `fixture parses`: `CaseSectionsSchema.parse(sections)`, `PackSectionsSchema.parse(pack.sections)` and `LandingCopySchema.parse(landing.copy)` all succeed.
  - `reserved domains only`: every URL and email anywhere in the fixture (`JSON.stringify` it, then match `https?://[^"\s]+` and `[^"\s@]+@[^"\s]+`) has a host equal to or ending in `example.com`, `example.org`, `example.net` or `.example`.
  - `no spend rows`: after insert, the counts in `llm_calls` and `data_calls` are unchanged.
  - `test DBs have no example`: `createTestDb()` has 0 example cases. This guards against seeding it from `seedDefaults`.
- [ ] **Step 2: Run** `npm test -w packages/core -- example`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the schema columns, generate the migration, then write `fixture.ts` (data only; imports types and schemas, no DB) and `example.ts` (imports `Db` as a type only, plus drizzle and schema). Wire `ensureExample` into `cli.ts` and `migrate.ts`.
- [ ] **Step 4: Run** `npm test -w packages/core`. Expected: all pass, including the existing migration and copy tests. Update `db/copy.ts` only if its table list is explicit; check whether it is.
- [ ] **Step 5: Commit** `feat(core): example case fixture with hide and reset`

### Task 2: Keep the example out of runs, spend and "Needs you"; expose it on board and leaderboard

**Files:**
- Modify: `packages/core/src/dashboard/runs.ts` (`listRuns`, `countRunsByStatus`), `packages/core/src/dashboard/command.ts` (`needsYou`: the unscored and advisory queries add `eq(cases.isExample, false)`; the reply query joins cases, so it filters the same way), `packages/core/src/dashboard/board.ts` (`BoardCard` gains `isExample: boolean`), `packages/core/src/dashboard/leaderboard.ts` (`LeaderRow` gains `isExample: boolean`)
- Test: extend `packages/core/test/dashboard/{runs,command,board,leaderboard}.test.ts`

**Interfaces:**
- Consumes: `ensureExample` (Task 1).
- Produces: `BoardCard.isExample` and `LeaderRow.isExample` (Task 5 renders the badge).

- [ ] **Step 1: Write the failing tests:**
  - With `ensureExample(db)` done plus one real seeded case:
    - `listRuns` total excludes the example run;
    - `countRunsByStatus().succeeded` excludes it;
    - `needsYou` has no item whose href contains `EXAMPLE_SLUG`;
    - `listBoard` includes the example card with `isExample: true`, and the real card has `false`;
    - `listLeaderboard` is the same.
  - `spendSince` is unchanged by `ensureExample`.
- [ ] **Step 2: Run** `npm test -w packages/core -- dashboard`. Expected: FAIL.
- [ ] **Step 3: Implement** the filters (`eq(runs.isExample, false)`) and the fields.
- [ ] **Step 4: Run** `npm test -w packages/core`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): example excluded from runs, counts and needs-you`

### Task 3: Validation job queue and worker

**Files:**
- Uses: the `validationJobs` table from Task 1 (type its `options` column as `ValidationJobOptions` and `steps` as `StepResult[]` with `$type`; no migration change).
- Create: `packages/core/src/dashboard/validation-jobs.ts` (web-safe), `packages/core/src/validation/job.ts`
- Modify: `packages/core/src/worker.ts`, `packages/core/src/cli.ts` (`workerCommand`)
- Test: `packages/core/test/dashboard/validation-jobs.test.ts`, `packages/core/test/validation/job.test.ts`, extend `packages/core/test/worker.test.ts`

**Interfaces:**
- Produces (`dashboard/validation-jobs.ts`):
  - `ValidationJobOptionsSchema = z.object({ prospects: z.number().int().min(1).max(100).default(25), skipProspects: z.boolean().default(false), refresh: z.boolean().default(false), redraft: z.boolean().default(false) })`, plus the type `ValidationJobOptions`.
  - `MAX_QUEUED_VALIDATIONS = 3`, `STALE_RUNNING_MS = 2 * 60 * 60 * 1000`.
  - `queueValidationJob(db: Db, caseId: string, raw: ValidationJobOptions): Promise<{ ok: true; id: string } | { ok: false; reason: 'not_found' | 'example' | 'sender_missing' | 'already_queued' | 'too_many_queued' }>`. Checks in this order: case exists → not example → `getSender(db).missing.length === 0` → no queued job for the case and no running one younger than `STALE_RUNNING_MS` → global queued count < 3. Serialise with a transaction-scoped advisory lock, as in `queueRun`.
  - `type ValidationJobView = { id: string; status: RunStatus; options: ValidationJobOptions; steps: StepResult[] | null; error: string | null; costUsd: number; createdAt: Date; startedAt: Date | null; finishedAt: Date | null }`
  - `latestValidationJob(db: Db, caseId: string): Promise<ValidationJobView | null>`. The error is passed through `scrubError` and cut to 300 characters.
- Produces (`validation/job.ts`): `executeValidationJob(deps: ValidationDeps, jobId: string, run = runValidation): Promise<'succeeded' | 'failed'>`.
  - It loads the job, re-parses its options with the schema (invalid → failed with `invalid job options`), calls `run(deps, job.caseId, { prospects, skipProspects, refresh, redraft })`, and stores `steps`, `status` (`result.ok ? 'succeeded' : 'failed'`), `finishedAt` and the cost.
  - The cost is the sum of `llm_calls.costUsd` plus `data_calls.costUsd` where `runId IS NULL` and `createdAt` is between `startedAt` and now.
  - A thrown error → `failed` with the scrubbed message, capped at 1000 characters.
- Produces (`worker.ts`):
  - `claimNextValidationJob(db: Db): Promise<string | null>`, using the same SKIP LOCKED pattern as `claimNextRun`.
  - `WorkerOptions` gains `executeValidation: (jobId: string) => Promise<'succeeded' | 'failed'>`.
  - Loop order: claim a run first; if none, claim a validation job; if neither, sleep. The heartbeat interval wraps both. Document "runs first" in the JSDoc.
- `cli.ts`: `executeValidation` builds the same deps as `validateCommand` (factor a shared `validationDeps(env, db)`), then calls `executeValidationJob`.

- [ ] **Step 1: Write the failing tests:**
  - `validation-jobs.test.ts`:
    - happy path returns an id with the default options;
    - `example` for the example case;
    - `sender_missing` when the sender is unset;
    - `already_queued` on a second queue;
    - a stale running job (startedAt 3 h ago) → allowed;
    - a fresh running job → `already_queued`;
    - a 4th queued job across cases → `too_many_queued`;
    - `prospects: 101` and `0` are rejected by the schema;
    - `latestValidationJob` returns the newest row with a scrubbed error.
  - `job.test.ts` (mock `run`):
    - an `ok: true` result → `'succeeded'` with the steps stored;
    - `ok: false` → `'failed'`;
    - a throw → `'failed'` with a scrubbed error;
    - the cost sums two null-run `llm_calls` rows inserted inside the window and ignores one before `startedAt` and one with a run id.
  - `worker.test.ts`:
    - with one queued run and one queued job, `once` executes the run and not the job;
    - with only a job, `executeValidation` is called with its id;
    - two concurrent `claimNextValidationJob` calls never return the same id.
- [ ] **Step 2: Run** `npm test -w packages/core -- validation-jobs job worker`. Expected: FAIL.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run** `npm test -w packages/core`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): validation jobs queued from the dashboard and run by the worker`

### Task 4: "Generate validation pack" on the Validate tab

**Files:**
- Create: `apps/web/actions/validation.ts`, `apps/web/components/validation-job-form.tsx` (client, `useActionState`, works without JS), `apps/web/components/validation-job-status.tsx`
- Modify: `apps/web/app/(app)/cases/[slug]/page.tsx` (for the validate tab, also load `latestValidationJob`, `getSender(db).missing` and `view.case.isExample`; render `AutoRefresh` every 10 s while the job is queued or running), `apps/web/components/tabs/validate.tsx`
- Test: `apps/web/test/actions/validation.test.ts`, `apps/web/test/components/validation-job.test.tsx`, and update the existing validate-tab tests that assert the old "Run: npm run gen -- validate" text

**Interfaces:**
- Consumes: `queueValidationJob`, `latestValidationJob`, `ValidationJobOptionsSchema`, `ValidationJobView` (Task 3); `getSender` from `@bcg/core/validation/settings`.
- Produces: `queueValidationAction(prev: FormState, fd: FormData): Promise<FormState>`, with fields `caseId` (uuid), `slug`, `prospects`, and the checkboxes `skipProspects`, `refresh`, `redraft`. The refusal copy:
  - `example`: "This is the example case. Its validation pack is already there."
  - `sender_missing`: "Set your name, mailing address and contact in Settings first. Every email must include them."
  - `already_queued`: "A validation job for this case is already waiting or running."
  - `too_many_queued`: "3 validation jobs are already waiting. Wait for the worker."
  - `not_found`: "This case no longer exists."
  - On success it revalidates `/cases/<slug>` and returns `{ ok: true }`.
- **Form copy:**
  - Button "Generate validation pack" when there is no pack; "Run validation again" when there is one.
  - Under it: "Uses about $0.60–1.50 of model calls (prospect search is about $0.45–0.60 of that). Runs when `npm run worker` is running. Files are also saved to output/validation/<slug>/ on the worker's computer."
- **When disabled, the form is replaced by text:**
  - on the example: "Example data: already generated.";
  - when the sender is missing: the message above plus a link to `/settings`.
- **Status:**
  - queued → "Waiting for the worker";
  - running → "Running since <time>", plus the stale hint after 2 h;
  - succeeded → one line per step (`step · status · detail`) and the cost;
  - failed → the error.
- **`data-tour` anchors:** `validate-generate` (form button), `validate-status`.

- [ ] **Step 1: Write the failing tests:**
  - the action rejects without a session (via the all-actions test), rejects `prospects=abc`, and maps each refusal to its copy;
  - the component shows "Generate validation pack" with no pack and "Run validation again" with one;
  - it shows the example and sender-missing replacements, the settings link, and each status rendering;
  - a hostile `error` string renders as text.
- [ ] **Step 2: Run** `npm test -w apps/web -- validation`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -w apps/web && npm run typecheck -w apps/web`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): generate the validation pack from the Validate tab`

### Task 5: Example badges and Settings controls

**Files:**
- Create: `apps/web/components/example-badge.tsx` (`<span className="badge badge-info">Example</span>`, with `title="Built-in example with made-up data"`), `apps/web/components/example-settings.tsx`, `apps/web/actions/example.ts`
- Modify: `components/case-card.tsx`, `components/case-header.tsx` (also a one-line note under the title: "This is a built-in example with made-up businesses. Practise freely; Settings can reset or hide it."), `components/leaderboard-table.tsx`, `components/settings-view.tsx` and `app/(app)/settings/page.tsx` (load `exampleState`)
- Test: `apps/web/test/actions/example.test.ts`, extend the component tests for the card, header, leaderboard and settings

**Interfaces:**
- Consumes: `hideExample`, `resetExample`, `exampleState` (Task 1); `BoardCard.isExample`, `LeaderRow.isExample` (Task 2). `CaseView.case` already carries the `cases` row, so it gains `isExample` from the schema.
- Produces: `hideExampleAction(fd: FormData): Promise<void>` and `resetExampleAction(fd: FormData): Promise<void>`. Both redirect to `/settings?notice=example_hidden|example_reset` and revalidate `/`, `/leaderboard` and `/settings`.
- **Settings section "Example case":**
  - the state ("Shown" / "Hidden");
  - when shown, a **Hide example case** button;
  - always, a **Reset example case** button ("Restores the example and shows it again; your practice scores and notes on it are removed").
- **`data-tour` anchors:** `settings-example`.

- [ ] **Step 1: Write the failing tests:**
  - badge present when `isExample` and absent otherwise;
  - the header note shows only on the example;
  - the settings section's buttons match the state;
  - the actions call core and redirect with the notice;
  - the notices render.
- [ ] **Step 2: Run** `npm test -w apps/web -- example`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test -w apps/web && npm run typecheck -w apps/web`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): example case badges, hide and reset`

### Task 6: Glossary, help tips and docs/glossary.md

**Files:**
- Create: `apps/web/lib/glossary.ts`, `apps/web/components/help-tip.tsx`, `docs/glossary.md`
- Modify: place `<HelpTip term=… />` next to:
  - `queue-run-form.tsx`: Seed legend, Lenses legend, Sectors legend, both count labels;
  - `case-header.tsx`: gate flags banner, stage chip;
  - `tabs/score.tsx`: AI scores heading;
  - `tabs/validate.tsx`: CASL basis column header, Checklist heading;
  - `stage-move-form.tsx`: next to Overturn kill;
  - `command-center.tsx`: Worker line and Spend card ("notional").
- Test: `apps/web/test/components/help-tip.test.tsx`, `apps/web/test/glossary-sync.test.ts`

**Interfaces:**
- Produces:
  - `type GlossaryTerm = 'seed' | 'lens' | 'sector' | 'ideaCount' | 'advanceCount' | 'gateFlags' | 'stage' | 'aiScore' | 'caslBasis' | 'checklist' | 'overturnKill' | 'worker' | 'notionalSpend'`
  - `GLOSSARY: Record<GlossaryTerm, { label: string; text: string }>`. Each `text` is 1–3 plain sentences.
  - `HelpTip({ term }: { term: GlossaryTerm })`: renders `<details className="help-tip"><summary aria-label={`What is ${label}?`}>?</summary><p>{text}</p></details>`. The summary is a ≥ 44px tap target, and the panel must not cause sideways scroll at 375px.
- `docs/glossary.md`: one `### <label>` heading per glossary entry (same label text), plus pipeline and validation terms: harvest, signal, voice, ideate, dedupe, screen, gate, case, claim, verify, score, validation pack, prospect, draft, landing page, run, notional spend.

- [ ] **Step 1: Write the failing tests:**
  - `HelpTip` renders a closed `details` with the label in `aria-label`, and the text appears after a click;
  - with JS off (static render) the markup is still `details`/`summary`;
  - the glossary-sync test reads `docs/glossary.md` and asserts a `### ${label}` heading exists for every `GLOSSARY` entry.
- [ ] **Step 2: Run** `npm test -w apps/web -- help-tip glossary`. Expected: FAIL.
- [ ] **Step 3: Implement** the component, the CSS in `globals.css` (light and dark), the placements, and the glossary doc.
- [ ] **Step 4: Run** `npm test -w apps/web && npm run typecheck -w apps/web`. Expected: PASS. Existing snapshot or text tests that break because of the added "?" get their expectations updated, not the tip removed.
- [ ] **Step 5: Commit** `feat(web): inline help tips and glossary`

### Task 7: Tour state, step machine and driver.js engine

**Files:**
- Create: `packages/core/src/dashboard/tour.ts`, `apps/web/actions/tour.ts`, `apps/web/lib/tour/machine.ts`, `apps/web/components/tour/tour-provider.tsx`, `apps/web/components/tour/tour-button.tsx`, `apps/web/components/tour/chapter-picker.tsx`
- Create (stub, filled in Task 8): `apps/web/lib/tour/chapters.ts` with one placeholder chapter so the engine can be tested
- Modify: `apps/web/package.json` (add `"driver.js": "1.9.0"`), `apps/web/app/(app)/layout.tsx` (load `getTourState` and the tour case slug; render `<TourProvider initial=… caseSlug=…>` around the children, with `<TourButton />` in the header before Log out), `apps/web/app/layout.tsx` (title `PitchLab`)
- Test: `packages/core/test/dashboard/tour.test.ts`, `apps/web/test/lib/tour-machine.test.ts`, `apps/web/test/actions/tour.test.ts`, `apps/web/test/components/tour-provider.test.tsx` (mock `driver.js`)

**Interfaces:**
- Produces (core `dashboard/tour.ts`):
  - `TOUR_CHAPTERS = ['setup', 'generate', 'board', 'read', 'score', 'validate', 'outreach', 'decide'] as const`, `type TourChapterId`, `TOUR_VERSION = 1`, `TOUR_STATE_KEY = 'tour.state'`
  - `TourStateSchema = z.object({ version: z.number().int().min(1), completed: z.array(z.enum(TOUR_CHAPTERS)).max(8), current: z.object({ chapter: z.enum(TOUR_CHAPTERS), step: z.number().int().min(0).max(50) }).nullable(), dismissed: z.boolean() })`, plus the type `TourState`
  - `getTourState(db): Promise<TourState | null>`: invalid stored data → null.
  - `saveTourState(db, s: TourState): Promise<void>`
  - `tourCaseSlug(db): Promise<string | null>`: the newest non-killed real case's slug, else the example's slug, else null.
- Produces (`actions/tour.ts`): `saveTourStateAction(state: unknown): Promise<{ ok: boolean }>`. It zod-parses the input, so a bad payload returns `{ ok: false }` and writes nothing.
- Produces (`lib/tour/machine.ts`, pure, no DOM):
  - `type TourStep = { id: string; route: string | ((ctx: TourCtx) => string | null); target?: string; title: string; body: string; kind: 'info' | 'action'; advanceOn?: { click?: true; path?: RegExp; appears?: string } }`
  - `type TourCtx = { caseSlug: string | null }`
  - `type Position = { chapter: TourChapterId; step: number }`
  - `next(pos, chapters): Position | { done: TourChapterId }`, `back(pos, chapters): Position`
  - `resolve(step, ctx, pathname, targetPresent: boolean): { show: 'highlight' | 'centred' | 'go-there'; href?: string }`. Rules: if the route resolves to null → `centred` (with the step body explaining). If the route differs from `pathname` → `go-there` with `href`. If the target is absent → `centred`. Otherwise → `highlight`.
  - `shouldAutoStart(state: TourState | null): boolean`: true only when the state is null.
  - `hasNewSteps(state): boolean`: `state.version < TOUR_VERSION && !state.dismissed`.
- **The provider's driver.js use:**
  - one `driver()` instance; `highlight({ element: '[data-tour="<id>"]', popover: { title, description, showButtons, onNextClick, onPrevClick, onCloseClick } })` per step;
  - "Take me there" is a popover button that calls `router.push(href)`;
  - action steps listen for a click on the target, a `usePathname` change matching `path`, or a `MutationObserver` waiting for `[data-tour="<appears>"]`. All listeners are cleaned up on step change.
  - The state is saved (debounced 500 ms) through `saveTourStateAction` on every position change, finish or exit.
  - The CSS theme for `.driver-popover` uses `globals.css` variables (light and dark). Import `driver.js/dist/driver.css` once in the provider.
- **TourButton:** "Take the tour". It opens `ChapterPicker`: a dialog listing the 8 chapter titles, each with a ✓ when completed, a "Start from the beginning" button and a "Continue where you left off" button when `current` is set. A dot shows on the button when `hasNewSteps`.

- [ ] **Step 1: Write the failing tests:**
  - core: round-trip, corrupt value → null, `tourCaseSlug` prefers a real case over the example and skips killed cases;
  - machine:
    - `next` across a chapter end → `{ done }`;
    - `back` at step 0 stays put;
    - `resolve` covers each of the four branches;
    - `shouldAutoStart(null)` is true and false otherwise;
    - `hasNewSteps` respects `dismissed`;
  - action: a bad payload → `{ ok: false }` with no write;
  - provider (driver.js mocked):
    - it auto-starts when `initial` is null;
    - it calls `highlight` with the selector for the first step;
    - "Exit" saves `dismissed: true`;
    - a missing target produces a centred popover (`element` undefined);
    - the button opens the picker.
- [ ] **Step 2: Run** `npm test -w packages/core -- tour` and `npm test -w apps/web -- tour`. Expected: FAIL.
- [ ] **Step 3: Implement.** Run `npm install driver.js@1.9.0 -w apps/web --save-exact`.
- [ ] **Step 4: Run** `npm test -w packages/core && npm test -w apps/web && npm run typecheck -w apps/web`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): tour engine with saved progress and chapter picker`

### Task 8: The eight chapters and their anchors

**Files:**
- Modify: `apps/web/lib/tour/chapters.ts`, replacing the stub with `CHAPTERS: Record<TourChapterId, { title: string; steps: TourStep[] }>`
- Modify: add `data-tour` attributes to the components the steps target, e.g. `nav-runs`, `nav-board`, `nav-command`, `nav-settings` (on the nav links), `worker-badge`, `settings-connections`, `settings-sender`, `queue-seed`, `queue-counts`, `queue-submit`, `queue-ok` (the Queued status), `runs-history`, `needs-you`, `board-columns`, `board-filters`, `board-first-card` (the first card only), `case-stage`, `case-gate-flags`, `case-export`, `case-tabs`, `tab-evidence`, `tab-numbers`, `tab-competitors`, `tab-pitch`, `tab-score`, `tab-validate`, `score-form`, `validate-pack-docs`, `validate-checklist`, `validate-prospects`, `validate-drafts` (the first prospect's details), `mark-outreach` (the first form), `outreach-counts`, `stage-move`, and Task 4/5's anchors. The final list is whatever the chapters use.
- Test: `apps/web/test/tour-anchors.test.ts`, `apps/web/test/lib/tour-chapters.test.ts`

**Interfaces:**
- Consumes: the `TourStep` type, `TourCtx`, the machine (Task 7). Case-page routes use `(ctx) => ctx.caseSlug ? `/cases/${ctx.caseSlug}?tab=…` : null`.
- **Content:** the spec's §2 bullets, in order, per chapter. Fixed points:
  - chapter 1 checks the worker badge (Command center) before connections (Settings);
  - chapter 2's submit step is `kind: 'action'` with `advanceOn: { appears: 'queue-ok' }`, and its body states the cost and that Open/Sectors/Lenses runs may end with no case while "Your idea" always gives one;
  - chapter 2's last step says "Runs take a while. The rest of the tour uses your newest case, or the built-in example until you have one.";
  - chapter 6's generate step is `action` with `advanceOn: { appears: 'validate-status' }` and states the cost;
  - chapter 7 says the app never sends email;
  - chapter 8 ends by naming "Take the tour" and the docs.

- [ ] **Step 1: Write the failing tests:**
  - `tour-anchors.test.ts`:
    - scan `apps/web/app` and `apps/web/components` for `data-tour="…"` literals;
    - every `target` and `advanceOn.appears` in `CHAPTERS` appears in exactly one source file;
    - every source anchor is used by some step.
  - `tour-chapters.test.ts`:
    - all 8 chapters exist in `TOUR_CHAPTERS` order, each with ≥ 2 steps;
    - every step `id` is unique;
    - every `title`/`body` is a non-empty string with no `<`, `>` or `&` (driver.js uses innerHTML) and no `${`;
    - `body` is ≤ 320 characters;
    - the chapter-2 submit step and the chapter-6 generate step contain `$`;
    - no step text contains "R13", "gate.v", "SDD" or "TODO".
  - Static-text guard: `chapters.ts` source has no `import` other than types and core's `TOUR_CHAPTERS`, so step text cannot come from data.
- [ ] **Step 2: Run** `npm test -w apps/web -- tour`. Expected: FAIL.
- [ ] **Step 3: Write** the chapters and add the anchors.
- [ ] **Step 4: Run** `npm test -w apps/web && npm run typecheck -w apps/web`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): end-to-end tour chapters`

### Task 9: Repo documentation

**Files:**
- Create: `README.md`, `docs/user-guide.md`, `docs/architecture.md`
- Modify: `docs/dashboard.md` (the button, the example case, the tour; link to the README), `.env.example` (unchanged unless a new variable appears; none is planned), `docs/CONTEXT.md` (status and session log), `docs/plan-1-followups.md` (the Plan 2 "generate the validation pack from the UI" exclusion is now done)
- Test: `apps/web/test/docs-links.test.ts`: every relative Markdown link in `README.md` and `docs/{user-guide,architecture,glossary,dashboard}.md` points to an existing file.

**Content (spec §7):**
- **README:**
  - "PitchLab": one paragraph on what it does and who it is for;
  - a Mermaid `flowchart LR` of the end-to-end flow (queue run → pipeline → case → score → validate → outreach → decide);
  - requirements (Node ≥ 22.12, an LLM endpoint and key, Postgres; Supabase free works);
  - a quick start (clone, `npm install`, copy `.env.example`, `npm run hash-password -w apps/web`, `npm run web` + `npm run worker`, "Take the tour");
  - the CLI in brief (`gen run`, `gen validate`, `gen runs`);
  - costs;
  - the safety stance;
  - doc links.
- **user-guide:** the 8 chapters in prose. Each step covers what, why and what good looks like, plus "How to judge a case" (evidence quality, verification flags, the numbers' assumptions, unverified competitors) and "When to kill".
- **architecture:**
  - the layout, with the purpose of each workspace;
  - a pipeline Mermaid diagram plus a table (stage, purpose, inputs, outputs, model stage), using the real stage names `harvest, ideate, dedupe, screen, gate, case, verify, score`;
  - the validation steps `pack, prospects, emails, drafts, landing, export`;
  - the worker loop (runs, then validation jobs; no leases yet);
  - the data model grouped by purpose;
  - the LLM router and cost logging (notional);
  - the security model with the reason for each rule (SSRF guard, untrusted text, CASL, never sends email, TLS verification, auth layers, rate limit);
  - testing and merge gates;
  - the known limits (link `docs/plan-1-followups.md`).

- [ ] **Step 1: Write the failing test** `docs-links.test.ts`. Expected: FAIL (README missing).
- [ ] **Step 2: Write** the docs. Check every command against `package.json` scripts and every stage or table name against the code.
- [ ] **Step 3: Run** `npm test -w apps/web -- docs-links glossary`. Expected: PASS.
- [ ] **Step 4: Commit** `docs: README, user guide, architecture`

### Task 10: Whole-branch check and merge

- [ ] **Step 1: Gates.** Run, with `set -o pipefail`, the core and web suites, the web typecheck, the web build with dummy env (`DATABASE_URL=postgres://u:p@localhost:5432/db OWNER_PASSWORD_HASH='scrypt:16384:8:1:abc:def' SESSION_SECRET=<36 chars> DATABASE_SSL_CA=`) and `npm run check-bundle -w apps/web`. Expected: all exit 0.
- [ ] **Step 2: Migration on a copy.** `DATABASE_URL=pglite://.data/tour-check npm run gen -- runs` on a fresh folder. Expected: it migrates, lists 0 runs (the example run is hidden), and `.data/tour-check` then holds exactly one example case. Delete the folder afterwards.
- [ ] **Step 3: Secret scan and merge.** Expected: 0 token hits and no tracked sensitive files. Then fast-forward `main`, push, and delete the branch.
- [ ] **Step 4: Owner's manual check** (listed in the reply, not automated): restart `npm run web` and `npm run worker`; the tour starts by itself. Walk all 8 chapters on desktop and on a phone. "Take the tour" restarts a chapter. Hide and reset the example. Generate a validation pack on a real case after setting the sender.
