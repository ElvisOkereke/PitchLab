# Sources Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. TDD per task (failing test first, capture RED). No live network, process or model calls in tests: mock spawn, fetch, the router, Telegram, the providers and Playwright. Steps use checkbox (`- [ ]`) syntax.

**Goal:**
- Links the owner shares (Telegram or paste) become captured library "finds", with transcript, on-screen text and stats.
- Ideation uses finds.
- Automatic feeds from Reddit, Bluesky, HN, arXiv, Hugging Face, GitHub, newsletters and launch/funding RSS, plus YouTube Shorts.
- Blocked pages escalate: real browser, then a scraping service, then the archive.

**Architecture:**
- **New workspace package `packages/capture`** (Node). It orchestrates `yt-dlp`, `ffmpeg`, `whisper-cli` and `tesseract.js`. core loads it dynamically, from the worker only.
- **Migration `0014`:**
  - a `finds` table;
  - `knowledge_kind` gains `find`;
  - `fetch_via` gains `real_browser` and `scraper`.
- **Telegram poller** and a **`finds` worker job**, with the `find-extract.v1` prompt.
- **Web:** a Finds page.
- **Ideation:** a `seenInTheWild` context block, `ideate.v14` and a `finds` seed type.
- **Feeds:** collectors and a `feeds` worker job.
- **`collectPage` escalation**, plus a robots setting.

**Tech Stack:** existing, plus:
- `tesseract.js` (pinned, in `packages/capture` only);
- the external binaries `yt-dlp`, `ffmpeg` and `whisper.cpp`, downloaded by a setup script into `.tools/`, which is git-ignored.

**Spec:** `docs/superpowers/specs/2026-11-08-sources-expansion-design.md`. Binding.

**Branch:** `sources` in the sibling worktree `Y:/CODING PROJECTS/Business_Case_Gen-sources`, with its own `npm install` and no `.env`.

## Global Constraints

- **Capture:**
  - External tools are spawned with argument arrays (never a shell).
  - Timeout 3 minutes per tool.
  - `--max-filesize 200M`.
  - http(s) URLs only.
  - One capture at a time, and at least 20 seconds between Instagram or TikTok captures.
  - Temporary media is deleted after capture.
  - Cookies come only from `.data/capture-profile`.
  - Tokens, cookies and keys never appear in logs, errors, prompts or stored rows.
- **Telegram:**
  - Long-poll `getUpdates`.
  - The owner is locked to the first `/start` chat id (setting `telegram.ownerChatId`). Every other chat is ignored silently.
  - Bot replies are plain text.
- **Finds:**
  - Unique on the normalised URL.
  - Statuses: `queued`, `capturing`, `done`, `failed`.
  - Extraction verifies quotes against the caption, transcript or screen text.
  - Creator handles are not stored in the entry text.
- **Ideation:**
  - `seenInTheWild` holds at most 6 finds, wrapped as untrusted.
  - ideate.v14 rule: don't copy a find. Use it as proof of demand, then make it 10× better, serve the people doing it, move it to a new market, or solve the harder problem underneath.
  - Seed `{ seedType: 'finds', findIds? }`, defaulting to the 10 most recent finds.
- **Feeds:**
  - Every `feeds.everyHours` (default 6).
  - Daily cap `feeds.dailyUsd` (default 2).
  - Reddit: at most 1 request per 2 s.
  - Every source is cached and bounded, and every request goes through the guarded helpers.
  - The RSS list is in setting `feeds.rss`, with defaults: AlphaSignal Substack, TLDR, Ben's Bites, Trends.vc, TechCrunch startups, Crunchbase News, BetaList and Indie Hackers. The implementer confirms each feed URL format, and mocks them in tests.
- **Escalation:**
  - Order: direct, then real browser (headed, persistent `.data/fetch-profile`, 3–8 s pacing, one tab), then scraping service (`SCRAPER_PROVIDER` = scrapingbee | zenrows | apify, `SCRAPER_API_KEY`, monthly cap `fetch.scraperMonthlyPages` = 900), then archive.
  - Never-fetch and banned hosts are never relaxed.
  - `fetch.respectRobots` defaults to true.
  - No fingerprint spoofing and no CAPTCHA solving.
- **Existing rulings bind:**
  - SSRF guard and pinning;
  - untrusted text wrapped;
  - privacy scrub;
  - verified quotes;
  - bounded queries and bound parameters;
  - R13 and R20;
  - web-safe imports;
  - check-bundle (`@bcg/capture`, `tesseract.js` and `playwright` never reach the web bundle);
  - old prompts kept;
  - migration additive.
- **Merge gates:**
  - `npm test -w packages/core`, `npm test -w packages/capture`, `npm test -w apps/web`, `npm run typecheck -w apps/web`, `npx tsc --noEmit -p packages/core`, `npx tsc --noEmit -p packages/capture`, the web build with dummy env, and `npm run check-bundle -w apps/web`.
  - Chain them with `set -o pipefail`, and run them one after another.
  - Secret scan, adding `TELEGRAM_BOT_TOKEN`, `SCRAPER_API_KEY` and `BLUESKY_APP_PASSWORD`.
- **Environment:**
  - Never run `gen` or db commands without an explicit `DATABASE_URL=pglite://<temp under .data/>`.
  - Never touch the owner's checkout or Supabase.
  - Never download tools or launch browsers in tests.
  - Commits end with the committing agent's `Co-Authored-By` trailer.

## Review Focus

1. **A shared URL that is not a video** (an article, a profile page, a private post), **or a yt-dlp failure.** Expected: the fallback reads the caption or page text where possible. Otherwise the find is `failed`, with a readable error and a Retry button. The worker carries on. Pinned in Tasks 1–2.
2. **Someone other than the owner messages the bot, or the same link is sent twice.** Expected: strangers are ignored, with nothing stored. A duplicate link returns "already captured" and creates no second find. Pinned in Task 2.
3. **A tool hangs or prints secrets or cookie paths in stderr.** Expected: the 3-minute timeout kills the process, and errors are sanitised (no paths under `.data`, no tokens). Pinned in Task 1.
4. **A feed returns HTML instead of JSON or XML, rate-limits (429), or returns 10,000 items.** Expected: that source stops for this run with a warning, and items are capped per source. Pinned in Task 5.
5. **Escalation on a site with no scraper key, or the monthly scraper budget is used up.** Expected: the step is skipped, logged in `page_fetches`, and the archive is still tried. Pinned in Task 6.

---

### Task 1: Capture package

**Files:**
- Create in `packages/capture/`: `package.json` (name `@bcg/capture`), `tsconfig.json`, `src/index.ts`, `src/platform.ts`, `src/tools.ts`, `src/capture.ts`, `src/ocr.ts`, `scripts/setup.ts`, `scripts/login.ts`, `test/*.test.ts`.
- Modify: root `package.json` (workspace; scripts `capture:setup` and `capture:login`) and `.gitignore` (`.tools/`).

**Interfaces:**
- `detectPlatform(url): 'instagram' | 'tiktok' | 'youtube' | 'x' | 'threads' | 'linkedin' | 'facebook' | 'other'`.
- `captureLink(url, opts: { toolsDir; profileDir; tmpDir; spawn?; ocr?; now?; log? }): Promise<CaptureResult>`.
  - `CaptureResult = { ok: true; platform; title; caption; transcript; screenText; stats: { views?; likes?; comments?; durationSec?; uploadedAt? }; language? } | { ok: false; platform; error: string; fallback?: { caption?; pageText? } }`.
  - Runs yt-dlp `--dump-json`, then audio and low-resolution video, then ffmpeg to WAV, then whisper-cli, then ffmpeg frames, then OCR, then cleans up.
  - Cookies (`--cookies-from-browser chromium:<profileDir>`) only for Instagram and Facebook.
  - Errors are sanitised.
- `scripts/setup.ts`:
  - downloads pinned versions of yt-dlp, ffmpeg and whisper.cpp, and the base model, into `.tools/`;
  - verifies checksums from a constants table;
  - is idempotent and prints sizes.
- `scripts/login.ts`: opens a headed Chromium on `.data/capture-profile`, using the existing optional playwright-core.

- [ ] **Step 1:** Write failing tests, all with mocked spawn and OCR:
  - the argument arrays exactly;
  - cookies only for Instagram and Facebook;
  - a timeout kills the process;
  - a yt-dlp failure becomes `ok: false` with the fallback hook;
  - stderr with tokens or paths is sanitised;
  - temporary files are removed;
  - frames are capped at 20 and OCR lines de-duplicated;
  - `detectPlatform` cases;
  - setup checksum verification, with fetch mocked.
- [ ] **Step 2:** Run `npm test -w packages/capture`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test -w packages/capture`, `npx tsc --noEmit -p packages/capture` and the core suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(capture): capture service for shared video links`.

### Task 2: Finds, Telegram and the finds worker job

**Files:**
- Modify: `packages/core/src/db/schema.ts` (migration `0014`: the `finds` table, the `find` knowledge kind, the `fetch_via` values) and `library/kinds.ts` (find facts schema and label "Seen in the wild").
- Create:
  - `packages/core/src/finds/store.ts` (`addFinds`, `listFinds`, `retryFind`, `deleteFind`);
  - `finds/telegram.ts` (the poller);
  - `finds/worker.ts` (capture, extract, store);
  - `prompts/find-extract.v1.md`.
- Modify: `worker.ts` (Telegram poll each tick when the token is set; the finds job after missions), `config/env.ts` (optional `TELEGRAM_BOT_TOKEN`) and the heartbeat (`providers.telegram`, `providers.capture` tools present).

**Interfaces:**
- `addFinds(db, items: { url; note?; source }[]): Promise<{ added: number; duplicates: number }>`, with the URL normalised (tracking params stripped).
- `pollTelegram(deps): Promise<{ received; added; ignored }>`.
  - It uses the update offset in setting `telegram.offset`.
  - It locks the owner on the first `/start`.
  - It replies through `sendMessage`, using a fixed-host `request()` to api.telegram.org. The token appears only in the URL path and is never logged.
- `runFindsJob(deps): Promise<{ captured; failed }>`.
  - Statuses go `queued`, then `capturing`, then `done` or `failed`. A stale `capturing` older than 15 minutes goes back to `queued`.
  - Extraction produces one `find` library entry, with quotes verified against caption, transcript or screen text.
  - It links `knowledgeItemId` and replies on Telegram when the find came from there.

- [ ] **Step 1:** Write failing tests:
  - store dedupe and normalisation;
  - the Telegram owner lock;
  - a stranger is ignored;
  - URLs are parsed from text;
  - the offset advances;
  - the token never appears in logs;
  - the job's status flow with a mocked capture;
  - stale recovery;
  - extraction storage and quote verification;
  - a failed capture keeps an error;
  - migration `0014` is additive.
- [ ] **Step 2:** Run `npm test -w packages/core -- finds telegram worker db`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the core suite and core tsc. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): finds from Telegram and paste, captured by the worker`.

### Task 3: Finds page (web)

**Files:**
- Create: `apps/web/app/(app)/library/finds/page.tsx` (or a tab on Library, following the existing structure), `components/finds-view.tsx` and `actions/finds.ts`.
- Modify: navigation and the glossary ("Finds", "Seen in the wild").

**Interfaces:**
- A paste box: one link per line, each with an optional note after the first space. It saves through `addFinds`.
- The list shows status, platform, title, note, error and stats, with Retry, Delete and a link to the library entry.
- A "Start a run from these finds" button queues a `finds` seed (Task 4 provides the seed type; until then the button is hidden behind a feature check).
- All text renders as text, and the actions follow the existing pattern.

- [ ] **Step 1:** Write failing tests: render, paste-action validation (links only, a cap of 50 lines), retry and delete, auth on every action, the R13 guard, the glossary sync.
- [ ] **Step 2:** Run `npm test -w apps/web -- finds`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the web suite, the web typecheck, the build and check-bundle. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): Finds page`.

### Task 4: Finds in ideation

**Files:**
- Create: `prompts/ideate.v14.md`.
- Modify:
  - `library/context.ts` (`seenInTheWild`);
  - `pipeline/ideate.ts`;
  - `pipeline/types.ts`, `dashboard/runs.ts` and the CLI (the `finds` seed);
  - `harvest.ts` (a finds seed researches the finds' topics: one pain call and one opportunity call per find, at most 6);
  - the web queue-run form (a "From my finds" option);
  - the Finds page button.

**Interfaces:**
- `IdeationContext.seenInTheWild: { id; what; whoPays; howItEarns; url }[]`, at most 6, live entries only, ordered by similarity then recency.
- `RunConfig` gains `seedType: 'finds'` and `findIds?: string[]`. With no ids, the 10 most recent captured finds are used.
- ideate.v14 = v13 plus the block and its rule. v13 is kept.

- [ ] **Step 1:** Write failing tests:
  - context classification and caps;
  - the prompt contains the block, the don't-copy rule and the citation of find ids;
  - the seed validation and default;
  - harvest for a finds seed;
  - the web form option.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the core and web suites and both typechecks. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): finds feed ideation; From my finds runs`.

### Task 5: Automatic feeds

**Files:**
- Create: `packages/core/src/research/feeds/` with `reddit.ts`, `bluesky.ts`, `hnshow.ts`, `arxiv.ts`, `huggingface.ts`, `githubtrending.ts`, `rss.ts`, `ytshorts.ts`, `topics.ts` and `job.ts`, plus their tests.
- Modify: `worker.ts` (the feeds job on its schedule), Settings → Connections (per-source last run, items and errors), and `env.ts` (optional `BLUESKY_HANDLE` and `BLUESKY_APP_PASSWORD`).

**Interfaces:**
- Each collector is `(query, opts) => Promise<RawItem[]>` with source-specific caps: at most 25 items per query and at most 200 per source per run.
- `runFeedsJob(deps): Promise<{ bySource: Record<string, { items; added; errors: string[] }>; spentUsd }>`.
  - It plans topics with `planFeedTopics(db)`, which draws on the market's sectors, active lenses and rising library trends, 10–20 queries per run.
  - It collects, then runs the existing library extraction (problem, startup, trend or pricing), and stops when it reaches the daily cap.
  - A 429 or malformed response stops that source for the run, with a warning.
- The schedule is stored in setting `feeds.lastRun`, so a restart doesn't re-run early.

- [ ] **Step 1:** Write failing tests:
  - each collector's request URL and shape;
  - a 429, HTML instead of JSON, and malformed responses;
  - the caps;
  - Reddit pacing;
  - RSS parsing (RSS 2.0 and Atom);
  - topic planning;
  - the job's daily cap and schedule;
  - the Connections rendering.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the core and web suites and both typechecks. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): automatic feeds from Reddit, Bluesky, HN, arXiv, Hugging Face, GitHub, newsletters and Shorts`.

### Task 6: Getting past blocks

**Files:**
- Modify:
  - `packages/core/src/research/collect.ts`;
  - `research/browser/render.ts` (a headed persistent-profile mode);
  - a new `research/scraper.ts` (provider adapters);
  - `research/fetch-log.ts` (the new `via` values);
  - the robots check call sites (setting `fetch.respectRobots`);
  - `env.ts` (`SCRAPER_PROVIDER`, `SCRAPER_API_KEY`).

**Interfaces:**
- `collectPage` order: direct, then real browser (on a 403, a challenge page or thin text), then scraper (if a key is set, the page is still blocked and the monthly budget remains), then archive.
- Challenge detection is a pure function `looksLikeChallenge(html)`, with markers for Cloudflare, "verify you are human" and the like.
- `scrapeViaProvider(url, { provider, key, fetch? }): Promise<PageResult>` calls the provider's documented endpoint with JS rendering. The key appears only in the provider request. The page count goes into the setting `fetch.scraperPages.<YYYY-MM>`.
- Real-browser mode:
  - headed, on `.data/fetch-profile`, with no PitchLab user agent override;
  - waits 3–8 s;
  - still runs through the guarded proxy;
  - is closed after the mission.

- [ ] **Step 1:** Write failing tests:
  - the escalation order;
  - challenge detection;
  - provider request building for each provider, with the key never logged;
  - the monthly budget stop;
  - no key means the step is skipped and logged;
  - the robots setting on and off;
  - never-fetch and banned hosts are never relaxed;
  - `page_fetches` records `real_browser` and `scraper`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the core suite and core tsc. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): fetch escalation through a real browser and a scraping service`.

### Task 7: Docs, settings and owner steps

**Files:**
- Modify: README, `docs/user-guide.md` (Finds, the Telegram bot, feeds, unblocking), `docs/architecture.md`, `docs/glossary.md` and `apps/web/lib/glossary.ts`, `docs/CONTEXT.md`, `docs/OWNER-TODO.md` (the owner actions from the spec), `.env.example`, and the secret-scan key list wherever it is documented.
- Test: the docs-links and glossary guards.

- [ ] **Step 1:** Update the docs.
- [ ] **Step 2:** Run all gates. Expected: PASS.
- [ ] **Step 3:** Commit `docs: sources expansion`.

### Task 8: Merge and switch on (controller)

- [ ] Run the gates and the secret scan. Fast-forward main, run `npm install` and `npm run gen -- runs` (migrates `0014`), push, and remove the worktree.
- [ ] Run `npm run capture:setup` in the owner's checkout (downloads the tools). Report the sizes.
- [ ] After the owner adds the Telegram token and logs in the capture accounts, run `gen worker --once` to capture the first shared links. Run one feeds cycle, then report items per source, cost and errors in the quality log.
