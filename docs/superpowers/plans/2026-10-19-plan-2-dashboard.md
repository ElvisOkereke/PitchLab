# Plan 2: Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. TDD per task (failing test first, capture RED). No live LLM calls in tests. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A password-protected, phone-friendly web dashboard for the single owner. It shows every case on a pipeline board, lets the owner open a case (7 tabs), score it, move it between stages, overturn kills, track outreach, queue runs and edit sender/landing settings. A minimal `gen worker` executes runs queued from the UI.

**Architecture:** New workspace `apps/web` (Next.js 16 App Router, React 19, TypeScript strict, plain CSS) that imports `@bcg/core` as TypeScript source. All DB reads and writes the dashboard needs live in `packages/core/src/dashboard/` as plain functions taking `db`, so they are tested with core's PGlite helper and the CLI can reuse them. The web app only adds auth, form parsing and rendering. The dashboard and the worker share one real Postgres (`DATABASE_URL`). PGlite is single-process, so it cannot be shared. A one-time script copies the local PGlite data into Postgres. Every mutation is a Server Action that checks the session and the request origin, then validates its input with zod.

**Tech Stack:** Next.js `16.2.x` (16.2.9 checked against the docs on 2026-10-19), React/React DOM `19.2.x`, `jose` 6 (HS256 session JWT), Node `crypto.scrypt` (no native deps), `server-only`, zod 4 (already in core), Drizzle + `pg`, Vitest 5 + `@testing-library/react` + `jsdom` + `@vitejs/plugin-react` + `vite-tsconfig-paths`, Docker image `pgvector/pgvector:pg16`.

**Spec:** `docs/superpowers/specs/2026-10-17-business-case-generator-design.md` §6.2 (stages), §6.4 (scoring), §7 (dashboard), §8 (data model), §10 (hosting). Context: `docs/CONTEXT.md`. Next plan: `docs/superpowers/plans/2026-10-19-plan-3-validation-pack.md`.

**Notation:** **[Controller's call]** = a default chosen by the controlling agent. **[Claude's call]** = a default chosen while writing this plan. The owner can override either.

**Out of scope (say so in the docs):** the taste-learning/feedback loop, continuous mode, scheduling, spend caps, pg-boss, run leases, deployment (Railway, Cloudflare), landing-page publishing and the public form endpoint, sending email, multi-user, per-message live run logs, regenerating a section, generating the validation pack from the UI (use `gen validate`), PDF export, editing lenses, markets or models.

## Prerequisites and ordering

- **Plan 3 first.** [Claude's call] Plan 2 reads and writes Plan 3's tables (`settings`, `validation_packs`, `prospects`, `outreach_drafts`, `outreach_events`, `suppressions`, `landing_pages`) and calls Plan 3's `getSetting`/`setSetting`/`SENDER_KEYS`, `markOutreach`, `outreachCounts` and `computeChecklistStatus`. Start Plan 2 after Plan 3 is merged. If it is not, Task 1 pulls forward Plan 3 Task 1 (schema + migration + `settings.ts`) and the tracking helpers from Plan 3 Task 5, with Plan 3's exact signatures and tests, and marks them done in Plan 3.
- Work on a new branch `plan-2-dashboard` cut from `main`.
- New migrations take the next free number after Plan 3's (expected `0005`).

## Global Constraints

- All earlier rulings bind. **R13:** escape all case/LLM/web text at render. In React this means never using `dangerouslySetInnerHTML` and never building HTML strings. **R20:** writes are idempotent where re-run is possible, and multi-row writes run in one transaction.
- **Secrets:** only `.env` or the platform's secret store. No `NEXT_PUBLIC_*` variables exist in this plan. Every module that reads env, the DB or auth starts with `import 'server-only'`. Passwords, hashes, secrets and `DATABASE_URL` are never rendered, logged or returned in an error message.
- **Links:** only `http:`/`https:` URLs become `<a>`, always with `target="_blank" rel="noopener noreferrer nofollow"`. Anything else renders as plain text.
- **Auth everywhere:** `proxy.ts` (Next 16's renamed middleware; it runs on Node and the runtime cannot be changed) redirects unauthenticated requests to `/login`. As a second layer, every page layout calls `requireOwner()` and every Server Action calls `requireOwnerAction()` first.
- **Bounded queries:** every list query has a hard `limit` (constants in Task 4/5). Page numbers and sizes are zod-clamped. Board and list queries never select `embedding` columns or full `sections` when they only need one field.
- **Raw SQL:** only `sql\`\`` templates with bound parameters. No `sql.raw` in `packages/core/src/dashboard`, `packages/core/src/worker.ts` or `apps/web` (enforced by a test).
- **Time:** "today" and "this week" mean America/Toronto days, with weeks starting Monday. [Claude's call]
- **CSS:** plain CSS with variables. Light and dark via `prefers-color-scheme`, mobile-first, 16px gutters, base text ≥16px, no horizontal page scroll at 360px width, tap targets ≥44px. No UI framework. [Controller's call] Eight views of forms and tables do not justify a framework's weight.
- The repo path contains spaces. Quote paths in scripts. Files use LF endings (`.gitattributes`).
- **TypeScript version:** the root has `typescript@7.0.2` (native port), which ships no JS compiler API. Next's build type check needs that API. So `apps/web` pins `typescript@~5.9` as a devDependency (npm nests it under `apps/web/node_modules`), and `apps/web`'s `typecheck` script uses it. [Claude's call] Fallback if that fails: set `typescript.ignoreBuildErrors: true` and rely on `npm run typecheck -w apps/web`.
- Commits end with the committing agent's `Co-Authored-By` trailer.

## Review Focus (security; each item has a named test)

1. **Auth bypass on any route or Server Action.** `proxyDecision` redirects every path except `/login` and static assets (`test/auth/proxy-decision.test.ts`). Every exported action rejects a request with no session and leaves the DB unchanged (`test/actions/all-actions-require-session.test.ts`, which iterates every export of `apps/web/actions/*`). Acceptance (Task 16) curls every route without a cookie.
2. **Session forgery or fixation.** Tokens signed with another secret, `alg: none`, an expired token, a tampered payload or `sub !== 'owner'` all verify to `null`. Login always issues a fresh token, and logout sends `Max-Age=0` (`test/auth/session.test.ts`). Rotating `SESSION_SECRET` logs out every device. This is the documented revocation path.
3. **Open redirect after login.** `safeNext` maps `//evil.com`, `/\evil.com`, `https://evil.com`, `/%2F%2Fevil.com`, `javascript:alert(1)`, `''` and non-strings to `/`, and keeps `/cases/a-b?tab=score` (`test/auth/safe-next.test.ts`).
4. **XSS via case text.** Rendering every tab with a hostile fixture (`<img src=x onerror=alert(1)>`, `<script>`, `javascript:` URLs, `"onmouseover=`) produces only text nodes, and no `img`/`script` elements or `javascript:` hrefs (`test/components/hostile-case.test.tsx`). A guard test fails if `dangerouslySetInnerHTML` or `sql.raw` appears anywhere in `apps/web` or `packages/core/src/dashboard` (`test/guards.test.ts`).
5. **CSRF on Server Actions.** Next rejects a mismatched `Origin` but only warns when `Origin` is missing, so `isSameOrigin` also rejects a missing `Origin`, a `null` origin and a host mismatch, and accepts `ALLOWED_ORIGINS` (`test/auth/origin.test.ts`). The cookie is `SameSite=Lax` and `HttpOnly` (session test).
6. **Unbounded queries and pagination.** `listRuns({ pageSize: 10_000 })` returns ≤50 rows. Prospects are ≤100 per page. A negative or non-numeric `page` becomes 1 (`packages/core/test/dashboard/limits.test.ts`).
7. **Secrets in client bundles.** There are no `NEXT_PUBLIC_` names in the source (guard test). After `next build`, `scripts/check-bundle.ts` scans `.next/static` for the real `SESSION_SECRET`, `OWNER_PASSWORD_HASH` and the DB password and expects 0 hits (Task 16).
8. **SQL injection / raw fragments.** Drizzle binds every value. The remaining `sql` fragments are the worker's claim query, the board's JSON path and count aggregates, and every one uses constants or bound parameters (guard test for `sql.raw`). Sort and filter keys go through zod allowlists, so `sort=title;drop table cases` falls back to the default (`leaderboard.test.ts`).
9. **Rate-limit bypass via `X-Forwarded-For` spoofing.** With `TRUST_PROXY_HOPS=0` (default) the header is ignored and all attempts share one bucket. With `N>0` the client key is the Nth entry from the right, so client-supplied left entries cannot change it. A global ceiling of 30 failures per 10 min applies regardless (`test/auth/client-ip.test.ts`, `rate-limit.test.ts`). Railway sets `TRUST_PROXY_HOPS=1` (Plan 4 verifies this).
10. **A run queued with an absurd config.** `QueueRunInputSchema` rejects `ideaCount` 0/31/1e9/"abc", `advanceCount > ideaCount`, an 11th advance, unknown lens ids, sectors outside the market's list, and idea text over 20,000 chars. A 4th queued run is refused. The worker re-validates the stored config with `RunConfigSchema` and fails the run instead of executing it (`runs.test.ts`, `worker.test.ts`).

---

## File Structure

```
docker-compose.yml                       # local Postgres (pgvector/pgvector:pg16), 127.0.0.1:5433
.env.example                             # + web/auth vars (names only)
package.json                             # scripts: web, worker, db:copy, test (core + web)
packages/core/
  package.json                           # + "exports": { "./*": "./src/*.ts" }, script db:copy
  drizzle/0005_stage_events.sql          # generated
  scripts/pglite-to-postgres.ts          # CLI wrapper around copyDatabase()
  src/case/links.ts                      # safeHttpUrl()
  src/case/review.ts                     # claim flags, "For you to check", competitor checks (shared by export + web)
  src/case/export-markdown.ts            # modified: formats review.ts output
  src/db/schema.ts                       # + stageEventKind, stageEvents
  src/db/test-db.ts                      # createTestDb() (test/helpers/db.ts re-exports it)
  src/db/copy.ts                         # tableCopyOrder(), copyDatabase()
  src/dashboard/criteria.ts              # OWNER_CRITERIA, scoreSummary()
  src/dashboard/stage.ts                 # MoveStageInputSchema, moveStage()
  src/dashboard/board.ts                 # listBoard(), keyMetric(), listGateKills()
  src/dashboard/case-view.ts             # getCaseView()
  src/dashboard/leaderboard.ts           # listLeaderboard(), sortLeaderboard(), LeaderSortSchema
  src/dashboard/command.ts               # needsYou(), spendSince(), torontoDayStart(), torontoWeekStart()
  src/dashboard/scores.ts                # OwnerScoresInputSchema, saveOwnerScores()
  src/dashboard/runs.ts                  # RunConfigSchema, QueueRunInputSchema, queueRun(), requeueRun(), queueGateKillRerun(), listRuns()
  src/dashboard/validate-view.ts         # getValidateView()
  src/dashboard/settings.ts              # EDITABLE_SETTING_KEYS, WorkerStatus, readWorkerStatus()
  src/pipeline/deps.ts                   # buildStageDeps() (extracted from cli.ts)
  src/worker.ts                          # claimNextRun(), runWorker(), workerStatus()
  src/cli.ts                             # + `gen worker`
apps/web/
  package.json  next.config.ts  tsconfig.json  vitest.config.ts  proxy.ts
  app/layout.tsx  app/globals.css
  app/login/{page.tsx,login-form.tsx}
  app/(app)/layout.tsx                   # nav tabs + logout; calls requireOwner()
  app/(app)/page.tsx                     # Board
  app/(app)/leaderboard/page.tsx
  app/(app)/command/page.tsx
  app/(app)/runs/page.tsx
  app/(app)/settings/page.tsx
  app/(app)/cases/[slug]/{page.tsx,error.tsx,not-found.tsx}
  app/(app)/cases/[slug]/export.md/route.ts
  actions/{auth,stage,scores,outreach,runs,settings}.ts
  components/{case-card,stage-move-form,status-chip,external-link,text-block,score-form,queue-run-form,settings-form,mark-outreach-form,auto-refresh,nav}.tsx
  components/tabs/{summary,evidence,numbers,competitors,pitch,validate,score}.tsx
  lib/env.ts  lib/db.ts  lib/form.ts
  lib/auth/{password,session,rate-limit,client-ip,safe-next,origin,proxy-decision,require-owner}.ts
  scripts/{hash-password.ts,acceptance.ts,check-bundle.ts}
  test/stubs/server-only.ts  test/**/*.test.ts(x)
docs/dashboard.md                        # run locally, phone access, env vars, security notes
```

---

### Task 1: Core package surface for the web app

**Files:**
- Modify: `packages/core/package.json`, `packages/core/test/helpers/db.ts`
- Create: `packages/core/src/db/test-db.ts`
- Test: `packages/core/test/db/exports.test.ts`

**Interfaces:**
- `packages/core/package.json` gains `"exports": { "./*": "./src/*.ts" }`. Consumers import subpaths such as `@bcg/core/db/schema` and `@bcg/core/dashboard/board`. There is no barrel file, so the web bundle never pulls in the LLM SDKs through an index. [Claude's call] This works with `moduleResolution: Bundler` (core, web) and with tsx.
- `createTestDb(): Promise<Db>`: in-memory PGlite, migrated and seeded (the body of today's `testDb`). `test/helpers/db.ts` re-exports it as `testDb` and keeps its other helpers.
- Prerequisite check (see above): confirm that `schema.ts` exports Plan 3's tables, and that `@bcg/core/validation/settings` and the tracking helpers exist. If `markOutreach`/`outreachCounts` live in `validation/outreach.ts` next to LLM code, move them to `validation/tracking.ts` and re-export them from `outreach.ts`, so the web bundle does not import the router.

- [ ] **Step 1: Write the failing test**

```ts
it('resolves core subpaths through the package name', async () => {
  const { cases } = await import('@bcg/core/db/schema');
  const { createTestDb } = await import('@bcg/core/db/test-db');
  const db = await createTestDb();
  expect(await db.select().from(cases)).toEqual([]);
});
```

- [ ] **Step 2:** Run `npm test -w packages/core -- exports`. Expected: FAIL (no exports map / module).
- [ ] **Step 3:** Implement. Run `npm install` at the root so the workspace link exists.
- [ ] **Step 4:** Run the full core suite and `npx tsc --noEmit -p packages/core`. Expected: all PASS.
- [ ] **Step 5:** Commit `chore(core): package exports and shared test DB for the dashboard`.

---

### Task 2: Shared case review logic (export and web agree)

**Files:**
- Create: `packages/core/src/case/review.ts`, `packages/core/src/case/links.ts`
- Modify: `packages/core/src/case/export-markdown.ts` (move logic out; output byte-identical)
- Test: `packages/core/test/case/review.test.ts`, `packages/core/test/case/export-markdown.test.ts` (snapshot added first, assertions unchanged)

**Interfaces** (moved from `export-markdown.ts`, returning **raw, unescaped** text; each renderer escapes):
- `type ClaimStatus = ClaimRow['verified']`; `STATUS_EMOJI: Record<ClaimStatus,string>` (✅ ❌ ⚠️ 🔍 ⏳); `STATUS_LABEL: Record<ClaimStatus,string>` (`'✅ verified'`, …)
- `type LinkFlags = { signal; competitor; competitorPricing; input: Map<string, ClaimStatus> }`; `linkFlags(claims: ClaimRow[]): LinkFlags` (today's `flagsOf`, worst status wins)
- `signalStatus(f, s: { url: string; quote: string }): ClaimStatus | undefined`; `inputStatus(f, label: string, value: number): ClaimStatus | undefined`
- `type CheckCell = { status: ClaimStatus | null; text: string }`; `competitorChecks(f, x: { url; name; pricing }): { product: CheckCell; pricing: CheckCell }`. `text` is exactly what the export prints today (e.g. `'🔍 not published — check'`, `'✅ verified (old check: name + pricing)'`, `'not checked'`).
- `type ForYouItem = { label: string; text: string; url: string; reason: string; count: number }`; `forYouToCheck(sections: CaseSections, claims: ClaimRow[], f?: LinkFlags): { state: 'no_claims' | 'all_clear' | 'items'; items: ForYouItem[] }`. `no_claims` = no claim rows (items may still be listed). `all_clear` = claims exist and no items.
- `cleanQuote(s: string): string` (`decodeEntities` + `stripInvisible`, unescaped)
- `safeHttpUrl(url: string): URL | null` (`links.ts`). The export's `link()` uses it.

- [ ] **Step 1:** Before touching code, add `expect(caseToMarkdown(...)).toMatchSnapshot()` for every existing fixture in `export-markdown.test.ts`. Run it to record the snapshots and commit them in this task.
- [ ] **Step 2: Write the failing tests** (`review.test.ts`)

```ts
it('lists unreachable, needs_review and unverified claims, never unsupported', ...);   // labels: 'Claim', 'Number input', ...
it('merges items sharing url + reason + label and counts them', () => { expect(r.items[0]!.count).toBe(2); });
it('lists a competitor whose pricing has no figure', () => { expect(r.items).toContainEqual(expect.objectContaining({ label: 'Competitor pricing', reason: 'pricing not published — check it yourself' })); });
it('state is no_claims with zero claim rows and all_clear when every source is settled', ...);
it('returns raw text (no escaping)', () => { expect(item.text).toBe('<b>x</b>'); });
it('competitorChecks: a stored pricing claim beats the price predicate', ...);
it('safeHttpUrl accepts http(s) only', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'mailto:a@b.c', '/relative', 'notaurl']) expect(safeHttpUrl(bad)).toBeNull();
  expect(safeHttpUrl('https://a.test/x')?.hostname).toBe('a.test');
});
```

- [ ] **Step 3:** Run. Expected: FAIL. **Step 4:** Implement `review.ts`/`links.ts`, then reduce `export-markdown.ts` to formatting (`line`, `cell`, `block`, `link` stay there).
- [ ] **Step 5:** Run the full core suite. Expected: all PASS, snapshots unchanged, and the old assertions untouched.
- [ ] **Step 6:** Commit `refactor(case): shared review logic for the export and the dashboard`.

---

### Task 3: `stage_events` table and stage moves

**Files:**
- Modify: `packages/core/src/db/schema.ts`; generate `packages/core/drizzle/0005_stage_events.sql` (`npx drizzle-kit generate`, run in `packages/core`)
- Create: `packages/core/src/dashboard/stage.ts`
- Test: `packages/core/test/dashboard/stage.test.ts`

**Interfaces:**
- Schema (additive). Nothing is added to `cases`: `killReason` already exists, and history lives in events.
  ```ts
  export const stageEventKind = pgEnum('stage_event_kind', ['move', 'overturn', 'kill']);
  export const stageEvents = pgTable('stage_events', {
    id: id(), caseId: uuid('case_id').notNull().references(() => cases.id),
    fromStage: caseStage('from_stage').notNull(), toStage: caseStage('to_stage').notNull(),
    kind: stageEventKind('kind').notNull(), note: text('note'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  }, (t) => [index('stage_events_case_at_idx').on(t.caseId, t.at)]);
  ```
- `type CaseStage = (typeof caseStage.enumValues)[number]`; `type StageEventKind = (typeof stageEventKind.enumValues)[number]`
- `MoveStageInputSchema = z.object({ caseId: z.uuid(), from: z.enum(caseStage.enumValues), to: z.enum(caseStage.enumValues), note: z.string().trim().max(500).optional() })`
- `moveStage(db, input: MoveStageInput): Promise<{ ok: true; kind: StageEventKind } | { ok: false; reason: 'not_found' | 'stale' | 'same_stage' | 'note_required' }>`
  - `kind` = `kill` when `to === 'killed'`, `overturn` when `from === 'killed'`, otherwise `move`. **Any move out of Killed counts as an overturn** [Claude's call], so the strong feedback signal is not lost when the owner uses the select instead of the button.
  - `kill` requires a non-empty note, which is stored as `cases.killReason`. An overturn clears `killReason`.
  - One transaction: `UPDATE cases SET stage, killReason, updatedAt WHERE id = $id AND stage = $from RETURNING`. Zero rows → `stale` (or `not_found` when the id is absent). Then insert the event.
- "Overturn kill" = `moveStage({ from: 'killed', to: 'new' })`.

- [ ] **Step 1: Write the failing tests**

```ts
it('new → validating writes one move event', async () => { expect(r).toEqual({ ok: true, kind: 'move' }); expect(events).toHaveLength(1); });
it('kill needs a note and stores it as killReason', async () => {
  expect(await moveStage(db, { caseId, from: 'new', to: 'killed' })).toEqual({ ok: false, reason: 'note_required' });
  await moveStage(db, { caseId, from: 'new', to: 'killed', note: 'too crowded' });
  expect((await getCase(db, caseId)).killReason).toBe('too crowded');
});
it('moving out of killed is an overturn and clears killReason', ...);   // kind 'overturn', killReason null
it('a stale from-stage changes nothing', async () => { expect(r).toEqual({ ok: false, reason: 'stale' }); expect(events).toHaveLength(0); });
it('same stage is rejected; unknown id is not_found', ...);
```

- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement and generate the migration. Verify it applies on a **temporary copy** of `.data/pglite`, never the real one.
- [ ] **Step 4:** Run. Expected: PASS. **Step 5:** Commit `feat(db): stage_events and logged stage moves`.

---

### Task 4: Read models for board, case view and leaderboard

**Files:**
- Create: `packages/core/src/dashboard/{criteria.ts,board.ts,case-view.ts,leaderboard.ts}`
- Test: `packages/core/test/dashboard/{criteria,board,case-view,leaderboard}.test.ts`

**Interfaces:**
- `criteria.ts`: `OWNER_CRITERIA = criterion.enumValues` (the 7 `CRITERIA` + `gut`); `type OwnerCriterion`; `CRITERION_LABEL: Record<OwnerCriterion,string>` (Pain severity, Buyer ROI clarity, Evidence strength, Speed to market, Autonomy, Novelty/non-generic, Reachability, Your gut).
  `scoreSummary(rows: Pick<ScoreRow,'criterion'|'value'|'note'|'by'|'createdAt'>[]): { ai: number | null; owner: number | null; latest: Partial<Record<OwnerCriterion, { ai?: { value: number; note: string }; owner?: { value: number; note: string } }>> }`. Uses the latest row per (by, criterion). `ai` = mean of the 7 AI criteria present. `owner` = mean of the owner criteria present, including `gut`. Both are rounded to 1 dp, or `null` when there are none.
- `board.ts`:
  - `BOARD_LIMIT = 200` (per stage). `type BoardCard = { id; slug; title; stage: CaseStage; aiScore: number | null; ownerScore: number | null; metric: string; updatedAt: Date }`.
  - `listBoard(db, f: { lensId?: string; minAi?: number }): Promise<{ columns: Record<CaseStage, BoardCard[]>; counts: Record<CaseStage, number> }>`. `counts` reflect the filters but not the limit. It selects ROI via `sql<number|null>\`(${cases.sections} #>> '{numbers,results,buyer,roiMultiple}')::float8\`` (constant path), not full `sections`. Ideas carry no sector, so the filters are lens and minimum AI score only.
  - `keyMetric(x: { roiMultiple: number | null; outreach?: { sent: number; prospects: number } }): string` → `'12/50 emailed'` when prospects > 0, else `'ROI 1.07×'`, else `'ROI n/a'`.
  - `listGateKills(db, limit = 50): Promise<{ ideaId; title; oneLiner; createdAt; failed: { check; reasoning }[] }[]>`: ideas with status `gated_out`, newest first, with their failed verdicts (latest per check). These are shown read-only under the Killed column (spec §5.4: "Killed ideas go to the Killed column with their reason").
- `case-view.ts`: `getCaseView(db, slug): Promise<CaseView | null>` where `CaseView = { case: CaseRow; claims: ClaimRow[]; scores: ScoreRow[]; gate: GateVerdictRow[]; events: StageEventRow[]; lensName: string | null }`. The slug must match `/^[a-z0-9-]{1,120}$/`, else `null`. `gate` has the latest row per check, failed first. `events` has the latest 20.
- `leaderboard.ts`: `LEADERBOARD_LIMIT = 500`; `type LeaderRow = { slug; title; stage; ai: Partial<Record<Criterion, number>>; owner: Partial<Record<OwnerCriterion, number>>; aiTotal: number | null; ownerTotal: number | null }`; `listLeaderboard(db): Promise<LeaderRow[]>`; `LeaderSortSchema = z.object({ key: z.enum(['ai', 'owner', 'title', ...OWNER_CRITERIA]).catch('ai'), by: z.enum(['ai', 'owner']).catch('ai'), dir: z.enum(['asc', 'desc']).catch('desc') })`; `sortLeaderboard(rows, s: LeaderSort): LeaderRow[]` (nulls last in both directions; `gut` always reads `owner`).

- [ ] **Step 1: Write the failing tests** (key assertions)

```ts
it('scoreSummary uses the latest row per criterion and rounds to 1 dp', () => { expect(s.ai).toBe(3.4); expect(s.owner).toBeNull(); });
it('board groups by stage, counts honour filters, cards carry metric', async () => {
  expect(b.counts).toEqual({ new: 2, validating: 1, pilot: 0, live: 0, killed: 1 });
  expect(b.columns.new[0]!.metric).toBe('ROI 1.07×');
});
it('keyMetric prefers outreach progress', () => { expect(keyMetric({ roiMultiple: 2, outreach: { sent: 12, prospects: 50 } })).toBe('12/50 emailed'); });
it('listGateKills returns failed checks with reasons, newest first', ...);
it('getCaseView rejects a bad slug and orders failed gate checks first', ...);
it('sortLeaderboard: nulls last both ways; invalid sort falls back to ai desc', () => {
  expect(LeaderSortSchema.parse({ key: 'title;drop table cases' }).key).toBe('ai');
});
```

- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(dashboard): board, case view and leaderboard read models`.

---

### Task 5: Owner scores, run queue and command-center data

**Files:**
- Create: `packages/core/src/dashboard/{scores.ts,runs.ts,command.ts,validate-view.ts,settings.ts}`
- Modify: `packages/core/src/pipeline/types.ts` (add optional `overturnOfIdeaId?: string` to `RunConfig`)
- Test: `packages/core/test/dashboard/{scores,runs,command,validate-view,limits}.test.ts`

**Interfaces:**
- `scores.ts`: `OwnerScoresInputSchema = z.object({ caseId: z.uuid(), entries: z.array(z.object({ criterion: z.enum(OWNER_CRITERIA), value: z.number().int().min(1).max(5), note: z.string().trim().max(1000).default('') })).min(1).max(8) }).refine(unique criteria)`. `saveOwnerScores(db, input): Promise<{ ok: true; saved: number } | { ok: false; reason: 'not_found' }>`. In one transaction it deletes the `by='owner'` rows for exactly the submitted criteria and inserts the new ones (`model`/`promptVersion` null). Criteria left blank keep their previous owner row. Only the owner path writes `gut`, and AI rows are never touched.
- `runs.ts`:
  - `RunConfigSchema` (zod mirror of `RunConfig`, bounds: `ideaCount` 1–30, `advanceCount` 1–10, `maxSearchesPerCall` 1–10, `researchSearchesPerSector` 1–6 optional, `minSignals` 1–10, `dedupeThreshold` 0.5–0.99, `sectors` ≤8 × ≤100 chars, `lensIds` ≤8, `ideaText` ≤20,000, `marketId` ≤50, `overturnOfIdeaId` uuid optional). It has a compile-time `Same<z.infer<…>, RunConfig>` check, like `case/schema.ts`.
  - `QueueRunInputSchema`: a discriminated union on `seedType`. `open`: `{}`. `sector`: `sectors` 1–8, each must be in the market's `sectors` (checked in `queueRun`). `lens`: `lensIds` 1–8, each an active lens. `idea`: `ideaText` 50–20,000 chars. All variants share `ideaCount` (int 1–30, default 12) and `advanceCount` (int 1–10, default 3), refined so `advanceCount ≤ ideaCount`. Out-of-range values are **rejected with a message, not silently clamped** [Claude's call].
  - `MAX_QUEUED = 3`. `queueRun(db, input): Promise<{ ok: true; id: string } | { ok: false; reason: 'too_many_queued' | 'unknown_lens' | 'unknown_sector'; detail?: string }>`. It inserts `runs` with `status 'queued'` and `config = defaultRunConfig({ marketId: 'ca-us', ...input })`.
  - `requeueRun(db, runId): Promise<{ ok: boolean; reason?: 'not_found' | 'not_failed' }>`: `failed → queued` only. The worker's `executeRun` resumes from the failed stage.
  - `queueGateKillRerun(db, ideaId)`: idea must be `gated_out`. It queues a `seedType 'idea'` run whose `ideaText` is built from the idea's title, one-liner, buyer, problem, solution and functional gap, with `overturnOfIdeaId = ideaId`. Owner ideas keep the advisory gate and bypass dedupe/screen, matching the owner's 2026-10-19 workflow. [Claude's call]
  - `RUNS_PAGE_MAX = 50`. `listRuns(db, { page, pageSize }): Promise<{ rows: (RunRow & { caseCount: number; stages: { stage; status; startedAt; finishedAt }[] })[]; total: number }>`. `pageSize` is clamped to 1–50 and `page` to ≥1. `config.ideaText` is cut to 200 chars in the returned rows.
- `command.ts`:
  - `torontoDayStart(now: Date): Date`; `torontoWeekStart(now: Date): Date` (Monday 00:00 America/Toronto, via `Intl.DateTimeFormat`, so no SQL time-zone fragments).
  - `spendSince(db, since: Date): Promise<{ llmUsd: number; dataUsd: number; llmCalls: number }>` (sums `llm_calls.costUsd` and `data_calls.costUsd`).
  - `needsYou(db, now: Date): Promise<NeedsYouItem[]>` (≤50). `NeedsYouItem = { kind: 'score' | 'advisory' | 'reply' | 'failed_run'; label: string; href: string; at: Date }`.
    - `score`: case not killed with no owner score.
    - `advisory`: case with non-empty `gateFlags` and no stage event yet ("keep or kill?").
    - `reply`: prospect whose status is `sent` and whose last outreach event is >3 days old ("check inbox, log reply").
    - `failed_run`: run failed in the last 7 days.
- `validate-view.ts`: `getValidateView(db, caseId, { page }): Promise<ValidateView>` with `{ pack: ValidationPackRow | null; prospects: { rows; total }; drafts: Map<prospectId, OutreachDraftRow[]>; events: OutreachEventRow[] (latest 50); landing: { copy; publishedUrl; updatedAt; htmlBytes: number } | null; checklist: ChecklistStatus[] | null; counts: OutreachCounts }`. Prospects are capped at 100 per page. The landing HTML itself is never returned.
- `settings.ts`: `EDITABLE_SETTING_KEYS = [...SENDER_KEYS, ...LANDING_KEYS]`. Add `LANDING_KEYS = ['landing.privacyContact', 'landing.formEndpoint']` to `validation/settings.ts` if Plan 3 did not define it. `SettingsInputSchema` (each value a trimmed string ≤500; `landing.formEndpoint` empty or an https URL). `WORKER_STATUS_KEY = 'worker.status'`. `type WorkerStatus = { at: string; providers: { llm: boolean; github: boolean; stackexchange: boolean; places: boolean }; models: Record<ModelStage, string> }`. `readWorkerStatus(db): Promise<WorkerStatus | null>`.

- [ ] **Step 1: Write the failing tests** (key assertions)

```ts
it('saveOwnerScores replaces only the submitted owner criteria in one transaction', async () => {
  await saveOwnerScores(db, { caseId, entries: [{ criterion: 'gut', value: 4, note: 'a' }, { criterion: 'pain', value: 3, note: '' }] });
  await saveOwnerScores(db, { caseId, entries: [{ criterion: 'gut', value: 5, note: 'b' }] });
  expect(ownerRows.map((r) => [r.criterion, r.value])).toEqual(expect.arrayContaining([['gut', 5], ['pain', 3]]));
  expect(ownerRows).toHaveLength(2); expect(aiRowsBefore).toEqual(aiRowsAfter);
});
it('QueueRunInputSchema bounds', () => {
  for (const ideaCount of [0, 31, 1e9, 'abc']) expect(QueueRunInputSchema.safeParse({ seedType: 'open', ideaCount }).success).toBe(false);
  expect(QueueRunInputSchema.safeParse({ seedType: 'open', ideaCount: 5, advanceCount: 6 }).success).toBe(false);
  expect(QueueRunInputSchema.safeParse({ seedType: 'idea', ideaText: 'x'.repeat(20_001) }).success).toBe(false);
});
it('queueRun inserts a queued run with defaultRunConfig, refuses a 4th queued run and unknown lens/sector', ...);
it('requeueRun only moves failed → queued', ...);
it('queueGateKillRerun queues an idea run with overturnOfIdeaId and rejects non-gated_out ideas', ...);
it('torontoDayStart handles the DST change', () => {
  expect(torontoDayStart(new Date('2026-11-01T12:00:00Z')).toISOString()).toBe('2026-11-01T04:00:00.000Z');
  expect(torontoDayStart(new Date('2026-11-02T12:00:00Z')).toISOString()).toBe('2026-11-02T05:00:00.000Z');
  expect(torontoWeekStart(new Date('2026-10-21T12:00:00Z')).toISOString()).toBe('2026-10-19T04:00:00.000Z');
});
it('needsYou lists unscored cases, advisory cases, stale sent prospects and recent failed runs', ...);
it('getValidateView returns empty state when no pack exists and never includes landing html', ...);
// limits.test.ts
it('caps page sizes', async () => { expect((await listRuns(db, { page: -3, pageSize: 10_000 })).rows.length).toBeLessThanOrEqual(50); });
```

- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run the core suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(dashboard): owner scores, run queue, command-center and validate data`.

---

### Task 6: `gen worker` (minimal queued-run executor)

**Files:**
- Create: `packages/core/src/pipeline/deps.ts`, `packages/core/src/worker.ts`
- Modify: `packages/core/src/cli.ts` (use `buildStageDeps`; add `worker`), root `package.json` (`"worker": "npm run gen -w packages/core -- worker"`)
- Test: `packages/core/test/worker.test.ts`

**Interfaces:**
- `buildStageDeps(env: Env, db: Db, config: RunConfig, log: (m: string) => void): Promise<StageDeps>`. This moves the market lookup, `buildRouter` and `buildSources` out of `cli.ts#execute`. The CLI's behaviour stays the same.
- `claimNextRun(db): Promise<string | null>`, one statement:
  `UPDATE runs SET status = 'running', started_at = coalesce(started_at, now()) WHERE id = (SELECT id FROM runs WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id`
- `workerStatus(env: Env, models: Record<ModelStage,string>): WorkerStatus`: booleans for `LLM_API_KEY`, `GITHUB_TOKEN`, `STACKEXCHANGE_KEY` and `GOOGLE_PLACES_API_KEY` being set, plus resolved model ids. **No values.**
- `runWorker(o: { db: Db; intervalMs: number; signal: AbortSignal; execute: (runId: string) => Promise<'succeeded' | 'failed'>; heartbeat: () => Promise<void>; log: (m: string) => void; once?: boolean }): Promise<void>`.
  - Loop: heartbeat, then claim. When a run is claimed: `RunConfigSchema.safeParse(row.config)`. If it fails, set status `failed` with `error = 'invalid run config: <issues>'` and skip the run. Otherwise call `execute`.
  - When nothing is claimed, sleep `intervalMs` (abortable). Exit when `signal` aborts while idle, or after one pass when `once`.
- CLI: `gen worker [--interval <seconds>] [--once]` (default 10 s, minimum 2).
  - Open the DB (migrations + seed), then loop. `execute` = `executeRun(await buildStageDeps(...), id)` and prints the same summary as `gen run`. `heartbeat` = `setSetting(db, WORKER_STATUS_KEY, workerStatus(...))`.
  - First SIGINT: "stopping after the current run" (exit immediately if idle). Second SIGINT: exit now. A run killed this way stays `running`, and `gen resume <id>` recovers it. Leases come in Plan 4 (state this in the docs).

- [ ] **Step 1: Write the failing tests**

```ts
it('two concurrent claims never take the same run', async () => {
  await insertRun(db, cfg);
  const [a, b] = await Promise.all([claimNextRun(db), claimNextRun(db)]);
  expect([a, b].filter(Boolean)).toHaveLength(1);
});
describe.runIf(process.env.TEST_DATABASE_URL)('on real Postgres', () => {
  it('10 parallel claims over 3 queued runs return 3 distinct ids', ...);   // separate pool connections
});
it('executes queued runs oldest first and writes a heartbeat with no secret values', async () => {
  await runWorker({ ..., once: true, execute: async (id) => { seen.push(id); return 'succeeded'; } });
  expect(seen).toEqual([oldest]);
  expect(JSON.stringify(await readWorkerStatus(db))).not.toContain('test-key-value');
});
it('fails a queued run with an absurd stored config instead of executing it', async () => {
  // insert runs row with config.ideaCount = 1e9 → status 'failed', error /invalid run config/, execute not called
});
it('stops when the signal aborts while idle', ...);
```

- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run the core suite. Expected: PASS. Check `npm run gen -- worker --once` against an empty local DB. Expected output: `no queued runs` and exit 0.
- [ ] **Step 5:** Commit `feat(cli): gen worker executes queued runs`.

---

### Task 7: Local Postgres and the PGlite → Postgres copy

**Files:**
- Create: `docker-compose.yml`, `packages/core/src/db/copy.ts`, `packages/core/scripts/pglite-to-postgres.ts`
- Modify: `.env.example`, `packages/core/package.json` (`"db:copy": "tsx scripts/pglite-to-postgres.ts"`), root `package.json` (`"db:copy": "npm run db:copy -w packages/core --"`)
- Test: `packages/core/test/db/copy.test.ts`

**Interfaces:**
- `docker-compose.yml`: service `db`, `image: pgvector/pgvector:pg16`, `POSTGRES_USER=bcg`, `POSTGRES_PASSWORD=bcg_local_dev`, `POSTGRES_DB=bcg`, `ports: ["127.0.0.1:5433:5432"]` (bound to localhost; 5433 avoids clashing with any local Postgres) [Claude's call], named volume `bcg_pg`, healthcheck `pg_isready -U bcg`. The password is a local-only dev value, documented as such. Local URL: `postgres://bcg:bcg_local_dev@127.0.0.1:5433/bcg`.
- `tableCopyOrder(tables: PgTable[]): PgTable[]`: topological order by foreign keys from `getTableConfig` (parents first), so tables added later need no list edit.
- `copyDatabase(from: Db, to: Db, o?: { batchSize?: number; log?: (m: string) => void }): Promise<CopyReport>` where `CopyReport = { table: string; source: number; inserted: number; target: number; ok: boolean }[]`.
  - Copies every `pgTable` exported from `schema.ts`. Reads each table in pages ordered by primary key and inserts full rows, ids included, in batches (default 500) with `.onConflictDoNothing()`. That makes it idempotent and also skips unique-key duplicates.
  - `ok` = `target === source` after the copy. Ids are uuid/text, so no sequences need resetting.
- `assertSameMigrations(from: Db, to: Db): Promise<void>`: throws unless both `drizzle.__drizzle_migrations` tables hold the same hashes.
- Script: `npm run db:copy -- [--from pglite://.data/pglite] [--to <url>] [--dry-run]`.
  - `--to` defaults to `DATABASE_URL` and must be `postgres://` (anything else exits 2). Paths resolve against `INIT_CWD`.
  - Order: `runMigrations(to)`, then `assertSameMigrations`. On mismatch it exits 2 with `Local DB is behind the code: run any gen command once with DATABASE_URL=pglite://.data/pglite to migrate it`. **It never writes to the source.**
  - Then copy and print a table of per-table counts. Exit 1 if any table is not `ok`. Warn that no other process may have the PGlite DB open while it runs.

- [ ] **Step 1: Write the failing tests** (two in-memory PGlite DBs)

```ts
it('orders parents before children', () => {
  const order = tableCopyOrder(allTables).map(getTableName);
  expect(order.indexOf('runs')).toBeLessThan(order.indexOf('ideas'));
  expect(order.indexOf('cases')).toBeLessThan(order.indexOf('stage_events'));
  expect(order.indexOf('prospects')).toBeLessThan(order.indexOf('outreach_events'));
});
it('copies every table with ids, vectors and jsonb intact, and is idempotent', async () => {
  const r1 = await copyDatabase(src, dst, { batchSize: 2 });
  expect(r1.every((t) => t.ok)).toBe(true);
  expect((await dst.select().from(ideas))[0]!.embedding![0]).toBe(1);
  const r2 = await copyDatabase(src, dst);
  expect(r2.reduce((n, t) => n + t.inserted, 0)).toBe(0);
});
it('reports a mismatch when the target already holds extra rows', ...);   // ok false for that table
it('assertSameMigrations throws when the source is behind', ...);
```

- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(db): local Postgres compose file and PGlite → Postgres copy`.

---

### Task 8: `apps/web` scaffold

**Files:**
- Create: `apps/web/{package.json,next.config.ts,tsconfig.json,vitest.config.ts}`, `apps/web/app/{layout.tsx,globals.css}`, `apps/web/app/(app)/page.tsx` (placeholder), `apps/web/lib/{env.ts,db.ts}`, `apps/web/test/stubs/server-only.ts`
- Modify: root `package.json` (`"web": "npm run dev -w apps/web"`, `"test": "npm test -w packages/core && npm test -w apps/web"`), `.env.example`
- Test: `apps/web/test/env.test.ts`, `apps/web/test/guards.test.ts`

**Interfaces:**
- `apps/web/package.json`: name `@bcg/web`, `private`, `type: module`. Scripts: `dev: next dev`, `build: next build`, `start: next start`, `test: vitest run`, `typecheck: tsc --noEmit`, `hash-password: tsx scripts/hash-password.ts`, `acceptance: tsx scripts/acceptance.ts`, `check-bundle: tsx scripts/check-bundle.ts`.
  - deps: `next@^16.2.9 react@^19.2 react-dom@^19.2 jose@^6 server-only @bcg/core@*`, plus `@next/env` (same version as `next`).
  - devDeps: `typescript@~5.9 @types/react @types/react-dom vitest @vitejs/plugin-react vite-tsconfig-paths jsdom @testing-library/react @testing-library/dom`. Pick versions whose peer deps match Vitest 5's Vite major. Check `npm ls vite` after install.
- `next.config.ts`:
  - Calls `loadEnvConfig(<repo root>)` from `@next/env`, so the root `.env` is the single env file (no `apps/web/.env`).
  - `transpilePackages: ['@bcg/core']`, `serverExternalPackages: ['pg', '@electric-sql/pglite', '@electric-sql/pglite-pgvector']`, `turbopack.root` and `outputFileTracingRoot` = repo root.
  - `allowedDevOrigins` from `DEV_ORIGINS` (comma list of hostnames, e.g. the LAN IP).
  - `experimental.serverActions.allowedOrigins` from `ALLOWED_ORIGINS`.
  - `poweredByHeader: false`.
  - `headers()` for all routes: `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Robots-Tag: noindex, nofollow`.
- `tsconfig.json`: standalone (not extending the NodeNext base). `strict`, `target ES2023`, `lib [dom, dom.iterable, es2023]`, `module esnext`, `moduleResolution bundler`, `jsx` as Next writes it, `plugins [{ name: 'next' }]`, `paths { "@/*": ["./*"] }`. Commit whatever Next adjusts on the first `next dev`.
- `vitest.config.ts`: plugins `tsconfigPaths()` and `react()`. `environment: 'jsdom'` for `*.test.tsx`, `node` for `*.test.ts` (via `environmentMatchGlobs` or per-file `// @vitest-environment`). Alias `server-only` → `test/stubs/server-only.ts`. `testTimeout 30_000`.
- `lib/env.ts` (server-only): `webEnv(): WebEnv` (memoised, zod). Errors name variables, never values.
  `WebEnv = { DATABASE_URL: string /* postgres:// or postgresql:// only */; OWNER_PASSWORD_HASH: string /* /^scrypt:\d+:\d+:\d+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/ */; SESSION_SECRET: string /* ≥32 chars */; TRUST_PROXY_HOPS: number /* int 0–3, default 0 */; ALLOWED_ORIGINS: string[]; COOKIE_SECURE: boolean /* default NODE_ENV === 'production' */ }`.
  The hash format uses `:` rather than `$`, because `@next/env` expands `$NAME` in `.env` values. [Claude's call]
- `lib/db.ts` (server-only): `getDb(): Db`. A singleton `pg.Pool` (`max: 5`) wrapped in `drizzle-orm/node-postgres` with core's `schema`, cached on `globalThis` for dev HMR. It never imports core's `createDb`, so PGlite stays out of the web bundle.
- `globals.css`:
  - tokens `--bg --fg --muted --card --border --accent --ok --bad --warn --info` plus one colour per stage, with dark values under `@media (prefers-color-scheme: dark)`
  - `body { margin: 0; padding: 0 16px; font: 16px/1.5 system-ui }`
  - tables wrap in `.scroll-x` containers, so only the table scrolls and never the page
  - `.pre { white-space: pre-wrap; overflow-wrap: anywhere }`

- [ ] **Step 1: Write the failing tests**

```ts
// env.test.ts
it('rejects pglite URLs and short secrets, naming vars only', () => {
  expect(() => parseWebEnv({ ...ok, DATABASE_URL: 'pglite://.data/pglite' })).toThrow(/DATABASE_URL/);
  expect(() => parseWebEnv({ ...ok, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  try { parseWebEnv({ ...ok, SESSION_SECRET: 'short' }); } catch (e) { expect(String(e)).not.toContain('short'); }
});
// guards.test.ts: walks apps/web (excluding node_modules/.next/test) and packages/core/src/dashboard
it('never uses dangerouslySetInnerHTML, sql.raw or NEXT_PUBLIC_', ...);
```

- [ ] **Step 2:** Run `npm test -w apps/web`. Expected: FAIL. **Step 3:** Implement and run `npm install`.
- [ ] **Step 4:** Run the tests, `npm run typecheck -w apps/web` and `npm run build -w apps/web` (with dummy env values). Expected: all PASS, and the build imports `@bcg/core/db/schema` without bundling PGlite.
- [ ] **Step 5:** Commit `chore(web): Next.js app scaffold with server-only env and DB`.

---

### Task 9: Authentication

**Files:**
- Create: `apps/web/lib/auth/{password,session,rate-limit,client-ip,safe-next,origin,proxy-decision,require-owner}.ts`, `apps/web/proxy.ts`, `apps/web/actions/auth.ts`, `apps/web/app/login/{page.tsx,login-form.tsx}`, `apps/web/scripts/hash-password.ts`
- Test: `apps/web/test/auth/{password,session,rate-limit,client-ip,safe-next,origin,proxy-decision,login-action}.test.ts`

**Interfaces** [Controller's call unless marked]:
- `password.ts`:
  - `hashPassword(pw: string): Promise<string>`: `scrypt:<N>:<r>:<p>:<salt b64url>:<key b64url>` with N=2^15, r=8, p=1, 16-byte salt, 64-byte key, `maxmem: 64 MiB`.
  - `verifyPassword(pw: string, stored: string): Promise<boolean>`: re-derives the key and compares with `crypto.timingSafeEqual`. It returns `false` (never throws) for a malformed hash or N > 2^20.
- `session.ts`:
  - `SESSION_TTL_S = 604_800`; `sessionCookieName(secure: boolean)` → `'__Host-bcg_session'` when secure, else `'bcg_session'`.
  - `signSession(secret: string, now?: Date): Promise<string>`: jose `SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject('owner').setIssuedAt().setExpirationTime('7d').setJti(randomUUID())`.
  - `verifySession(token: string | undefined, secret: string): Promise<{ sub: 'owner'; exp: number } | null>`: `jwtVerify` with `algorithms: ['HS256']`, requiring `sub === 'owner'`.
  - `sessionCookieOptions(secure: boolean)` → `{ httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: SESSION_TTL_S }`.
  - No sliding refresh. [Claude's call] A weekly re-login is fine for one owner and keeps the proxy read-only.
- `rate-limit.ts`: `createRateLimiter({ limit = 5, windowMs = 600_000, globalLimit = 30, maxKeys = 10_000, now = Date.now })` → `{ check(key): { allowed: boolean; retryAfterS: number }; fail(key): void; reset(key): void }`. It is a module-level singleton in the action, in memory only (state this in the docs: it resets on restart and is per instance).
- `client-ip.ts`: `clientKey(h: Headers, trustHops: number): string`. `0` → `'all'` (one shared bucket). `N` → the Nth `X-Forwarded-For` entry from the right if `net.isIP`, else `'unknown'`.
- `safe-next.ts`: `safeNext(raw: unknown): string`. Returns the value only if it is a string that starts with `/`, whose second character is not `/` or `\`, and which still resolves to the same origin as `http://x` once decoded. Otherwise returns `/`.
- `origin.ts`: `isSameOrigin(h: Headers, allowed: string[]): boolean`. The `Origin` host must equal the first `x-forwarded-host` value, or `host`, or be in `allowed`. A missing or `null` Origin → `false`.
- `proxy-decision.ts`: `proxyDecision(pathname: string, hasSession: boolean): { type: 'next' } | { type: 'redirect'; to: string }`. `/login` is public, and an authed visit to `/login` redirects to `/`. Every other path without a session redirects to `/login?next=<path+search>`.
- `proxy.ts`: `export async function proxy(req: NextRequest)` verifies the cookie with `verifySession` and applies `proxyDecision`. `config.matcher = ['/((?!_next/static|_next/image|favicon.ico).*)']`.
- `require-owner.ts` (server-only):
  - `requireOwner(): Promise<void>`: reads the cookie via `await cookies()`. On failure it calls `redirect('/login')`. Used in `app/(app)/layout.tsx` and the export route.
  - `requireOwnerAction(): Promise<void>`: `isSameOrigin(await headers(), ALLOWED_ORIGINS)`, else throws `Error('Forbidden')`, then the session check, else `redirect('/login')`.
- `actions/auth.ts` (`'use server'`):
  - `loginAction(prev: { error?: string }, fd: FormData): Promise<{ error?: string }>`. Order: origin check, then rate-limit check (`'Too many attempts. Try again in N minutes.'`), then `verifyPassword`.
  - On failure: `fail(key)`, return `'Wrong password.'`, and log only `login failed (bucket <key>)`.
  - On success: `reset`, set the cookie with a freshly signed token, then `redirect(safeNext(fd.get('next')))`.
  - `logoutAction(): Promise<void>`: deletes the cookie (`Max-Age=0`), then `redirect('/login')`.
- Login page: one password field (`autocomplete="current-password"`) and a hidden `next`. It works without JS (`<form action>`), and `useActionState` shows the error message.
- `scripts/hash-password.ts`: reads the password twice from a TTY with echo muted (or from stdin when piped), refuses fewer than 12 chars, and prints only the hash line plus a hint to paste it into `.env` as `OWNER_PASSWORD_HASH`. Also print the one-liner for `SESSION_SECRET`: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`.

- [ ] **Step 1: Write the failing tests** (key assertions)

```ts
it('password round trip; wrong or malformed fails without throwing', async () => {
  const h = await hashPassword('correct horse battery'); expect(h).toMatch(/^scrypt:32768:8:1:/); expect(h).not.toContain('$');
  expect(await verifyPassword('correct horse battery', h)).toBe(true);
  expect(await verifyPassword('nope', h)).toBe(false); expect(await verifyPassword('x', 'garbage')).toBe(false);
});
it('session rejects other secret, alg none, expired, tampered and wrong sub', async () => { /* each → null */ });
it('cookie options are HttpOnly, SameSite=Lax, 7 days, Secure only when asked', ...);
it('rate limit: 5 failures per key per 10 min, global 30, success resets', ...);
it('clientKey ignores X-Forwarded-For at 0 hops and takes the right-most trusted entry at 1', () => {
  const h = new Headers({ 'x-forwarded-for': '6.6.6.6, 1.2.3.4' });
  expect(clientKey(h, 0)).toBe('all'); expect(clientKey(h, 1)).toBe('1.2.3.4');
  expect(clientKey(new Headers({ 'x-forwarded-for': 'evil, 1.2.3.4' }), 1)).toBe('1.2.3.4');
});
it('safeNext blocks open redirects', () => {
  for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', '/%2F%2Fevil.com', 'javascript:alert(1)', '', 42]) expect(safeNext(bad)).toBe('/');
  expect(safeNext('/cases/a-b?tab=score')).toBe('/cases/a-b?tab=score');
});
it('isSameOrigin rejects missing, null and foreign origins', ...);
it('proxyDecision redirects every protected path with next=', () => {
  for (const p of ['/', '/leaderboard', '/command', '/runs', '/settings', '/cases/x', '/cases/x/export.md'])
    expect(proxyDecision(p, false)).toEqual({ type: 'redirect', to: `/login?next=${encodeURIComponent(p)}` });
  expect(proxyDecision('/login', false)).toEqual({ type: 'next' });
});
it('loginAction never logs the password and sets a fresh cookie on success', ...);   // mock next/headers + next/navigation
```

- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): password login, signed session, rate limit and route guard`.

---

### Task 10: App shell, Board, stage moves and gate kills

**Files:**
- Create: `apps/web/app/(app)/layout.tsx`, `apps/web/app/(app)/page.tsx`, `apps/web/components/{nav,case-card,stage-move-form}.tsx`, `apps/web/actions/stage.ts`, `apps/web/lib/form.ts`
- Test: `apps/web/test/actions/stage.test.ts`, `apps/web/test/components/case-card.test.tsx`, `apps/web/test/actions/all-actions-require-session.test.ts`

**Interfaces:**
- Layout: header with nav tabs (Board · Leaderboard · Command center · Runs · Settings) and a logout button (form → `logoutAction`). On narrow screens the nav wraps to two rows; there is no hamburger menu.
- Board (`?stage=&lens=&minAi=`, zod-parsed with `.catch` defaults):
  - ≥768px: 5-column grid.
  - <768px: a stage switcher row (links with counts) plus the selected column only. Default is the first non-empty stage, so phones never scroll sideways.
  - Each column root has `data-stage="<stage>" data-count="<n>"` (the acceptance test reads these).
  - Card: title (link to `/cases/<slug>`), AI score, owner score (`–` when none), metric, and a compact `StageMoveForm`.
  - Under Killed: `<details>` "Gate kills (N)" from `listGateKills`, each with failed checks and reasons, plus a "Re-run as owner idea" button.
- `StageMoveForm`: `<form action={moveStageAction}>` with hidden `caseId` and `from`, a `<select name="to">` of the other stages, a note field (required when `to=killed`; validation is server-side, with a client hint), and a submit button. It has `data-testid="move-stage"` and works with JS off. When `stage === 'killed'`, an extra "Overturn kill" button posts to `overturnKillAction`.
- `actions/stage.ts` (`'use server'`; each action starts with `requireOwnerAction()`, parses with core's zod schema, calls core and `revalidatePath('/')` + the case path):
  - `moveStageAction(prev: FormState, fd: FormData): Promise<FormState>`, where `FormState = { ok?: boolean; error?: string }`. It maps `stale` → `'This case moved since you loaded the page. Refresh.'`.
  - `overturnKillAction(fd: FormData): Promise<void>`
  - `rerunGateKillAction(fd: FormData): Promise<void>` → `queueGateKillRerun`
- `lib/form.ts`: `formToObject(fd: FormData, arrays?: string[]): Record<string, unknown>` (repeated keys → arrays; strings trimmed) and `toInt(v: unknown): number | undefined`.

- [ ] **Step 1: Write the failing tests**

```ts
// stage.test.ts: vi.mock('@/lib/db', () => ({ getDb: () => db })) with createTestDb; vi.mock require-owner → resolves; vi.mock('next/cache')
it('moveStageAction persists the move and one stage event', ...);
it('moveStageAction rejects a bad uuid or unknown stage with a message and writes nothing', ...);
it('overturnKillAction moves killed → new with kind overturn', ...);
// all-actions-require-session.test.ts: real requireOwnerAction; next/headers mocked with a valid Origin and NO cookie
it('every exported action redirects to /login without a session and writes nothing', async () => {
  for (const [name, fn] of allActionExports()) { await expect(fn(...argsFor(name))).rejects.toThrow(/NEXT_REDIRECT|login/); }
  expect(await rowCounts(db)).toEqual(before);
});
it('every exported action throws Forbidden on a foreign Origin even with a valid session', ...);
// case-card.test.tsx
it('renders scores, metric and a move form with the other four stages', ...);
```

`allActionExports()` imports every module in `apps/web/actions/` except `auth.ts`, so actions added in later tasks are covered automatically. Each later task re-runs this test.

- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): board with phone-friendly stage moves, gate kills and overturn`.

---

### Task 11: Case view: Summary, Evidence, Numbers, Competitors, Pitch, export

**Files:**
- Create: `apps/web/app/(app)/cases/[slug]/{page.tsx,error.tsx,not-found.tsx}`, `apps/web/app/(app)/cases/[slug]/export.md/route.ts`, `apps/web/components/{status-chip,external-link,text-block}.tsx`, `apps/web/components/tabs/{summary,evidence,numbers,competitors,pitch}.tsx`
- Test: `apps/web/test/components/{tabs,hostile-case,status-chip,external-link}.test.tsx`

**Interfaces:**
- Page:
  - `?tab=` is parsed by `z.enum(['summary','evidence','numbers','competitors','pitch','validate','score']).catch('summary')`. Tabs are links (`aria-current="page"`), so each tab is a server render and works without JS.
  - Header: title, stage chip, `StageMoveForm`, the kill reason when killed, an "Overturn kill" button, gate flags as a warning banner (`⚠️ Gate flags: …`), and an "Export Markdown" link.
  - The content wrapper has `<main id="case-content" data-tab="<tab>">`.
- **Tab components are synchronous and take props only** (so RTL can render them): `SummaryTab({ view })`, `EvidenceTab({ view })`, `NumbersTab({ view })`, `CompetitorsTab({ view })`, `PitchTab({ view })`. Each takes `view: CaseView` plus `flags = linkFlags(view.claims)` computed once in the page.
  - Summary: the summary fields; the gate verdicts list (failed first: check, ✅/❌, reasoning); "For you to check" from `forYouToCheck` (three states with the export's wording, items merged with "(N claims)").
  - Evidence: signals (quote via `cleanQuote`, source name, link, voice label, `StatusChip` or "not checked"), then claims from sections `evidence` and `numbers` with chips, quote and link.
  - Numbers: key results, formulas, an inputs table (source link + quote + chip, or `assumption: …`) and a scenarios table.
  - Competitors: a table on wide screens, stacked cards on narrow ones (pure CSS). Columns: name, link, pricing, gap, `competitorChecks().product/.pricing` text. Then the levels table.
  - Pitch: elevator, 3 emails, 2 follow-ups, call script, objections, pricing copy, all in `TextBlock` (`.pre`).
- `StatusChip({ status: ClaimStatus })` → `<span class="chip chip-<status>" aria-label={STATUS_LABEL[status]}>{STATUS_EMOJI[status]} …</span>`.
- `ExternalLink({ url, children? })` → `safeHttpUrl(url)`. A valid URL becomes an `<a href={u.href} target="_blank" rel="noopener noreferrer nofollow">` showing the hostname. Anything else becomes plain `<span>` text.
- `TextBlock({ text })` → `<p class="pre">{text}</p>`.
- Legacy rows: render from the stored `sections` as the export does. Do not reject a case that fails `CaseSectionsSchema` (old pitch emails may lack placeholders). If a tab throws, `error.tsx` shows `This tab could not be rendered.` with a `data-render-error` attribute and no stack trace.
- `export.md/route.ts`: `GET`. Calls `requireOwner()`, then `getCaseView`, returns `caseToMarkdown(...)` with `Content-Type: text/markdown; charset=utf-8`, `Content-Disposition: attachment; filename="<slug>.md"` and `X-Content-Type-Options: nosniff`. Unknown slug → 404.

- [ ] **Step 1: Write the failing tests**

```ts
// hostile-case.test.tsx: a case fixture whose every text field, quote, competitor name and url is hostile
it.each(['summary', 'evidence', 'numbers', 'competitors', 'pitch'])('%s tab renders hostile text inertly', (tab) => {
  const { container } = render(<Tab name={tab} view={hostileView} />);
  expect(container.querySelector('img, script, iframe, style')).toBeNull();
  expect([...container.querySelectorAll('a')].every((a) => /^https?:/.test(a.getAttribute('href')!))).toBe(true);
  expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
});
it('external links carry rel="noopener noreferrer nofollow" and target _blank', ...);
it('summary shows "For you to check" items merged with counts, and failed gate checks first', ...);
it('evidence shows one chip per claim status (✅ ❌ ⚠️ 🔍 ⏳)', ...);
it('numbers shows formulas and "assumption: …" for unsourced inputs', ...);
```

- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run. Expected: PASS. Open three real cases in `npm run dev` (after Task 7's copy), with each tab on a phone-width window.
- [ ] **Step 5:** Commit `feat(web): case view with evidence chips, for-you-to-check and markdown export`.

---

### Task 12: Case view: Score and Validate tabs

**Files:**
- Create: `apps/web/components/tabs/{score,validate}.tsx`, `apps/web/components/{score-form,mark-outreach-form}.tsx`, `apps/web/actions/{scores,outreach}.ts`
- Test: `apps/web/test/actions/{scores,outreach}.test.ts`, `apps/web/test/components/{score-tab,validate-tab}.test.tsx`

**Interfaces:**
- `ScoreTab({ view })`:
  - AI scores are read-only: criterion label, value, note.
  - `ScoreForm` (client, `useActionState`) has 8 rows (7 criteria + "Your gut"). Each row is a `<select>` with blank/1–5, pre-filled with the owner's latest value, plus a note `<textarea maxlength=1000>`.
  - Submit → `saveOwnerScoresAction`. Blank rows are omitted, and at least one is required.
- `actions/scores.ts`: `saveOwnerScoresAction(prev: FormState, fd: FormData): Promise<FormState>`: `requireOwnerAction`, builds `entries` from `value_<criterion>`/`note_<criterion>`, `OwnerScoresInputSchema`, then `saveOwnerScores` and `revalidatePath`.
- `ValidateTab({ view, validate: ValidateView })` (read-only plus marks):
  - No pack → `Validation pack not generated yet. Run: npm run gen -- validate <slug>`.
  - Otherwise these sections:
    - MVP spec, pilot plan, interview kit (text)
    - checklist with `pass/pending` chips
    - outreach counts
    - a prospects table (name, website via `ExternalLink`, location, email, CASL basis badge `self_published` strong / `third_party` warn / `unknown` blocked, status, fit reason)
    - each prospect's drafts in `<details>` (subject + `TextBlock` body), plus `MarkOutreachForm`
    - recent events
    - a landing summary: headline and copy fields as text, `publishedUrl` via `ExternalLink`, size in KB. The HTML is never rendered or iframed.
  - Pagination is `?tab=validate&page=N` (zod-clamped).
- `MarkOutreachForm`: hidden `prospectId` and `slug`, a `<select name="type">` of `sent|replied|positive|meeting|not_interested|unsubscribe`, an optional note (≤500) and a submit button.
- `actions/outreach.ts`: `markOutreachAction(prev: FormState, fd: FormData): Promise<FormState>`: `requireOwnerAction`, then zod `{ prospectId: z.uuid(), type: z.enum([...]), note: z.string().trim().max(500).optional() }`, then **core `markOutreach(db, prospectId, type, note)`** (the same function `gen outreach mark` uses, so status-never-regresses and unsubscribe-suppresses hold in one place).

- [ ] **Step 1: Write the failing tests**

```ts
it('saveOwnerScoresAction stores gut and replaces earlier owner rows', ...);
it('saveOwnerScoresAction rejects value 6, unknown criterion and an all-blank form', ...);
it('markOutreachAction writes the same rows as gen outreach mark (event + status + suppression on unsubscribe)', ...);
it('validate tab shows the not-generated state without a pack', ...);
it('validate tab never renders landing html and badges CASL basis', ...);
```

- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run, including `all-actions-require-session`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): owner scoring and validation tracking tabs`.

---

### Task 13: Leaderboard and Command center

**Files:**
- Create: `apps/web/app/(app)/leaderboard/page.tsx`, `apps/web/app/(app)/command/page.tsx`
- Test: `apps/web/test/components/leaderboard-table.test.tsx`, `apps/web/test/components/command-center.test.tsx`

**Interfaces:**
- Leaderboard (`?key=&by=&dir=` through `LeaderSortSchema`):
  - One table, horizontally scrollable inside its container: title (link), stage, AI total, owner total, then one column per criterion showing `ai/owner` (e.g. `4/5`; `gut` shows owner only).
  - Each header is a sort link that toggles `dir`. Under each criterion header there is an `AI | You` toggle link.
  - Extract the presentational `LeaderboardTable({ rows, sort })` component for tests.
- Command center:
  - "Needs you" list from `needsYou` (kind icon, label, link, relative time).
  - Spend today and this week from `spendSince(torontoDayStart(now))` / `spendSince(torontoWeekStart(now))`, shown as `LLM $x.xx (notional) · data $y.yy · N calls`.
  - Generator status: worker last seen (from `readWorkerStatus`, "not seen" if null or older than 60 s) and runs queued/running.
  - Recent runs: last 5 from `listRuns`.
  - Spend caps are Plan 4. Show the text "No caps configured (Plan 4)".
  - Extract `CommandCenter({ data })` for tests.

- [ ] **Step 1: Write the failing tests**

```ts
it('sort links toggle direction and keep by', ...);
it('null scores show – and sort last', ...);
it('needs-you items link to the right case/run and spend shows two decimals', ...);
it('worker shows "not seen" when the heartbeat is older than 60 s', ...);
```

- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): leaderboard and command center`.

---

### Task 14: Runs and Settings

**Files:**
- Create: `apps/web/app/(app)/runs/page.tsx`, `apps/web/app/(app)/settings/page.tsx`, `apps/web/components/{queue-run-form,settings-form,auto-refresh}.tsx`, `apps/web/actions/{runs,settings}.ts`
- Test: `apps/web/test/actions/{runs,settings}.test.ts`, `apps/web/test/components/queue-run-form.test.tsx`

**Interfaces:**
- Runs page (`?page=`):
  - `QueueRunForm`: seed radio (open/sector/lens/idea); sector checkboxes from the market's `sectors`; lens checkboxes from active lenses; idea `<textarea maxlength=20000>`; ideas `<input type=number min=1 max=30 value=12>`; advance `min=1 max=10 value=3`. HTML limits mirror the zod limits, but only the server is trusted.
  - A note under the form: "Runs execute when `npm run worker` is running."
  - History table: created, seed, status, current stage, cost, cases, error (≤200 chars), and a `<details>` with stage rows (status, start, end). A "Resume" button appears on failed runs.
  - `AutoRefresh({ everyMs: 10_000 })` (client: `router.refresh()` on an interval) is mounted only while a run is queued or running.
- `actions/runs.ts`:
  - `queueRunAction(prev: FormState, fd: FormData): Promise<FormState>`: `formToObject(fd, ['sectors', 'lensIds'])`, then `QueueRunInputSchema`, then `queueRun`. Reasons map to messages, e.g. `too_many_queued` → `'3 runs are already queued. Wait for the worker.'`.
  - `requeueRunAction(fd: FormData): Promise<void>`: `z.uuid()`, then `requeueRun`.
- Settings page:
  - `SettingsForm` for `EDITABLE_SETTING_KEYS` (labels; current values shown, since sender identity is not secret) → `saveSettingsAction`.
  - Read-only sections:
    - **Connections**: worker heartbeat providers as `connected/not set` badges, plus `Database: connected` from a `select 1`. Never values or URLs.
    - **Models per stage**: heartbeat `models`, else `DEFAULT_MODELS` labelled "defaults (worker not seen)".
    - **Lenses and market**: names only.
    - **Scoring criteria**: the 8 labels.
- `actions/settings.ts`: `saveSettingsAction(prev: FormState, fd: FormData): Promise<FormState>`: `requireOwnerAction`, then `SettingsInputSchema` (unknown keys dropped, so `worker.status` cannot be written from the form), then `setSetting` per key in one transaction.

- [ ] **Step 1: Write the failing tests**

```ts
it('queueRunAction inserts one queued run with the parsed config', ...);
it('queueRunAction rejects ideaCount 31, advance > ideas, an unknown lens and a 4th queued run, writing nothing', ...);
it('requeueRunAction only requeues failed runs', ...);
it('saveSettingsAction writes sender.* and landing.* only and ignores worker.status', ...);
it('saveSettingsAction rejects a non-https formEndpoint', ...);
it('queue form shows the idea textarea only for seed idea (no-JS fallback: all fields shown, server validates)', ...);
```

- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run, including `all-actions-require-session`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): runs queue and settings`.

---

### Task 15: Docs and env

**Files:**
- Create: `docs/dashboard.md`
- Modify: `.env.example` (final list), `docs/CONTEXT.md` (status, decisions, session log), `docs/plan-1-followups.md` (deferred items)

`docs/dashboard.md` contents (short, command-first):
1. **One-time setup:**
   - `docker compose up -d db`
   - set `DATABASE_URL=postgres://bcg:bcg_local_dev@127.0.0.1:5433/bcg` in `.env` (the PGlite folder stays as a backup)
   - `npm run db:copy -- --from pglite://.data/pglite`
   - `npm run hash-password -w apps/web` → `OWNER_PASSWORD_HASH`
   - generate `SESSION_SECRET`
2. **Daily use:** `npm run web` (http://localhost:3000) and, in a second terminal, `npm run worker`.
3. **Phone on the same Wi-Fi:** `npm run dev -w apps/web -- -H 0.0.0.0` with `DEV_ORIGINS=<PC LAN IP>`, then open `http://<LAN IP>:3000`. Allow Node through Windows Firewall for Private networks only. Over a tunnel (https): `cloudflared tunnel --url http://localhost:3000`, then add the tunnel host to `DEV_ORIGINS` and `ALLOWED_ORIGINS`, and set `COOKIE_SECURE=true`.
4. **Env reference:** `DATABASE_URL`, `OWNER_PASSWORD_HASH`, `SESSION_SECRET`, `TRUST_PROXY_HOPS` (0 locally; 1 behind Railway), `ALLOWED_ORIGINS`, `COOKIE_SECURE`, `DEV_ORIGINS`, `TEST_DATABASE_URL` (optional, enables the real-Postgres worker test).
5. **Security notes:**
   - log out everywhere = rotate `SESSION_SECRET`
   - the rate limit is in memory and per instance
   - the hash format uses `:` because of `.env` expansion
   - a run killed hard stays `running` until `gen resume <id>`
6. **Out of scope / later plans** (the list from this plan's header).

- [ ] **Step 1:** Write the docs. Every command in them is run during Task 16.
- [ ] **Step 2:** Commit `docs: dashboard setup, phone access and security notes`.

---

### Task 16: Local acceptance

**Files:**
- Create: `apps/web/scripts/acceptance.ts`, `apps/web/scripts/check-bundle.ts`, `docs/runs/2026-10-xx-dashboard-acceptance.md` (use the actual date)

**Interfaces:**
- `acceptance.ts` (`BASE_URL`, password from the `ACCEPT_PASSWORD` env, never printed; DB via `DATABASE_URL`; HTML parsed with `linkedom`). Forms are submitted the way a no-JS browser does: collect the form's hidden inputs (Next's action fields), set the visible fields, POST `multipart/form-data` to the form's action URL with `Origin: BASE_URL`, and keep cookies. Checks, each printing `PASS`/`FAIL`:
  1. Unauthenticated `GET` of `/`, `/leaderboard`, `/command`, `/runs`, `/settings`, `/cases/<each slug>` and `/cases/<slug>/export.md` → 307/308 with `Location` starting `/login`. An unauthenticated POST to `/` with the move-stage form fields → no DB change.
  2. Login: a wrong password shows `Wrong password.`, the right one sets the session cookie (`HttpOnly`, `SameSite=Lax`), and `next=//evil.com` lands on `/`.
  3. Board: the sum of `data-count` = `SELECT count(*) FROM cases` (expected 9), and each stage count equals `SELECT stage, count(*) … GROUP BY stage`.
  4. Every case × 7 tabs → 200, `data-tab` matches, no `data-render-error`. Inside `#case-content` there is no `<script`, `<iframe`, `<img`, `<style`, ` on\w+=` attribute or `href="javascript:`.
  5. Stage move: pick a `new` case and move it to `validating` via its `move-stage` form. Assert the DB stage plus one new `stage_events` row (`kind 'move'`). Move it back. Then delete exactly the two event rows the script created (by id) and confirm the stage is back to `new`.
  6. Export: `/cases/<slug>/export.md` → `text/markdown`, and the body starts with `# `.
  7. Logout → `GET /` redirects to `/login`.
  8. Last: 6 wrong logins → `Too many attempts`. Restart the server afterwards to clear the limiter.
- `check-bundle.ts`: reads the real `SESSION_SECRET`, `OWNER_PASSWORD_HASH` and the DB password from env and searches every file under `apps/web/.next/static` for each, plus `scrypt:` and `postgres://`. Exits 1 on any hit, printing the file name only.

- [ ] **Step 1:** `docker compose up -d db`, then wait for it to report healthy (`docker compose ps`).
- [ ] **Step 2:** Make sure no CLI process has `.data/pglite` open, then run `npm run db:copy -- --from pglite://.data/pglite --to postgres://bcg:bcg_local_dev@127.0.0.1:5433/bcg`. Expected: every table `ok`, `cases` = 9. Run it again. Expected: 0 inserted.
- [ ] **Step 3:** Run `npm test` (core + web), `npx tsc --noEmit -p packages/core` and `npm run typecheck -w apps/web`. Expected: all green.
- [ ] **Step 4:** Run `npm run build -w apps/web && npm run check-bundle -w apps/web` (expected 0 hits), then `npm run start -w apps/web` with `COOKIE_SECURE=false` (http on localhost).
- [ ] **Step 5:** `ACCEPT_PASSWORD=… BASE_URL=http://localhost:3000 npm run acceptance -w apps/web`. Expected: all PASS. Fix each failure with a failing test first in the owning task's test file.
- [ ] **Step 6:** Worker end to end: queue an `open` run with `ideaCount 1, advanceCount 1` from the Runs page, then run `npm run worker -- --once`. Expected: the run is claimed and executes (live LLM; cost noted), and the Runs page shows its stages. If the owner prefers not to spend, run against a run whose stored config is invalid and confirm it ends `failed` with `invalid run config`.
- [ ] **Step 7:** Phone check (owner or tester): over LAN, log in, board stage switcher with no horizontal scroll at 360px, open a case, switch all tabs, move a stage with the select, enter a gut score.
- [ ] **Step 8:** Record results, counts, cost and any defects in `docs/runs/…-dashboard-acceptance.md`, and update `docs/CONTEXT.md` (Plan 2 complete; next Plan 4).
- [ ] **Step 9:** Commit `test(web): local acceptance script and results`.

---

## Self-Review

### Spec coverage

| Spec item | Where |
|---|---|
| §7 hosted, behind auth, single owner, phone-friendly | T8 (CSS, headers), T9 (auth), T15/T16 (phone access); hosting itself is Plan 4 |
| §7.1 Board: 5 columns; card = name, AI score, owner score, key metric; filters | T4 (`listBoard`, `keyMetric`), T10. Filters are lens + min score only, because ideas store no sector |
| §7.1 Leaderboard sortable by any criterion | T4 (`sortLeaderboard`), T13 |
| §7.1 Command center: status, today's runs, spend, "Needs you" | T5 (`needsYou`, `spendSince`), T13. Caps are Plan 4 |
| §7.1 Runs: start a run, progress, history with cost | T5 (`queueRun`, `listRuns`), T6 (worker), T14. Stage-level progress with auto-refresh; per-message log is Plan 4 |
| §7.1 Settings: model per stage, API status (no values), lenses/markets/criteria | T5 (`settings.ts`), T6 (heartbeat), T14. Read-only except `sender.*`/`landing.*`; limits and taste profile are Plan 4 |
| §7.2 Case tabs Summary · Evidence · Numbers · Competitors · Pitch · Validate · Score | T11, T12 |
| §7.2 actions: move stage, score, overturn kill, export Markdown | T3, T10, T12, T11. Regenerate section, generate pack, publish landing and PDF are out of scope (header) |
| §6.2 stages New → Validating → Pilot → Live → Killed; button moves; each move logged | T3 (`stage_events`, `moveStage`), T10 (select + buttons; no drag) |
| §5.4 killed ideas shown with reason; owner can overturn | T4 (`listGateKills`), T5 (`queueGateKillRerun`), T3/T10 (case overturn = `kind 'overturn'`) |
| §6.4 8 criteria 1–5 + note; AI 7, owner-only gut | T4 (`OWNER_CRITERIA`, `scoreSummary`), T5 (`saveOwnerScores`), T12 |
| §6.4 learning | Out of scope (Plan 4). Owner scores, stage events and overturns are stored for it |
| §6.3 outreach tracking sent/replied/positive/meeting | T12 via Plan 3's `markOutreach` |
| §8 StageEvent, Setting | T3, Plan 3 Task 1 |
| §10 host-agnostic Next.js, Postgres, worker | T7 (Postgres), T8 (no Vercel-only APIs), T6 (worker). pg-boss is Plan 4 |

### Type consistency
- `CaseStage`/`StageEventKind` derive from the pgEnums (T3). Zod enums use `caseStage.enumValues`, so the DB, core and forms share one list.
- `OwnerCriterion` = `criterion.enumValues`, and `Criterion` (7) stays from `case/schema.ts` (T4). `gut` is accepted only by `OwnerScoresInputSchema`.
- `RunConfigSchema` ↔ `RunConfig` is checked at compile time (T5). `QueueRunInput` maps through `defaultRunConfig`, so UI runs and CLI runs store the same shape.
- `ClaimStatus` = `ClaimRow['verified']`. `review.ts` is the only home of status emoji/labels, used by both the export (T2) and the web (T11).
- `Db` comes from core in every layer. The web's `getDb()` returns the same type built from `pg` + core `schema`.
- `FormState = { ok?: boolean; error?: string }` is shared by every `useActionState` action.

### Proportion
16 tasks. Estimated code ≈ 3.5–4.5k lines (core ≈ 1.3k incl. tests, web ≈ 2.5k incl. tests). This plan states signatures, files, test names and pinned values, not bodies. Playwright was considered and left out [Claude's call]: the browser download is heavy, and its smoke check (login → board → case → tabs) is covered by the HTTP acceptance script, which also proves the forms work without JS. RTL covers component output.

## Open questions for the owner

1. **Phone access while testing locally:** same-Wi-Fi LAN IP (no install) or a Cloudflare quick tunnel (https, needs `cloudflared`)? *Default: LAN IP.*
2. **Gate-killed ideas on the board:** show them under Killed with a "Re-run as owner idea" button (queues a full case run, about $4 each)? *Default: yes.*
3. **Worker check in Task 16:** spend about $1–5 on one tiny live run (1 idea, advance 1) to prove "Queue a run" end to end? *Default: yes.*
4. **Dashboard address for Plan 4:** Railway's free `*.up.railway.app` hostname, or a subdomain of a domain you will buy? *Default: Railway's hostname until you buy the landing-page domain.*
