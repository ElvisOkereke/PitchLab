# Research Reach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. TDD per task (failing test first, capture RED). No live network or model calls in tests: mock the YouTube API, the archive, Playwright and the router. Local loopback sockets for proxy tests are fine. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Widen and harden research collection:
- log every page fetch's outcome;
- add YouTube comments through the official API, honouring the 30-day data rule;
- fall back to the Internet Archive for blocked or missing pages;
- render JavaScript-heavy pages in an optional local Chromium behind an SSRF-safe proxy.

**Architecture:**
- **`research/collect.ts` (`collectPage`)** wraps `fetchPage` with diagnostics and fallbacks: direct → thin text → browser, or direct failure → archive. Missions use it.
- **`research/archive.ts`** is the Wayback client.
- **`research/browser/`** holds a guarded forwarding proxy plus an optional Playwright loader.
- **`research/sources/youtube.ts`** has a quota guard.
- **`maintenance.ts`** prunes diagnostics and expires YouTube data (with redaction). It runs on `openDb`, at worker start and every 24 hours.
- **Migration 0011** only adds things.

**Tech Stack:** existing, plus an optional dependency `playwright-core` (dynamic import; exact version pinned at the time, at least two weeks old). No other dependencies.

**Spec:** `docs/superpowers/specs/2026-10-28-research-reach-design.md`. Binding, including "Decisions settled after the design review".

**Branch:** `reach` in the sibling worktree `Y:/CODING PROJECTS/Business_Case_Gen-reach`, with its own `npm install` and no `.env`. Migration `0011` (`npx drizzle-kit generate --name research_reach` in `packages/core`).

## Global Constraints

- **No evasion:**
  - The PitchLab user agent (`USER_AGENT` from `research/http.ts`) is used for direct, archive and browser requests.
  - No stealth, no fake user agents, no proxies other than our own loopback guard, no CAPTCHA solving, no logins.
  - robots.txt is checked before direct, archive and browser fetches.
  - Banned and never-fetch hosts are refused on every hop.
- **SSRF:**
  - Every network request goes through the guarded lookup with address pinning: `fetchPage`, `getJson`/`getBody`, `request()` to fixed hosts, or the browser proxy.
  - The browser can only reach the network through the guarded proxy.
  - Redirects leaving `web.archive.org` are refused.
- **YouTube:**
  - Only the official API, with `YOUTUBE_API_KEY` (optional; skipped without it).
  - Quota guard: stop at 90 search calls or 9,000 units per Pacific day, and at most 5 searches per mission.
  - No author or channel fields are stored. URLs are plain video URLs.
  - Every YouTube source expires after 30 days (`expires_at`). Expiry deletes and redacts per the spec.
- **Archive:** used only after a direct `http_403`, `http_404`, `http_410`, `http_5xx` or `timeout` when robots.txt allowed the URL. Snapshots must be 3 years old or newer. At most 1 request per second; a 429 stops the archive for the rest of the mission with a warning.
- **Browser:** optional (works without it). Used only on `thin_text` (under 800 readable characters). GET only; images, media and fonts blocked; 20-second timeout; up to 3 pages at once; a temporary profile per mission.
- **Existing rulings bind:**
  - Privacy scrub; verified-quote rules (at least 6 words / 30 characters, verbatim in the collected text).
  - Untrusted text wrapped; soft budgets; bounded queries; bound parameters only.
  - R13 and R20; web-safe imports and `check-bundle` (Playwright must never reach the web bundle).
- **Merge gates:**
  - `npm test -w packages/core`, `npm test -w apps/web`, `npm run typecheck -w apps/web`, `npx tsc --noEmit -p packages/core`, the web build with dummy env, and `check-bundle`.
  - Chain them with `set -o pipefail`.
  - Secret scan, including `YOUTUBE_API_KEY`.
- **Environment:**
  - Never run `gen` or db commands without an explicit `DATABASE_URL=pglite://<temp under .data/>`.
  - Never touch the owner's checkout or Supabase.
  - Commits end with the committing agent's `Co-Authored-By` trailer.

## Review Focus

1. **A browser page that fetches a private address** (a script calling `http://169.254.169.254/` or `http://localhost:5432`), or a DNS name that resolves to one. Expected: the proxy refuses it and the page never receives a response. Pinned in Task 3.
2. **The YouTube quota is exhausted mid-mission, or the API returns 403 quotaExceeded.** Expected: YouTube stops for the rest of that mission with a warning, the mission continues, and the counters stay correct. Pinned in Task 4.
3. **The worker is down for more than 30 days, then any `gen` command runs.** Expected: expired YouTube data is removed or redacted before anything else uses the database. Pinned in Tasks 1 and 4.
4. **A Wayback snapshot redirects to another host, or archive.org returns 429.** Expected: the redirect is refused and the 429 stops the archive with a warning. Pinned in Task 2.
5. **Chromium is not installed.** Expected: thin pages stay as they are (`thin_text` logged), and missions run normally. Pinned in Tasks 2 and 3.

---

### Task 1: Schema, fetch diagnostics and maintenance

**Files:**
- Modify: `packages/core/src/db/schema.ts`; generate `0011`.
- Create: `packages/core/src/research/fetch-log.ts`, `packages/core/src/maintenance.ts`.
- Modify: `packages/core/src/cli.ts` (`openDb` calls `runMaintenance` quietly, logging only a count), `packages/core/src/worker.ts` (maintenance at start and every 24 hours, with the last-run time in setting `maintenance.lastRun`), `packages/core/src/library/store.ts` (`libraryCoverage` gains `socialShare`).
- Test: `test/research/fetch-log.test.ts`, `test/maintenance.test.ts`, extend the store and worker tests.

**Interfaces:**
- **Schema:**
  - pgEnum `fetch_outcome` = `['ok', 'http_403', 'http_404', 'http_410', 'http_4xx', 'http_5xx', 'timeout', 'blocked_robots', 'blocked_host', 'too_large', 'not_html', 'thin_text', 'network']`
  - pgEnum `fetch_via` = `['direct', 'archive', 'browser']`
  - table `pageFetches`:
    - `id`, `urlDomain`, `outcome`, `via`, `status` (int nullable)
    - `missionId` (nullable FK), `runId` (nullable FK), `at`
    - index `(at)`, index `(url_domain)`
  - `knowledgeSources` gains `expiresAt` (timestamp nullable), `via` (`fetch_via`, default `'direct'`) and `snapshotAt` (timestamp nullable).
- **`fetch-log.ts`:**
  - `classifyFetch(result: PageResult | { robots: false } | { thin: true }): FetchOutcome`
  - `recordFetch(db, { url, outcome, via, status?, missionId?, runId? }): Promise<void>`: stores the registrable domain only, and never throws (it logs instead).
  - `fetchStats(db, { days = 30 }): Promise<{ total; ok; okRate: number | null; byVia: Record<FetchVia, { total; ok }>; byOutcome: Record<string, number>; topFailing: { domain; failures; topOutcome }[] }>`, with top failing capped at 10.
- **`maintenance.ts`:** `runMaintenance(db, now = new Date()): Promise<{ prunedFetches: number; expiredSources: number; deletedItems: number; redactedSignals: number; redactedClaims: number }>`. In one transaction per step:
  1. delete `page_fetches` older than 90 days;
  2. delete `knowledge_sources` with `expires_at < now`, then delete entries left with no sources;
  3. redact `signals` where `source = 'youtube'` and their `fetched/created` time plus 30 days < now and the quote isn't already the placeholder: quote and title become `[expired YouTube data]`, `embedding = null`, and `quoteHash = sha256('[expired YouTube data]' + id)`;
  4. for `claims` whose `sourceUrl` host is `youtube.com`, `www.youtube.com` or `youtu.be`, and whose case was created more than 30 days ago with a non-null quote: set `quote = null` and the review note "YouTube quote removed after 30 days".
- **`libraryCoverage`:** `socialShare` = the share of active entries' sources whose `source_type` is one of `youtube`, `hn`, `stackexchange`, `github`, `appstore` or `producthunt`.

- [ ] **Step 1: Write the failing tests:**
  - The classifier maps every `PageResult` failure and status to an outcome (403 → `http_403`, 404 → `http_404`, 410 → `http_410`, other 4xx → `http_4xx`, 5xx → `http_5xx`, timeout, too_large, not_html, blocked).
  - `recordFetch` stores the domain only and swallows errors.
  - `fetchStats`: rates, the by-via split, top failing, and that it is bounded.
  - Maintenance: each step is tested, including redaction keeping `(url, quote_hash)` unique, idempotence (a second run does nothing), and a non-YouTube signal or claim staying untouched.
  - `openDb` runs maintenance; the worker runs it at start and when 24 hours have passed.
  - `socialShare`.
- [ ] **Step 2: Run** `npm test -w packages/core -- fetch-log maintenance store worker`. Expected: FAIL.
- [ ] **Step 3: Implement.** Generate 0011 and check it only adds things.
- [ ] **Step 4: Run** the core and web suites, both typechecks. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): fetch diagnostics and data maintenance`.

### Task 2: `collectPage` with archive fallback, used by missions (and diagnostics in verify)

**Files:**
- Create: `packages/core/src/research/archive.ts`, `packages/core/src/research/collect.ts`.
- Modify: `packages/core/src/research/mission.ts` (use `collectPage` for web URLs; store `via` and `snapshotAt` on sources), `packages/core/src/pipeline/verify.ts` (`recordFetch` diagnostics only).
- Test: `test/research/archive.test.ts`, `test/research/collect.test.ts`, extend the mission and verify tests.

**Interfaces:**
- **`archive.ts`:**
  - `archiveSnapshot(url, opts: { fetchJson?; now?: () => Date; maxAgeYears = 3 }): Promise<{ snapshotUrl: string; timestamp: Date } | null>`. Calls `https://archive.org/wayback/available?url=` through the guarded helpers, throttled to 1 request per second, and throws `SourceError('rate_limited')` on 429.
  - `fetchArchived(snapshot, deps: { fetchPage }): Promise<PageResult>`. Uses the raw `id_` form, the PitchLab user agent, and refuses redirects off `web.archive.org`.
- **`collect.ts`:**
  - `collectPage(url, ctx: { db; fetchPage; robotsAllows; archive?: ArchiveClient; browser?: BrowserRenderer | null; missionId?; log; state: { archiveDisabled: boolean } }): Promise<{ text; title; finalUrl; via: FetchVia; snapshotAt?: Date } | { failed: FetchOutcome }>`.
  - Order:
    1. robots → `blocked_robots`;
    2. direct `fetchPage` (blockHosts = banned);
    3. on ok with readable text under `THIN_TEXT_CHARS = 800` → the browser if available, otherwise return the thin text with outcome `thin_text`;
    4. on 403/404/410/5xx/timeout → the archive, if not disabled, robots allowed `web.archive.org`, and the snapshot is new enough.
  - Every attempt is recorded with `recordFetch`.
  - A 429 from the archive sets `state.archiveDisabled` and adds a warning.
- **Mission:** each source records `via` and `snapshotAt`. The Library entry detail shows "from an archived copy (date)" (wired in Task 5).

- [ ] **Step 1: Write the failing tests:**
  - archive: no snapshot → null; too old → null; 429 → rate_limited; a redirect off-host is refused.
  - collect: robots deny → no fetch and no archive; a 403 falls back to the archive with `via: 'archive'`; 404 and timeout fall back; a thin page goes to the browser when given, or stays `thin_text` when the browser is null; the archive is disabled after a 429; every attempt is logged.
  - mission: sources carry `via` and `snapshotAt`; quote verification uses the archived text.
  - verify: logs diagnostics and nothing else changes.
- [ ] **Step 2: Run** `npm test -w packages/core -- archive collect mission verify`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the core suite and core tsc. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): collectPage with Internet Archive fallback`.

### Task 3: Guarded proxy and optional local browser

**Files:**
- Create: `packages/core/src/research/browser/proxy.ts`, `packages/core/src/research/browser/render.ts`.
- Modify: `packages/core/package.json` (`playwright-core` in `optionalDependencies`, exact version), `packages/core/src/cli.ts` (build a renderer when available and pass it to missions).
- Test: `test/research/browser/proxy.test.ts` (real loopback sockets, injected resolver), `test/research/browser/render.test.ts` (Playwright mocked).

**Interfaces:**
- **`proxy.ts`:** `startGuardedProxy(opts: { lookup?: GuardedLookup; isBlockedHost: (host) => boolean; allowLoopbackForTests?: boolean }): Promise<{ port: number; close(): Promise<void> }>`.
  - Handles HTTP `CONNECT` (tunnel to the pinned IP:443 only) and plain-HTTP absolute-URL GET.
  - Resolves with the guarded lookup and pins the address.
  - Refuses private, loopback and link-local addresses, banned and never-fetch hosts, and methods other than CONNECT or GET, with 403.
  - Binds `127.0.0.1` only, on a random port.
- **`render.ts`:**
  - `loadBrowser(): Promise<BrowserLike | null>`: dynamic `import('playwright-core')`, then checks `chromium.executablePath()` exists. Null otherwise.
  - `createRenderer(browser, proxy): BrowserRenderer`, with `render(url): Promise<{ html; finalUrl } | null>`.
    - Context: user agent `USER_AGENT`, proxy `http://127.0.0.1:<port>`, `bypass: ''`, JavaScript on, `acceptDownloads: false`, pop-ups closed.
    - `page.route`: abort anything not GET, and abort images, media and fonts.
    - 20-second navigation timeout; at most 3 pages at once.
  - `closeRenderer()`: deletes the temporary profile.
  - Readable text comes from the existing extraction.
- **CLI:** a mission builds `{ proxy, renderer }` only when `loadBrowser()` returns non-null, and closes both after the mission.

- [ ] **Step 1: Write the failing tests:**
  - **Proxy:** `CONNECT` to a host resolving to 10.0.0.1, 127.0.0.1 or 169.254.169.254 → 403 and no upstream socket; a banned host → 403; `POST` → 403; plain GET to an allowed (test-resolver) upstream → proxied; DNS answers are pinned (the resolver is called once per request, and the connection goes to that address); it listens on 127.0.0.1 only.
  - **Render** (mocked Playwright): proxy settings passed; non-GET and image routes aborted; timeout respected; concurrency limited to 3.
  - **`loadBrowser`** returns null when the import fails or the executable is missing.
- [ ] **Step 2: Run** `npm test -w packages/core -- proxy render`. Expected: FAIL.
- [ ] **Step 3: Implement.** Make sure core `tsc` passes without `playwright-core` installed, by using a local typed interface for what we call.
- [ ] **Step 4: Run** the core suite, core tsc, the web build and check-bundle. Expected: PASS, with Playwright absent from the web bundle.
- [ ] **Step 5: Commit** `feat(core): guarded proxy and optional local browser rendering`.

### Task 4: YouTube source, quota and expiry

**Files:**
- Create: `packages/core/src/research/sources/youtube.ts`, `packages/core/prompts/library-plan.v3.md`.
- Modify: `packages/core/src/research/mission.ts` (the youtube source as a free source; YouTube sources get `expiresAt = fetchedAt + 30d`; re-collecting refreshes it), `packages/core/src/library/store.ts` (`addSource` refreshes `fetchedAt` and `expiresAt` on conflict for YouTube), `packages/core/src/config/env.ts` (optional `YOUTUBE_API_KEY`), `packages/core/src/worker.ts` (`providers.youtube`).
- Test: `test/research/sources/youtube.test.ts`, extend the mission and store tests.

**Interfaces:**
- `youtubeSearch(q, opts: { apiKey?; regionCode?; maxVideos = 5; commentsPerVideo = 100; db; missionId?; fetch? }): Promise<RawItem[]>`.
  - Calls `search.list`, then `videos.list`, then `commentThreads.list` (top-level comments, `order=relevance`, `textFormat=plainText`).
  - Returns one item per comment (`sourceType: 'youtube'`, url = the plain video URL, text = the comment) plus one item for the title and description.
  - It never reads author fields.
  - Without a key it returns `[]` with no request.
- **Quota:** atomic counter keyed by Pacific date (`youtube_quota` table or a jsonb setting via a single `UPDATE … RETURNING`). It checks before each call: search ≤ 90/day, units ≤ 9,000/day, searches per mission ≤ 5. A 403 `quotaExceeded` stops YouTube for the mission with the warning "YouTube daily quota reached".
- **Planner:** `library-plan.v3` adds the youtube source with guidance ("videos where people describe the problem: reviews, how-tos, complaints; comments are the evidence").
- **Expiry:**
  - YouTube sources set `expiresAt`, and re-collecting refreshes it.
  - Maintenance from Task 1 deletes and redacts.
  - Test the end-to-end path: collect → store with `expiresAt` → advance the clock 31 days → `runMaintenance` → the source is gone, the entry is deleted when it was YouTube-only, run signals and claims are redacted.

- [ ] **Step 1: Write the failing tests:**
  - Mapping with no author fields.
  - No key → no request.
  - The quota guard: per-day caps, per-mission cap, atomic increments under two concurrent calls, `quotaExceeded` stops.
  - The planner offers youtube only with a key.
  - Expiry end to end; refresh on re-collect.
- [ ] **Step 2: Run** `npm test -w packages/core -- youtube mission store maintenance`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the core suite, core tsc, and the web suite and typecheck. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): YouTube comments source with quota guard and 30-day expiry`.

### Task 5: Dashboard, Connections and docs

**Files:**
- Modify:
  - `apps/web` Library coverage card: fetch diagnostics (success rate over 30 days overall and by via, top failing domains with reasons) and social share.
  - Library entry detail: "from an archived copy (date)" and YouTube sources' "expires on" date.
  - Settings Connections: YouTube key, and Chromium "installed or not installed" with the install command `npx playwright install chromium`, run in `packages/core`.
  - README, `docs/user-guide.md`, `docs/architecture.md`, `docs/glossary.md` and `apps/web/lib/glossary.ts` (terms: archived copy, social share).
  - `.env.example` (`YOUTUBE_API_KEY` with a comment), `docs/CONTEXT.md`.
  - `docs/OWNER-TODO.md`:
    - create a YouTube API key: Google Cloud console → new project → enable YouTube Data API v3 → Credentials → API key, restricted to YouTube Data API v3 → `.env YOUTUBE_API_KEY=…`;
    - optionally install Chromium: about 150–300 MB on the Y: drive;
    - run two $5 missions afterwards and compare fetch success and social share.
- Test: web component tests for the coverage card, entry detail and connections; the glossary, docs-links and tour guards.

**Interfaces:**
- Consumes `fetchStats`, `libraryCoverage().socialShare`, source `via`, `snapshotAt` and `expiresAt`, and `workerStatus.providers.youtube` plus a `browser` availability flag in the heartbeat (`providers.browser: boolean`).
- All text is rendered as text.

- [ ] **Step 1: Write the failing tests** for each new display and the guards.
- [ ] **Step 2: Run** `npm test -w apps/web -- library settings`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** all gates. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): fetch diagnostics, archived and YouTube sources, connections` and `docs: research reach`.

### Task 6: Merge and measure (controller)

- [ ] Run the gates and the secret scan (including `YOUTUBE_API_KEY`). Fast-forward `main`, run `npm install` and `npm run gen -- runs` (migrates and runs maintenance) in the owner's checkout, then push and remove the worktree.
- [ ] Report fetch diagnostics for the existing missions as a baseline (there will be no history yet). When the owner adds a YouTube key (and optionally Chromium), run two $5 missions and compare fetch success, social share and new entries.
