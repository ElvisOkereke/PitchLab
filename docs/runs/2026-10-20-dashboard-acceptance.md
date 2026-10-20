# Dashboard local acceptance (2026-10-20)

Plan 2, Task 16, branch `plan-2`. **Result: 13 of 13 acceptance checks pass. The worker ran one live run end to end:
it succeeded, cost $4.37 and produced a new case, which the Board and Runs pages show.** No product defect was found.
The deliverable scripts were missing and are now added. The guide had three gaps, now fixed.

**This was not the planned setup.** Docker Desktop was not running and was deliberately not started. Postgres was
replaced by a throwaway PGlite database served over the Postgres wire protocol (`@electric-sql/pglite-socket`). The app
saw an ordinary `postgres://` URL. Real Postgres is still owed (see "Not verified").

## Setup (all temporary, all deleted afterwards)

- Temp folder outside the repo: `%LOCALAPPDATA%\Temp\bcg-accept`. It held `@electric-sql/pglite-socket@0.2.13` with
  `@electric-sql/pglite@0.5.10` and `@electric-sql/pglite-pgvector@0.0.11` (the same versions as core), a copy of
  `.data/pglite` and an empty target data directory.
- Socket server: `npx pglite-server -d <temp>/target -p 55433 -h 127.0.0.1 -e @electric-sql/pglite-pgvector:vector -m 10`
  (later `-m 100`, see "Fallback artifacts"). Bound to 127.0.0.1 only.
- The real `.data/pglite` was never opened. Fingerprint before and after: 1083 files, 60,104,899 bytes, identical md5 of
  the (mtime, size, path) listing, same newest mtime.
- Web env: a temp env file only, never tracked files. `DATABASE_URL` pointed at the socket with a random password.
  `OWNER_PASSWORD_HASH` came from `npm run hash-password -w apps/web`, piped an invented 24-character password.
  `SESSION_SECRET` was 32 random bytes. Also `COOKIE_SECURE=false`, `ALLOW_INSECURE_COOKIE=true`, `TRUST_PROXY_HOPS=0`.
- Concurrency: the socket server's multiplexer (`-m`) allows several clients, so the web server (pool of 5), the
  acceptance script and the worker all ran at the same time. Nothing had to be serialised.

## 1. Copy (db:copy)

| Step | Command | Result |
|---|---|---|
| Dry run, before migrating | `npm run db:copy -- --dry-run --from pglite://<copy> --to postgres://…` | exit 2: "Local DB is behind the code". `stage_events` was missing (migration `0006_stage_events`) |
| Migrate the copy | `DATABASE_URL=pglite://<copy> npm run db:migrate` | "migrations applied" |
| Dry run | `DATABASE_URL=postgres://… npm run db:copy -- --dry-run --from pglite://<copy>` | exit 0: "Source migrations match the code." |
| Copy | same, without `--dry-run` | exit 0, every table `ok`. "Copy complete: every table matches." |
| Copy again | same | exit 0, **0 inserted** in every table, every table `ok` |

Rows (source = target): lenses 8, markets 1, runs 12, data_calls 40, ideas 68, **cases 9**, claims 220, gate_verdicts 192,
landing_pages 1, landing_events 0, llm_calls 443, prospects 28, outreach_drafts 39, outreach_events 0, run_stages 96,
scores 63, settings 0, signals 161, stage_events 0, suppressions 0, validation_packs 1.

The migration-hash check passed. There was no CRLF mismatch: `git ls-files --eol` shows `w/lf` for every
`packages/core/drizzle/*.sql`. (Three `meta/*_snapshot.json` files are `w/crlf` in the working tree. They are not hashed
and were left alone.)

## 2. Build and server

- `npm run build -w apps/web` (clean `.next`, built with the acceptance env): exit 0, 9 routes, proxy present.
- `npm run check-bundle -w apps/web`: 19 files, 0 hits.
- `npm run start -w apps/web -- -H 127.0.0.1 -p 3123`: ready in about 150 ms. The server log showed no secret.
  `SESSION_SECRET` and `DATABASE_URL` were each grepped: 0 hits.

## 3. Acceptance script (`apps/web/scripts/acceptance.mjs`)

Command: `BASE_URL=http://127.0.0.1:3123 ACCEPT_PASSWORD=… npm run acceptance -w apps/web`, with the web env in the
process env. Plain Node, no browser. HTML is parsed with linkedom.

The script submits forms the way a browser without JavaScript does. It collects the form's own fields (Next's
`$ACTION_*` hidden inputs included), sets the visible fields, and POSTs `multipart/form-data` to the form's action URL
with `Origin` set to the app origin. Cookies are kept in a jar and redirects are not followed. The route list comes from
walking `apps/web/app`, so a new route is checked automatically, and a route with an unknown dynamic segment fails the
run. Every DB write the script makes is undone: its stage events (deleted by id), the case's `stage`, `kill_reason` and
`updated_at` (restored), the case's owner score rows (restored from a snapshot) and the queued run (deleted, unless
`KEEP_QUEUED_RUN=1`).

There were four runs. Run 1: 12/13. Check (f) failed because the script compared rows in DB order (a script bug, fixed
by ordering by criterion). Run 2: 13/13, with 9 cases; it kept the queued run for the worker. Run 3 hit a fallback
artifact (below). **Run 4: 13/13, with 10 cases**, including the one the worker created. Run 4's results:

| Check | Result | Evidence |
|---|---|---|
| a. Every route unauthenticated | PASS | 28 paths (`/`, `/leaderboard`, `/command`, `/runs`, `/settings`, `/cases/<10 slugs>`, `/cases/<10 slugs>/export.md`, and both routes with an unknown slug): each → 307 to `/login?next=…`. `/login` → 200 |
| a2. Every route authenticated | PASS | 27 paths → 200. The unknown slug → 404 on the page and on `export.md`. 3 malformed slugs (`Not%20A%20Slug`, `..%2F..%2Fetc`, `UPPER-case/export.md`) → 404 |
| a3. Unauthenticated Server Action POSTs | PASS | Move-stage, score and queue-run forms (collected while logged in) replayed with no cookie → 307 `/login`. Counts of `stage_events`, `runs` and `scores`, and the case stage, unchanged |
| b. Login | PASS | Wrong password → 200 with "Wrong password.", no `Set-Cookie`. Right password → 303 to `/`, cookie `bcg_session` with `HttpOnly; SameSite=Lax; Path=/`. A `next=//evil.com` in the query and in the POST body → lands on `/`. An authenticated `/login` → `/` |
| c. Board | PASS | `data-count` new=10, validating=0, pilot=0, live=0, killed=0 = `SELECT stage, count(*) … GROUP BY stage`. Every slug is linked |
| d. Case pages and export | PASS | 10 cases × 7 tabs = 70 pages, all 200, `data-tab` matches, no `data-render-error`. Inside `#case-content`: no `script`, `iframe`, `img`, `style`, `object` or `embed`. On the whole page: no `on*` attribute. Every link is http(s), relative or `#`, and every external link has `noopener`. 10 exports: `text/markdown; charset=utf-8`, `attachment; filename="<slug>.md"`, body starts with `# ` |
| e. Stage moves | PASS | new → validating: DB stage and one `move` event, and the page shows the new stage. Back to new. Killed without a note → "Add a note saying why you are killing it.", no DB change. Killed with a note → `kill_reason` stored. Overturn kill → new, `kill_reason` null. Events: move, move, kill, overturn. All 4 deleted by id, case row restored (`updated_at` included), 0 stage events remain |
| f. Owner scores | PASS | Saved gut=4 (with note) and pain=2: DB rows exist, and the reloaded form preselects 4 and 2. The second save sets only roi=5 with the other fields blank; gut and pain are kept. Resubmitting the form as rendered changes nothing. AI rows untouched. Restored to 0 owner rows |
| g. Hostile POSTs | PASS | Foreign `Origin` → 500 (Next aborts the action). Missing `Origin` → 500 (Next only warns; the app's `assertSameOrigin` throws "Forbidden"). `Origin: null` → 500. Forged cookie signed with another secret → 307 `/login`; `alg: none` → 307 `/login`; both also on `GET /`. DB unchanged |
| h. Queue a run | PASS | The Runs form (seed idea, 1 idea, advance 1) → "Queued.". One new `runs` row, `queued`, config seed idea / 1 / 1 / `ca-us` with the exact text. `/runs` shows a `queued` badge. Run 2 kept the row for the worker; run 4 deleted it |
| Logout | PASS | 303 to `/login`, cookie `Max-Age=0`. `/` → `/login` afterwards |
| i. Login rate limit | PASS | Attempts 1–5 → "Wrong password.". Attempts 6–8 → "Too many attempts…". The right password is also refused while limited, and no cookie is ever set. (The 7th and later attempts are limited, as required. The 6th is limited too, because the limit is 5 failures per bucket.) |
| j. Bundle | PASS | 19 files under `.next/static` were searched for `SESSION_SECRET`, `OWNER_PASSWORD_HASH`, `DATABASE_URL`, the DB password, `LLM_API_KEY` (read from the repo-root `.env` only for the search, never printed), the acceptance password, `postgres://`, `postgresql://`, `drizzle`, `pglite` and `scrypt:`. 0 hits |

After every run, the DB matched its starting state: stage_events 0, owner scores 0, runs 12 (13 after the worker run),
every case `new`.

## 4. Worker end to end (live LLM)

1. Acceptance run 2 queued the run through the Runs form, with `KEEP_QUEUED_RUN=1`. Run id `685301b6`. Idea text: "A weekly email for
   Ontario landlords with 3-20 units listing new Landlord and Tenant Board rule changes and the exact notice forms
   affected." 1 idea, advance 1.
2. Command: `DATABASE_URL=<socket URL> npm run worker -- --once`. The web secrets were removed from its env. The worker
   loaded `LLM_API_KEY` from the repo-root `.env`; the process env's `DATABASE_URL` won over the `.env` value
   (`process.loadEnvFile` does not override, checked). The web server stayed up and connected throughout.
3. Status, polled from the DB every 5 s: `queued` (07:00:37 UTC) → `running` (claimed 07:00:56) → harvest → ideate →
   dedupe → screen → gate → case → verify → score → **`succeeded`** (07:07:16). Wall time 6 min 20 s.
4. Log: 5 signals; 1 owner idea; dedupe nearest 0.522 (kept); screen 1 advanced; gate 1 passed (advisory); 1 case
   written; verify 15 verified, 2 unsupported, 4 unreachable, 4 need review; 1 case scored (AI mean 2.14). Worker exit 0.
5. **Cost $4.37** (24 LLM calls; `runs.cost_usd` = sum of `llm_calls`).
6. Dashboard: during the run, `/runs` showed it as `running`, stage `gate`, $1.15. Afterwards it showed `succeeded`,
   stage `score`, $4.37, 1 case. The Board showed new=10, with
   `ontario-ltb-form-change-alerts-for-small-landlords` linked. Acceptance run 4 then rendered all 7 tabs and the export
   for that case.
7. The new case exists only in the throwaway database, which has been deleted. Its Markdown export remains at
   `output/cases/ontario-ltb-form-change-alerts-for-small-landlords.md` (git-ignored). The owner's real database does
   not have it.

## 5. Phone layout (static evidence only)

- The viewport is `width=device-width, initial-scale=1`. The body has 16px side padding and 16px/1.5 base text.
- `globals.css` (852 lines) is mobile-first. It uses `min-width` media queries at 768px (board becomes 5 columns,
  switcher hidden) and 900px, and a `max-width: 767px` query that stacks tables as labelled cards. There are no fixed
  pixel widths, only `max-width` caps (login 360px, forms 640/720px, page 1600px). Long text wraps
  (`overflow-wrap: anywhere`, `min-width: 0` on grid/flex children). Only tables scroll, inside `.scroll-x`.
- Tap targets use `--tap: 44px` (`min-height`) on buttons, inputs and nav links. **Observation:** the leaderboard's
  ai/owner sort toggle links (`.by-toggle a`) have `min-height: 32px`, below the 44px rule. The stage chip is also 32px,
  but it is not interactive.
- **Still owed:** a real phone or browser check at 360px (Task 16 Step 7): no horizontal scroll, the stage switcher,
  all tabs, a stage move with the select, a gut score.

## Defects and changes

- **Missing deliverables (fixed):** `apps/web/package.json` pointed `acceptance` and `check-bundle` at
  `scripts/acceptance.ts` and `scripts/check-bundle.ts`, which did not exist. `docs/dashboard.md` told the owner to run
  `npm run check-bundle`. Both scripts are now added as `.mjs`, with `linkedom` as a web devDependency. Both read the
  process env first, else the repo-root `.env`. That `.env` fallback was added after the runs above, which used the
  process env, and only the no-server error paths were exercised.
- **Guide gaps (fixed in `docs/dashboard.md`):**
  1. The "Local DB is behind the code" advice said to run "any gen command with `DATABASE_URL=pglite://…`". That syntax
     does not work in PowerShell, and the owner's real DB *is* behind (no 0006). The guide now says `npm run db:migrate`:
     it does not read `.env` and defaults to `.data/pglite`.
  2. "The URL is never printed" was true of the script but not of npm, which echoes the command line. A URL passed with
     `--to` appeared in full in the npm banner line. The guide now says to leave `--to` out.
  3. There was no section on how to run the acceptance check. One is added.
- **Product defects:** none found.
- **Observations, not fixed:** the 32px `.by-toggle` tap targets (above). HSTS is sent on plain-http `next start`
  (harmless: browsers ignore HSTS over http).

## Fallback artifacts (not app defects)

Acceptance run 3 (after the worker run) got 500s on `/`, `/command`, `/runs`, `/settings` and every Validate tab, with
`ECONNRESET` in the server log. The cause: `pglite-socket` limits clients with `-m`, and slots held by web servers I had
killed with `Stop-Process` were not released (its idle timeout is 0). With the web server stopped, a probe got 5
accepted connections and 7 resets out of 12. Restarting the socket server with `-m 100` (the data survived: 10 cases,
13 runs) and the web server fixed it, and run 4 passed 13/13. Real Postgres does not behave this way.

## Not verified

- **Real Postgres in Docker** (`pgvector/pgvector:pg16` from `docker-compose.yml`), including `db:copy` into it.
- **Advisory locks and `FOR UPDATE SKIP LOCKED` on real Postgres:** PGlite is a single backend, so concurrent claiming
  is not exercised. The real-Postgres worker test (`packages/core/test/worker.test.ts`, "on real Postgres") was skipped
  because `TEST_DATABASE_URL` was unset.
- **A real phone or browser** (layout, the JS-enhanced forms, auto-refresh). Every form was tested only without JS.
- Phone access over the LAN (`next dev -H 0.0.0.0`, `DEV_ORIGINS`, Windows Firewall).

## Repeat with Docker (owner, PowerShell)

```
# 0. Back up the local DB (step 2 migrates it)
Copy-Item -Recurse .data\pglite .data\pglite-backup-20261020
# 1. Postgres
docker compose up -d
docker compose ps                      # wait for "healthy"
# 2. Bring the local DB up to date (no .env read; targets .data/pglite)
npm run db:migrate
# 3. In .env: DATABASE_URL=postgres://bcg:bcg_local_dev@127.0.0.1:5433/bcg, OWNER_PASSWORD_HASH (npm run hash-password -w apps/web), SESSION_SECRET
npm run db:copy -- --dry-run
npm run db:copy                        # every table ok, cases 9
npm run db:copy                        # again: 0 inserted
# 4. Tests, including the real-Postgres worker test against a throwaway database
docker compose exec db createdb -U bcg bcg_test
$env:TEST_DATABASE_URL='postgres://bcg:bcg_local_dev@127.0.0.1:5433/bcg_test'; npm test; Remove-Item Env:TEST_DATABASE_URL
npx tsc --noEmit -p packages/core; npm run typecheck -w apps/web
# 5. Build, bundle check, production server on http
npm run build -w apps/web; npm run check-bundle -w apps/web
$env:COOKIE_SECURE='false'; $env:ALLOW_INSECURE_COOKIE='true'; npm run start -w apps/web
# 6. Second terminal: acceptance (keep the queued run for the worker)
$env:BASE_URL='http://localhost:3000'; $env:ACCEPT_PASSWORD='<your password>'; $env:KEEP_QUEUED_RUN='1'; npm run acceptance -w apps/web
# 7. Worker, one run (live LLM, about $4)
npm run worker -- --once
# 8. Restart the server (the acceptance tripped the login limiter), open http://localhost:3000/runs and check the run and the new case
# 9. Phone check over the LAN (docs/dashboard.md, "Open it on a phone")
```
