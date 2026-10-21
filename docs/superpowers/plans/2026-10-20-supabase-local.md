# Supabase (free) Database with Web + Worker on the Owner's PC

> For agentic workers: one implementer handles the whole plan, TDD (failing test first, capture RED), then one review. No live LLM calls; no real network in tests.

**Goal:** the owner runs `npm run web` and `npm run worker` on their PC against a free Supabase Postgres instead of local Docker. Owner decision, 2026-10-20: "I don't mind running code on my PC, let's do that with the free Supabase DB."

**Why code changes are needed:**
1. Both Postgres pools connect without TLS: `packages/core/src/db/client.ts` (CLI, worker, migrate, db:copy) and `apps/web/lib/db.ts` (web). A remote database over the internet needs encryption. This is the "Plan 4 TLS" item deferred in Plan 1.
2. Supabase's free session pooler allows only a small number of server connections (about 15). Today the core pool uses the pg default of 10 and the web pool 5, which can exhaust it when web, worker and a CLI command run together.
3. The core pool has no `error` listener. A dropped idle connection (pooler restart, Supabase maintenance) would crash the worker process.
4. pg 8.23 / pg-connection-string 2.14: query parameters in the URL (`sslmode=...`) OVERRIDE an explicit `ssl` option, and `sslmode=require` now means verify-full. So URL parameters would silently decide TLS behaviour.

**Global constraints:** all earlier rulings bind:
- Never print or log a connection string, password or certificate content.
- Error messages name variables, never values.
- The web layer imports only web-safe core modules (the new helper must not import the env loader, PGlite, the router or SDKs; it takes env values as arguments).
- R13, R20.
- Edit/Write tools only.
- Commit only when core + web suites, both typechecks and the web build are green, chained with `set -o pipefail` and without piping test output through tail/head.
- Branch `supabase`.

---

### T1: Shared Postgres pool config (`packages/core/src/db/pg-config.ts`, exported via the exports map)

- `pgPoolConfig(url: string, opts: { ssl?: string; sslCa?: string; poolMax?: string; defaultMax: number; readFile?: (p: string) => string }): pg.PoolConfig`. Pure function except for reading the CA file through the injected `readFile` (default `fs.readFileSync(p, 'utf8')`). It must be web-safe.
- **URL hygiene:**
  - Remove TLS query parameters (`sslmode`, `ssl`, `sslrootcert`, `sslcert`, `sslkey`, `sslpassword`, `uselibpqcompat`) from the connection string before it reaches pg, so the env settings below decide TLS.
  - Keep every other parameter.
  - Never include the URL in any thrown message.
- **`DATABASE_SSL`** (`opts.ssl`):
  - `auto` (default): plain TCP for local hosts (`localhost`, `127.0.0.1`, `::1`, `*.railway.internal`); verified TLS for everything else.
  - `verify`: TLS with `rejectUnauthorized: true`.
  - `require`: TLS without certificate verification (`rejectUnauthorized: false`; encrypted but not authenticated). Allowed only when explicitly chosen.
  - `disable`: plain TCP.
  - Anything else: throw `DATABASE_SSL must be one of auto, verify, require, disable`.
- **`DATABASE_SSL_CA`** (`opts.sslCa`):
  - An absolute path to a PEM file. When TLS is on, it is used as `ssl.ca`.
  - A relative path: throw `DATABASE_SSL_CA must be an absolute path`.
  - Unreadable file: throw `DATABASE_SSL_CA could not be read`, without the path.
  - Set together with `disable`, or with `auto` on a local host: ignored.
- **`DATABASE_POOL_MAX`** (`opts.poolMax`): integer 1–20. Otherwise throw a message naming the variable. Default `opts.defaultMax`.
- **Also set:** `connectionTimeoutMillis: 15000`, `idleTimeoutMillis: 30000`, `keepAlive: true`. A sleeping or paused Supabase then fails with a clear timeout instead of hanging.
- **Tests:**
  - TLS parameters stripped while other parameters are kept.
  - auto → no `ssl` for each local host form; auto → `{ rejectUnauthorized: true }` for `aws-0-ca-central-1.pooler.supabase.com`.
  - `verify` adds the CA when given.
  - `require` → `rejectUnauthorized: false`.
  - `disable` → none.
  - Invalid values, a relative CA path and an unreadable CA each throw a message without the value or path (assert that the password and the path are absent from the message).
  - Pool max default, override and invalid.
  - Timeouts present.

### T2: Use it in both pools

- `packages/core/src/db/client.ts`: postgres URLs build the pool from `pgPoolConfig(url, { ssl: process.env.DATABASE_SSL, sslCa: process.env.DATABASE_SSL_CA, poolMax: process.env.DATABASE_POOL_MAX, defaultMax: 4 })`. Reading `process.env` is fine here; this module is not web-safe and is never bundled by the web app. Add `pool.on('error', …)` that logs only `database pool: idle client error` and never crashes.
- `apps/web/lib/db.ts`: build the pool from `pgPoolConfig(webEnv().DATABASE_URL, { ssl: webEnv().DATABASE_SSL, sslCa: webEnv().DATABASE_SSL_CA, poolMax: webEnv().DATABASE_POOL_MAX, defaultMax: 5 })`. Keep the existing error listener.
- `apps/web/lib/env.ts`: add optional `DATABASE_SSL`, `DATABASE_SSL_CA`, `DATABASE_POOL_MAX` with the same validation messages, without echoing values. Make sure `next.config.ts` loads them from the repo-root `.env` exactly like the other variables.
- **Tests:**
  - core: `createDb` with a postgres URL passes the derived config to `pg.Pool`. Mock `pg` and assert the config, not a live connection. The error listener is attached and does not throw.
  - web: env parsing for the 3 variables (valid, invalid, no value echo); `getDb` builds the pool with `ssl` for a remote host.
  - The core-imports guard still passes; `pg-config` must be web-safe.

### T3: Docs

- `docs/dashboard.md`: a new section near the top, **"Free setup: Supabase database, app on your PC (no Docker)"**:
  1. Create a free Supabase project; save the database password, and prefer letters and digits only so it needs no URL encoding.
  2. Copy the **Session pooler** connection string (not the direct connection or transaction pooler: the worker holds connections and uses transactions and locks).
  3. Download Supabase's SSL certificate (Project settings → Database → SSL configuration) to a folder OUTSIDE the repo. Set `DATABASE_SSL_CA` to its absolute path. Fallback: `DATABASE_SSL=require` (encrypted, unverified).
  4. Put `DATABASE_URL`, `DATABASE_SSL_CA` (or `DATABASE_SSL=require`) and optionally `DATABASE_POOL_MAX` in the repo-root `.env`.
  5. Back up `.data/pglite` (copy the folder).
  6. Bring the local DB up to date: `DATABASE_URL=pglite://.data/pglite npm run db:migrate`, with PowerShell syntax too.
  7. `npm run db:migrate` (applies migrations to Supabase; the vector extension is created by the migration).
  8. `npm run db:copy -- --from pglite://.data/pglite` (`--to` defaults to `DATABASE_URL`, so the URL is never typed).
  9. Hash a password, set the session secret, and run `npm run web` plus `npm run worker`.
  10. Phone access on the same Wi-Fi.
  - **Notes:** Supabase free pauses after 7 days with no requests (unpause in its dashboard); it keeps no backups, so keep the local copy; free limits are 500 MB.
- `.env.example`: the three new variables, with comments.
- `docs/CONTEXT.md`: status plus a session-log entry. `docs/plan-1-followups.md`: tick the remote-Postgres TLS item.

### Done when
- All suites, both typechecks and the web build are green.
- Commits are grouped per task.
- The report is in the reply.
