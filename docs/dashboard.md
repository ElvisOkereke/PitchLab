# PitchLab dashboard: setup and operations

The setup and operations guide for PitchLab's private, single-owner dashboard. Start with the [README](../README.md)
for what PitchLab is and a quick start; the [user guide](user-guide.md) explains the workflow and the
[architecture](architecture.md) how it works inside.

The dashboard shows the pipeline board, the cases and their evidence, lets you move cases between stages, score them,
queue generator runs and validation packs, and log outreach you sent yourself. Queued work is executed by a separate
worker process (`npm run worker`). The dashboard never calls an LLM itself.

The dashboard and the worker must share one Postgres database (PGlite, the Plan 1 default, is single-process and
cannot be shared). Two ways to get one: a free Supabase database (next section, no Docker), or the local Docker
Postgres ("First-time setup" below). Either way, Node 22.12 or newer and `npm install` at the repo root.

## Free setup: Supabase database, app on your PC (no Docker)
The web app and the worker run on your PC; only the database is at Supabase. The connection is encrypted and the
server's certificate is always verified (there is no setting that turns verification off).

1. Create a free project at supabase.com. Save the database password it asks for. Prefer letters and digits only, so
   it needs no URL encoding.
2. Project → **Connect** → copy the **Session pooler** connection string (host like
   `aws-0-<region>.pooler.supabase.com`, port `5432`, user `postgres.<project-ref>`). Not the direct connection (IPv6
   only on the free plan) and not the transaction pooler (port 6543): the worker holds connections and uses
   transactions and locks. Put your password in place of `[YOUR-PASSWORD]`. Any `?sslmode=...` on the end can stay;
   the app removes it, because the settings below decide TLS.
3. Project settings → Database → **SSL configuration** → download the certificate. Save it in a folder OUTSIDE the
   repo (for example `C:/Users/<you>/supabase/prod-ca-2021.crt`) so it is never committed.
4. Put these in the repo-root `.env` (the web app, the worker and `db:copy` all read it):
   ```
   DATABASE_URL=postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
   DATABASE_SSL_CA=C:/Users/<you>/supabase/prod-ca-2021.crt
   # optional, integer 1 to 20 (default: web 5, worker and each CLI command 4)
   DATABASE_POOL_MAX=
   ```
   `DATABASE_SSL` can stay unset: `auto` uses verified TLS for every host except localhost. `DATABASE_SSL_CA` must be
   an absolute path; forward slashes work on Windows. The free session pooler allows about 15 connections: web (5) +
   worker (4) + one CLI command (4) fit, so leave `DATABASE_POOL_MAX` empty unless you see "too many clients".
5. Back up the local database: copy the `.data/pglite` folder (for example to `.data/pglite-backup-<date>`). Close
   anything using it first (`gen`, a worker, a dashboard on PGlite).
6. Bring the local database up to date (it may lack recent migrations). Git Bash:
   ```
   DATABASE_URL=pglite://.data/pglite npm run gen -- runs
   ```
   PowerShell:
   ```
   $env:DATABASE_URL='pglite://.data/pglite'; npm run gen -- runs; Remove-Item Env:DATABASE_URL
   ```
   Any `gen` command migrates the database it opens; `runs` only lists runs. The shell value wins over `.env`, so this
   touches the local folder, not Supabase. (`npm run db:migrate` is not used here: it runs inside `packages/core`, so
   a relative `pglite://` path would point at a new, empty `packages/core/.data/pglite`.)
7. Migrations on Supabase: nothing to run by hand. `db:copy` in the next step applies every migration to the target
   first, including `CREATE EXTENSION vector`. Starting fresh with no old data instead? Skip step 8 and run
   `npm run gen -- runs` once with nothing set in the shell: it reads `.env` and migrates Supabase.
8. Copy the local data to Supabase, once:
   ```
   npm run db:copy -- --from pglite://.data/pglite
   ```
   `--to` defaults to `DATABASE_URL`, so the URL (with your password) is never typed or echoed. The target must be
   empty (a new project is). It prints a table and ends with "Copy complete: every table matches." Details and errors:
   "First-time setup" step 3 below.
9. Choose a dashboard password and a session secret ("First-time setup" steps 4 and 5), add `LLM_API_KEY` for the
   worker, then run in two terminals:
   ```
   npm run web
   npm run worker
   ```
10. Phone on the same Wi-Fi: see "Open it on a phone" below.

Notes:
- Supabase's free plan pauses a project after 7 days without requests. The app then fails with a connection timeout
  after 15 s; unpause the project in the Supabase dashboard.
- The free plan keeps no backups you can restore. Keep your local copy (step 5) and copy again if you need a snapshot.
- Free limits: 500 MB database.
- Certificate error when connecting ("self-signed certificate in certificate chain", "unable to get local issuer
  certificate", "Hostname/IP does not match"): the CA file is missing or wrong, or the URL is not the session pooler.
  Re-download the certificate from step 3 and check the path. If it still fails with the downloaded file, try leaving
  `DATABASE_SSL_CA` empty: the connection is then still verified, against the public certificate authorities built
  into Node. Never disable verification.
- `DATABASE_SSL_CA could not be read`: the file is not at that path (the message never shows the path).

## Prerequisites (local Docker Postgres)
- Node 22.12 or newer (`package.json` does not pin it yet; see `docs/plan-1-followups.md`).
- `npm install` done at the repo root.
- Docker Desktop, for the local Postgres in `docker-compose.yml`. Not needed with the Supabase setup above.

## First-time setup
All variables go in the repo-root `.env` (there is no `apps/web/.env`). `.env.example` lists every name.

1. Start Postgres (Docker Desktop must be running):
   ```
   docker compose up -d
   ```
   It listens on `127.0.0.1:5433` only. User `bcg`, password `bcg_local_dev` (a local-only dev value), database `bcg`.
2. Point the app at it in `.env`:
   ```
   DATABASE_URL=postgres://bcg:bcg_local_dev@127.0.0.1:5433/bcg
   ```
3. Copy your existing PGlite data into it, once (the PGlite folder `.data/pglite` is only read, never changed):
   ```
   npm run db:copy -- --dry-run     # optional: checks migrations and prints source row counts, copies nothing
   npm run db:copy -- --from pglite://.data/pglite
   ```
   - `--to` defaults to `DATABASE_URL`. The script never prints the URL, but npm echoes the command line, so a URL
     passed with `--to` (password included) appears in the terminal. Prefer leaving `--to` out.
   - It applies the migrations to the target, checks that source and target recorded the same migrations, copies every
     table, and prints a SOURCE / INSERTED / TARGET / OK table. It exits 0 only when every table matches
     ("Copy complete: every table matches."), 1 on a row-count mismatch, 2 on a usage or migration problem.
   - The target must be EMPTY (a fresh `docker compose up -d`). Rows are inserted with ON CONFLICT DO NOTHING, so a
     target that already holds rows keeps its own version of any conflicting row, and counts can match while rows differ.
   - Close anything else using the PGlite folder first (`gen`, a worker, a dashboard on PGlite).
   - If it says "Local DB is behind the code", migrate the local database first, then copy:
     `DATABASE_URL=pglite://.data/pglite npm run gen -- runs` (PowerShell: see the Supabase section, step 6). Any
     `gen` command migrates the database it opens, and the shell value wins over `.env`. Do not use
     `npm run db:migrate` for this: it runs inside `packages/core` and resolves `pglite://.data/pglite` there, so it
     migrates a new, empty `packages/core/.data/pglite` instead. Expect this the first time: the local database made
     before Plan 2 lacks migration `0006_stage_events` (seen in the 2026-10-20 acceptance).
   - If `assertSameMigrations` reports a mismatch while the counts match, the migration hashes differ, usually
     because of CRLF line endings on Windows. Re-checkout `packages/core/drizzle/*.sql` as LF
     (`git ls-files --eol` shows the endings; `git checkout -- packages/core/drizzle`), drop and recreate the target
     (`docker compose down -v`, then `docker compose up -d`), and copy again.
   - Starting fresh instead (no old data)? Skip this step and run `npm run gen -- runs` once with nothing set in the
     shell: it reads `.env` and migrates `DATABASE_URL` (any `gen` command migrates the database it opens; `runs` only
     lists runs). Do not use `npm run db:migrate` for this: it does not read `.env`, and it runs inside `packages/core`,
     so with no `DATABASE_URL` in the shell it migrates a new, empty `packages/core/.data/pglite` instead.
4. Choose a password (at least 12 characters) and hash it. Interactive (input is hidden, asked twice):
   ```
   npm run hash-password -w apps/web
   ```
   or piped: `printf 'your-password-here\nyour-password-here\n' | npm run hash-password -w apps/web`.
   Put the printed line in `.env` as `OWNER_PASSWORD_HASH=...`. The hash uses `:` separators and never `$`,
   because Next.js expands `$NAME` inside `.env` values. The password itself is never stored or printed.
5. Generate a session secret and put it in `.env` as `SESSION_SECRET=...`:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
6. Worker keys: the worker (and `gen`) also need `LLM_API_KEY` in `.env` (see the table). The web app never reads it.

## Updating PitchLab
After pulling a new version: stop the web app, run `npm run gen -- runs` (or start the worker) once so the database
is migrated, then start the web app again. Only `gen` and the worker migrate; a web app on an older database shows
errors on every signed-in page.

## Daily use
```
npm run web        # the dashboard, http://localhost:3000 (next dev)
npm run worker     # second terminal: runs what you queue from the Runs screen
```
Stop the worker with Ctrl+C (it finishes the current run first; a second Ctrl+C exits at once and leaves that run
`running`: recover it with `npm run gen -- resume <runId>`). `npm run worker -- --once` handles one queued run and exits;
`--interval <seconds>` sets how often an idle worker checks the queue (default and minimum are in `gen worker --help`).

## Open it on a phone (same Wi-Fi)
1. Find the PC's LAN IP (`ipconfig`, the IPv4 address of the Wi-Fi adapter).
2. In `.env` set `DEV_ORIGINS=<that IP>` (comma list for several), then restart the dashboard bound to all interfaces:
   ```
   npm run dev -w apps/web -- -H 0.0.0.0
   ```
3. On the phone open `http://<LAN IP>:3000`.
4. Windows Firewall: allow Node.js for **Private** networks only, never Public.

`next dev` over plain http works for this with no cookie settings. Production mode is different: if you run
`npm run build -w apps/web` and `npm run start -w apps/web` over plain http (for example on localhost), you need BOTH
`COOKIE_SECURE=false` and `ALLOW_INSECURE_COOKIE=true`. With only the first, the app refuses to start, by design.
`npm run build` reads the web env at build time, so the web variables must be present (dummy values are fine
for building; use real ones to run). Over HTTPS (a tunnel, or later Railway) leave `COOKIE_SECURE` unset: it defaults
to true in production. Through a tunnel host also add that host to `ALLOWED_ORIGINS` (and `DEV_ORIGINS` for `next dev`).

## Environment variables
Web app variables are validated at startup by `apps/web/lib/env.ts`; the error names the variable and the rule, never the value.

| Name | Required? | Default | Meaning and notes |
|---|---|---|---|
| `DATABASE_URL` | Web: yes. Worker/CLI: no | Core default `pglite://.data/pglite` | Web app: `postgres://` or `postgresql://` only. The worker and `gen` also accept `pglite://`, but then the dashboard cannot share it. |
| `DATABASE_SSL` | No | `auto` | Web, worker and CLI. `auto`: plain TCP for `localhost`, `127.0.0.1`, `::1` and `*.railway.internal`, verified TLS for every other host. `verify`: always verified TLS. `disable`: plain TCP. Anything else (including `require`) is refused: there is no mode that skips certificate verification. `*.railway.internal` hosts use plain TCP because they are reachable only inside Railway's private network. TLS parameters in `DATABASE_URL` (`sslmode`, `ssl`, `sslrootcert`, `sslcert`, `sslkey`, `sslpassword`, `uselibpqcompat`, `sslnegotiation`) are removed and have no effect. |
| `DATABASE_SSL_CA` | No | unset | Absolute path to a PEM CA certificate that verifies the database server (Supabase: the downloaded SSL certificate). Used only when TLS is on. Keep the file outside the repo. |
| `DATABASE_POOL_MAX` | No | web `5`, worker/CLI `4` | Integer 1 to 20: connections per process. Keep the total under the database's limit (Supabase free session pooler: about 15). |
| `OWNER_PASSWORD_HASH` | Web: yes | none | `scrypt:N:r:p:salt:key` from `npm run hash-password -w apps/web`. Colons only, never `$`. |
| `SESSION_SECRET` | Web: yes | none | At least 32 characters. Signs the session cookie; changing it logs out every device. |
| `TRUST_PROXY_HOPS` | No | `0` | Integer 0 to 3: how many reverse proxies in front of the app have their `X-Forwarded-For` entry trusted for the login rate limit. Use `1` behind Railway. With `0` all login attempts share ONE rate-limit bucket, so an attacker can block new logins for up to 10 minutes; a session you already hold (7 days) is unaffected. |
| `ALLOWED_ORIGINS` | No | empty | Comma list of extra hosts allowed to submit forms, as exact `host[:port]` (or a full URL). No wildcards. For a tunnel or the public host. |
| `COOKIE_SECURE` | No | `true` when `NODE_ENV=production`, else `false` | `true`/`false`/`1`/`0`. Secure (`__Host-`) session cookie. |
| `ALLOW_INSECURE_COOKIE` | No | unset | Must be `true` together with `COOKIE_SECURE=false` under production mode, else startup fails. Only for http on localhost. |
| `DEV_ORIGINS` | No | empty | Dev only: comma list of hostnames (such as the LAN IP) allowed to load `next dev` resources, so a phone can use it. |
| `TEST_DATABASE_URL` | No | unset | Enables the real-Postgres tests. Use a THROWAWAY database only; tests write to it. |
| `LLM_API_KEY` | Worker/CLI: yes | none | LLM gateway key. The web app never needs it and never sees it. |
| `LLM_ANTHROPIC_BASE_URL` | No | `https://api.fuelix.ai` | Worker/CLI only. |
| `LLM_OPENAI_BASE_URL` | No | `https://api.fuelix.ai/v1` | Worker/CLI only. |
| `LLM_MAX_CONCURRENCY` | No | `4` | Worker/CLI only. Integer, at least 1. |
| `MODEL_OVERRIDES` | No | `{}` | Worker/CLI only. JSON object of stage to model name. |
| `GITHUB_TOKEN` | No | unset | Worker/CLI only. GitHub API verification and signals. |
| `STACKEXCHANGE_KEY` | No | unset | Worker/CLI only. |
| `GOOGLE_PLACES_API_KEY` | No | unset | Worker/CLI only. Enables the Places prospect source. |

Empty values in `.env` count as unset. There are no `NEXT_PUBLIC_*` variables: no setting reaches the browser bundle.

## Screens
- **Board** (`/`): cases in columns New, Validating, Pilot, Live, Killed, with filters. Killed also lists ideas the
  generator's gate killed, each with its failed checks and a "Re-run as owner idea" button (queues a run for that idea,
  roughly $4; refused when 3 runs are already queued).
- **Leaderboard**: every case with totals and per-criterion `ai/owner` scores; column headers sort.
- **Command center**: what needs you, spend today and this week (Toronto days), worker status, latest runs.
- **Case page** (click a case): header with the stage-move form, then tabs.
  - **Summary**: one-liner, buyer, problem, solution, price, gate verdicts (failed checks first) and "For you to check", the items the system could not confirm itself.
  - **Evidence**: the signals and sources behind the case, with verification flags.
  - **Numbers**: the ROI inputs and formulas.
  - **Competitors**: competitors and what was confirmed about them.
  - **Pitch**: the pitch text.
  - **Validate**: the **Generate validation pack** button (with Prospects to find, Skip new prospect search, Refresh
    the pack documents and Write the emails again; it reads "Run validation again" once a pack exists; if the worker stopped, start it and press that button again), the job's
    status, the validation pack, prospects, drafted emails, and a form to log outreach outcomes and interview notes.
  - **Score**: your scores for the 8 criteria.
- **Runs**: queue a run (open, sector, lens or owner idea) and follow the history; failed runs can be re-queued.
- **Settings**: sender and landing settings (editable), the example case (Hide example case, Reset example case),
  worker heartbeat, database status, models, lenses, market, criteria.
- **Take the tour** (top bar, every page): replays the guided tour, continues it, or runs one chapter. It starts by
  itself on your first login. Progress is saved in the database, so it follows you between devices.

How things work:
- **Stage moves:** from the header. Moving to Killed requires a note (stored as the kill reason). Leaving Killed is
  logged as an overturn ("Overturn kill" on a killed case or card moves it back to New). A move from a stale page changes nothing.
- **Scoring:** 8 criteria, 1 to 5 plus a note: Pain severity, Buyer ROI clarity, Evidence strength, Speed to market,
  Autonomy, Novelty/non-generic, Reachability, Your gut. The AI scores the first seven; `gut` is yours only.
- **Outreach log:** on the Validate tab pick an outcome per prospect (sent, replied, positive, meeting, not interested,
  unsubscribe) with an optional note. "Interview note" requires a note (what you learned) and counts as an interview
  for the validation checklist. This only records what you did; the system sends nothing.
- **Queueing a run:** Runs screen. Needs `npm run worker` running, otherwise the run stays queued. At most 3 runs
  can be queued at once. The page refreshes every 10 s while something is queued or running.
- **Generating a validation pack:** Validate tab, **Generate validation pack**. It costs about $0.60–1.50 (the
  prospect search is about $0.45–0.60 of that; tick "Skip new prospect search" to avoid it). It needs the sender name,
  mailing address and contact set in Settings, and `npm run worker` running. The worker takes queued runs first, then
  validation jobs. One job per case can be queued or running at a time, and at most 3 can wait in total. A job still
  "running" after 2 hours (the worker was stopped) no longer blocks a new one: start the worker and press "Run
  validation again". The worker also writes the files to `output/validation/<slug>/` on its own computer. Same as
  `npm run gen -- validate <slug>`.
- **The example case:** a built-in, invented case (marked Example) for practice and for the tour. It is created by
  any `gen` command, never spends money, is left out of spend, counts and "Needs you", and cannot be validated (it
  ships with a pack). Settings → **Hide example case** removes it from the board, and later `gen` commands keep it
  hidden. **Reset example case** restores it as shipped and shows it again, removing your practice scores and notes on
  it. Neither touches real cases.

## Security, in plain words
- Single owner: one password, checked against a scrypt hash. A signed session cookie (7 days) keeps you in.
- Failed logins are rate limited: 5 failures per client per 10 minutes, and 30 overall. The limiter is in memory and
  resets when the server restarts. See `TRUST_PROXY_HOPS` above for what the client key is.
- No secrets are in the browser bundle (no `NEXT_PUBLIC_*`; `npm run check-bundle -w apps/web`, run with the same env
  as the build, searches `.next/static` for the secrets, the LLM key and server-only markers). All case text is rendered as text, never HTML.
- Log out everywhere by changing `SESSION_SECRET`.
- Never expose the app to the internet without TLS (HTTPS). Over plain http the password and cookie travel readable.
- What the system never does: send email (it drafts; you send), or fetch, list or contact a pilot site you name with
  `--pilot-site` or that is on the never-fetch list in code (there is no permission to contact it).

## Deploying later (Plan 4, short)
Railway: a Postgres service, a web service (`next start`) and a worker service (`npm run worker`) sharing the same
`DATABASE_URL`. Set `TRUST_PROXY_HOPS=1`, `ALLOWED_ORIGINS=<the public host>`, and serve HTTPS only. Postgres TLS is
handled by `DATABASE_SSL` / `DATABASE_SSL_CA` (a `*.railway.internal` host is plain TCP under `auto`; a public proxy
host is verified TLS and may need `DATABASE_SSL_CA`). The rate limiter still needs a shared store (`docs/plan-1-followups.md`).

## Acceptance check (after a change, or on a new machine)
With a production build running (`npm run build -w apps/web`, then `npm run start -w apps/web`, plain http so
`COOKIE_SECURE=false` and `ALLOW_INSECURE_COOKIE=true`):
```
BASE_URL=http://localhost:3000 ACCEPT_PASSWORD=<your password> npm run acceptance -w apps/web
```
It reads the same env as the server (the shell first, else the repo-root `.env`). PowerShell:
`$env:BASE_URL='http://localhost:3000'; $env:ACCEPT_PASSWORD='<your password>'; npm run acceptance -w apps/web`. It submits every form the way a browser without JavaScript does and prints PASS/FAIL per
check (routes behind login, login cookie, board counts, every case tab and export, stage moves, scores, hostile posts,
queueing a run, logout, the login rate limit, the bundle scan). Every write it makes is undone (its stage events,
score rows and queued run are deleted again); `KEEP_QUEUED_RUN=1` keeps the queued run so `npm run worker -- --once`
can execute it (live LLM, about $1). The last check trips the login rate limiter on purpose: restart the server afterwards.

## Troubleshooting
- **App refuses to start** (`Invalid web environment: NAME (rule)`): fix the named variable in the repo-root `.env`
  and restart. `COOKIE_SECURE (false in production...)` means you also need `ALLOW_INSECURE_COOKIE=true` for http on localhost.
- **"Too many attempts. Try again in 10 minutes."**: the login limiter tripped. Wait, or restart the dashboard (the limiter
  is in memory). With `TRUST_PROXY_HOPS=0` everyone shares one bucket.
- **Database not reachable**: Settings shows Database "not reachable"; other pages fail with an error. Docker setup:
  start Docker Desktop, run `docker compose up -d`, and check `DATABASE_URL`. Supabase setup: unpause the project if
  it was idle for 7 days; a certificate error means a missing or wrong `DATABASE_SSL_CA` (see the Supabase notes).
- **`Invalid web environment: DATABASE_SSL...` / `DATABASE_SSL_CA...` / `DATABASE_POOL_MAX...`** (or the same names from
  the worker): `DATABASE_SSL` must be auto, verify or disable; `DATABASE_SSL_CA` an absolute path to a readable file;
  `DATABASE_POOL_MAX` an integer from 1 to 20.
- **Queued runs never start**: the worker is not running (Command center shows worker status). Start `npm run worker`;
  it needs `LLM_API_KEY` and the same `DATABASE_URL`.
- **A run stays "running" after the worker was killed**: `npm run gen -- resume <runId>`.
- **A validation job stays "Waiting for the worker"**: start `npm run worker`. It takes queued runs first, so a
  validation job waits until no run is queued.
- **No "Generate validation pack" button**: the case is the example (it ships with a pack), or the sender details are
  missing (the tab links to Settings).
- **Migration hash mismatch during `db:copy`**: see setup step 3 (LF line endings in `packages/core/drizzle/*.sql`).
- **`npm run build -w apps/web` fails on env**: set the web variables (dummy values are fine to build).
