# Guided Tour, In-App Help and Repo Documentation

Status: approved by the owner on 2026-10-20 ("it looks good go ahead"). Sections marked **Builder's call** were settled by me (Claude) and not discussed with the owner.

## Intent

The dashboard works, but nothing in it explains the flow from "I have nothing" to "I contacted prospects and decided go or kill." The owner wants:

1. **An interactive walkthrough in the real web UI.** It highlights the button to press or the field to fill, from start to finish, and can be restarted whenever someone forgets.
2. **Strong documentation in the GitHub repo**, so the owner can understand what the app does months from now. The repo has no README today.

**Audience is anyone, not only the owner.** The owner may release the app as a side project, so a stranger who just installed it must be able to follow the tour without prior context. Each person runs their own single-owner install; there are no multi-user accounts. The tour covers the whole path, end to end.

## Goals

- **G1: guided tour.** A first-time user can go from an empty install to a scored, validated case with outreach logged and a stage decision, guided by the tour, without reading any docs.
- **G2: always available.** The tour starts itself on the first login, and a "Take the tour" control in the header restarts it, whole or by chapter, at any time.
- **G3: no terminal steps in the main path except starting the worker.** Validation-pack generation moves into the UI.
- **G4: help without the tour.** Someone who skips the tour can still understand confusing terms, through small inline help tips.
- **G5: repo docs.** The repo explains what the app is, how to set it up, how to use it end to end, and how it works inside.

## Non-goals

- Screenshots or video in the docs. Approved: text and Mermaid diagrams now, screenshots later if the app is released, since automated capture would need Playwright.
- Multi-user accounts, i18n, tour analytics or telemetry.
- Starting the worker from the UI. It stays `npm run worker` in a terminal, and the tour checks for it.
- Any change to the generation pipeline, the gate or scoring logic.

## Anti-goals (a failure even if it technically works)

- **A tour that dead-ends.** No step may wait on something the user cannot produce at that moment: a missing target, no cases, a run still running. Every step has a way forward.
- **A tour that spends money without an explicit, informed click.** The "Queue run" and "Generate validation pack" steps show the rough cost and wait for the user to press the real button. The tour never presses it for them.
- **Tour text that drifts from the UI.** If a highlighted element is renamed or removed, a test fails.
- **An example case that could be mistaken for real.** It must not name real businesses or real email addresses, and nobody may email anyone because of it.
- **Anything that sends email.** The app never sends email; the user sends it themselves and logs it.
- **Rendering untrusted text as HTML.** Case, prospect and LLM text must never reach the tour popovers (rule R13).

## Constraints (existing rulings that bind)

- **Stack:** Next.js 16 App Router (`apps/web`), core library (`packages/core`) consumed through its exports map, and Drizzle with Postgres/PGlite migrations in `packages/core/drizzle`.
- **Web-safe imports:** the web app imports only web-safe core modules (`apps/web/test/core-imports.test.ts`), and client components must not pull server modules into the browser bundle (`npm run check-bundle -w apps/web`).
- **Server Actions:** every mutating action calls `requireOwner()` and passes the existing Origin check. Error messages name fields, never echo values.
- **Escaping:** all case text is escaped and never rendered as raw HTML (R13).
- **No JavaScript:** forms keep working without JS (existing pattern). The tour itself may require JS; help tips must not.
- **Phone width:** pages work at 375px with no sideways scroll. The board shows one stage column at a time below 768px.
- **Process:**
  - TDD, then review.
  - Merge only when the core and web suites, the web typecheck, the web build and the bundle check are green, and the secret scan is clean.
  - No live LLM calls in tests.
- **Secrets:** never printed, logged or committed.

## The design

### 1. Tour engine

- **Library: driver.js (MIT, no dependencies). Builder's call.** Pin an exact version that is at least two weeks old. driver.js renders popover text through `innerHTML`, so every title and description is a static string literal authored in the tour module. A guard test asserts that step text is never built from variables or props.
- **Provider.** A client `TourProvider` is mounted in `app/(app)/layout.tsx` and holds the current chapter and step. It survives client-side navigation because the layout persists. On a full reload it resumes from the saved state.
- **Anchors.** Targets are stable `data-tour="<id>"` attributes added to existing components, not CSS classes or label text. A test checks that every target id used by a step exists in exactly one component file, and that every `data-tour` attribute is used by some step.
- **Step kinds:**
  - `info`: a popover with Back / Next / Skip chapter / Exit.
  - `action`: a highlighted target. The tour advances when the user does the real thing:
    - clicks the target;
    - the route changes to an expected path;
    - an expected element appears, for example the "Queued." status after submit.
  - Action steps also show "Next" as an escape hatch, which keeps the no-dead-end rule.
- **Cross-page steps.** A step names the route it belongs to. If the user is elsewhere, the popover offers "Take me there" (`router.push`) instead of highlighting nothing.
- **Missing target.** If a target is absent (a hidden column on a phone, an empty list), the step falls back to a centred popover that explains what would be there. It never throws or hangs.
- **Waiting.** Steps that wait for slow things, such as a run finishing or a validation job, say so plainly. They offer "I'll come back later": the tour saves its place, and "Take the tour" resumes there.
- **Accessibility:** focus moves into the popover, Escape exits, controls are buttons with labels, and it works at 375px.

### 2. Chapters (the whole path)

Each chapter can be started on its own from the chapter picker. The order is the real workflow.

1. **Welcome and setup** (Command center, then Settings)
   - What the app does, in one paragraph.
   - The worker badge (Command center, fresh within `WORKER_FRESH_MS` = 60 s), with "Start it with `npm run worker`". The step waits until the worker is seen, or the user chooses to continue anyway. This comes first because the Settings connection badges are filled from the worker's heartbeat.
   - Connections (Settings): the LLM key must show "connected".
   - Sender identity fields (name, mailing address, contact), and why: CASL / CAN-SPAM require them in every email.
   - Save.
2. **Generate cases** (Runs)
   - The seed choice: Open, Sectors, Lenses, or Your idea, with when to use each.
   - The relevant fields for the chosen seed.
   - Ideas to generate and Ideas to turn into cases, plus the rough cost: about $3–7 per run at the defaults, in notional LLM spend.
   - The user presses **Queue run**.
   - Then the status and history rows, the auto-refresh, and a pointer to the Command center for "Needs you".
   - Say plainly that Open, Sectors and Lenses runs often end with no case, because the gate kills weak ideas. "Your idea" always produces a case, because the gate only advises on it (`pipeline/run.ts`). Meanwhile the tour continues with the example case.
3. **The board** (Board)
   - Stage columns (New → Validating → Pilot → Live, plus Killed), the filters (lens, minimum AI score), the gate-kill list and re-run.
   - Open a case card. Use the user's first real case if one exists, otherwise the example case.
4. **Read a case** (case page)
   - The header: stage chip, gate flags banner, Export Markdown.
   - Then each tab in order, with what to look for:
     - Summary
     - Evidence: verification flags, voice
     - Numbers: assumptions
     - Competitors: unverified items "for you to check"
     - Pitch
5. **Score it** (Score tab)
   - AI scores versus your scores. Fill in at least one criterion with a note, then save.
   - Explain that your scores drive the leaderboard.
6. **Validate** (Validate tab)
   - Press **Generate validation pack** (see §3) and wait.
   - Then walk through the pack documents (MVP spec, pilot plan, interview kit), the checklist with thresholds, the prospects table with CASL badges ("unknown — do not email"), and the landing summary.
7. **Outreach** (Validate tab, drafts)
   - Open a prospect's drafts and copy the email to your own mail client. The app does not send.
   - Log **I sent it**, then replies, meetings and interview notes.
   - Watch the outreach counts and checklist move.
8. **Decide** (case header, Command center)
   - Move the case to Validating, Pilot or Live, or Kill it; killing requires a reason.
   - "Overturn kill" exists.
   - The Command center's "Needs you" list is where to come back to each day.
   - Finish: completion is saved, with a pointer to "Take the tour" and to the docs.

### 3. "Generate validation pack" button (moves a CLI step into the UI)

- **Where:** on the Validate tab. When no pack exists, it replaces today's "Run: npm run gen -- validate <slug>" text. When a pack exists, it is a smaller "Run validation again" control.
- **Options shown:**
  - prospects to look for: default 25, max 100, the same bound as the CLI;
  - "Skip new prospect search";
  - "Regenerate pack and landing page" (`refresh`);
  - "Rewrite drafts for prospects not yet contacted" (`redraft`).

  `--pilot-site`, `--include-weak` and `--source` stay CLI-only.
- **Cost estimate shown next to the button:** about $0.60–1.50 per job, of which the prospect search is about $0.45–0.60 ("Skip new prospect search" avoids it) and the pack about $0.35–0.65. Source: `docs/runs/2026-10-19-validation-freight.md`.
- **Sender identity gate:** if it is missing, the button is disabled, with a link to Settings, so a novice never generates drafts carrying `[SET SENDER …]` markers. **Builder's call:** the CLI only warns, but the UI blocks.
- **Queueing:** pressing the button queues a validation job. The worker picks it up with the same `FOR UPDATE SKIP LOCKED` claim pattern as runs, and calls the existing `runValidation(deps, caseId, opts)`.
  - **Builder's call:** a new `validation_jobs` table (case id, options, status, step results, error, cost, timestamps) rather than overloading `runs`, so `RunConfigSchema` stays untouched.
  - The worker should process queued runs and validation jobs oldest-first across both tables, or runs first if simpler. Document the choice.
  - Guard: at most one queued or running validation job per case, and a global cap like `MAX_QUEUED`.
  - **Cost:** validation LLM and data calls carry no run id. The job's cost is the sum of calls with a null run id between its start and finish; this is sound because one worker runs one job at a time. Same approach as the CLI's `spendSince`.
- **Status:** the tab shows the latest job (queued / running / succeeded with per-step results and cost / failed with the scrubbed error). It auto-refreshes while the job is active, using the existing `AutoRefresh` component.
- **Files:** export files still go to `output/validation/<slug>/` on the worker's machine; say so in the UI.
- **CLI:** `gen validate` keeps working unchanged.

### 4. Example case

- **What:** a built-in, hand-written example case, clearly labelled **Example** wherever it appears: board card, case header, leaderboard row. It gives chapters 3–8 something to point at before the user has a real case, and lets people practise safely.
- **Content:**
  - A plausible but invented service idea. It includes enough of each section for every tab to render: evidence with claims, competitors, numbers, pitch, AI scores, a validation pack, a checklist, a landing summary, and a handful of prospects with drafts.
  - All names must be obviously fictional.
  - Every website and email uses reserved example domains (`example.com`, `example.org`, `*.example`).
  - No real business may appear.
- **Storage (Builder's call):** stored as fixture data in core. It is inserted idempotently by the existing seed path (`seedDefaults`, which runs at the start of every `gen` command, worker included) when no example exists and the setting `example.hidden` is not true. Hiding must set that flag, or the next `gen` command would re-seed it. Mark the case with an `is_example` boolean on `cases`, via a migration.
- **Foreign keys:** `cases.idea_id` and `ideas.run_id` must reference real rows, so the fixture brings its own example run and idea (mark them too, e.g. `is_example` on `runs`). The Runs history, run counts, the Command center's recent runs and spend all exclude the example run.
- **Web access:** "Reset example case" runs from a web Server Action, so the fixture and its insert function must live in a web-safe core module (no env loader, PGlite, router or SDK imports). Extend the core-imports guard to cover it.
- **Behaviour:**
  - It is excluded from spend totals, the Command center's "Needs you", and run counts.
  - It is shown on the board and leaderboard with the badge.
  - Actions on it (scoring, stage moves, outreach logging) work, because they are practice.
  - "Generate validation pack" is disabled on it ("example data, already generated"), so it never spends money.
- **Controls:** Settings → "Example case" section with **Hide example case** and **Reset example case** (restores the fixture).

### 5. Tour state

- **Where:** stored in the `settings` table under key `tour.state`: `{ version, completedChapters, current?: { chapter, step }, dismissed }`. It is in the database, not the browser, so it follows the user across devices. **Builder's call.**
- **Writes:** through a Server Action (`requireOwner`, Origin check, zod-validated, chapter ids from a fixed list).
- **Auto-start:** on the first signed-in page load when there is no state.
- **Changed tour:** bumping `version` when the chapters change materially shows a one-time "The tour has new steps" hint. It does not force a restart.

### 6. Inline help tips

- **Component:** a small `HelpTip` built on `<details>`/`<summary>`, so it works without JS and on touch. It shows a "?" button whose text comes from one glossary module (`apps/web/lib/glossary.ts`).
- **Placed next to:** Seed, Lenses, Sectors, Ideas to generate / turn into cases, Gate flags, AI score, CASL basis, Checklist, Stage, Overturn kill, Worker, Notional spend.
- **Sync test:** a test asserts that every glossary term also appears in `docs/glossary.md`, so the in-app and repo explanations stay together.

### 7. Repo documentation

Written for a future reader who has forgotten everything, and for a stranger evaluating the project.

- **`README.md` (new):**
  - what the app does and who it is for (one paragraph), and the end-to-end flow as a Mermaid diagram;
  - what you need: Node ≥ 22.12, an Anthropic/OpenAI-compatible LLM endpoint and key, and a Postgres database (Supabase free works);
  - a quick start (install, `.env`, hash a password, `npm run web` and `npm run worker`, then take the tour);
  - rough costs, the safety stance (never sends email, verifies TLS, treats web text as untrusted), and links to the other docs.
- **`docs/user-guide.md` (new):** the same eight chapters as the tour, in prose. Each step covers what to do, why, and what "good" looks like, plus how to judge a case and when to kill it.
- **`docs/architecture.md` (new):**
  - the monorepo layout;
  - the pipeline stages (harvest → ideate → dedupe → screen → gate → case → verify → score), each with its purpose, inputs and outputs;
  - the validation steps (pack → prospects → emails → drafts → landing → export);
  - the worker and job queue;
  - the database tables, grouped by purpose;
  - the LLM router, model per stage, and cost logging;
  - the security model and the reasons behind it (SSRF guard, untrusted-text handling, CASL, TLS, auth);
  - testing and merge gates.
- **`docs/glossary.md` (new):** every term in the help tips, plus pipeline and validation terms.
- **`docs/dashboard.md`:** stays as the setup and operations guide. Add the new button and the example case, and link it from the README.
- **`docs/CONTEXT.md`:** status and session-log entry, as usual. It remains the internal working log, not user docs.

### 8. Name

The product is called **PitchLab**, matching the GitHub repo. Use it in the README heading, the tour welcome and the page `<title>`. **Builder's call.** Today the page title says "Business cases" and the root package is `business-case-gen`. Internal package names (`@bcg/*`) stay as they are.

## Left to the builder

- Exact chapter and step copy, within the content above. It should be plain, short, second-person, and free of internal jargon (no "R13" or "gate.v2").
- Component and file names, the step-definition shape, the driver.js theming to match `globals.css` in light and dark, and how "action" completion is detected.
- The validation job table's exact columns, and the worker's interleaving order.
- The example case's subject matter and wording, within the rules in §4.
- How the tour chooses "your first real case" versus the example.

## Done when

- A fresh install, with an empty database apart from the example, walks through all eight chapters at desktop and 375px widths with no dead-ends. Covered by component tests of the step machine, plus a manual check by the owner.
- The anchor-coverage test, the static-text guard, the glossary sync test and the example-data guard (reserved domains only) pass.
- Validation jobs are queued from the UI, claimed by the worker and recorded, with tests against PGlite and a mocked `runValidation`.
- All existing suites, the typecheck, the build and the bundle check are green, and the docs are merged.
