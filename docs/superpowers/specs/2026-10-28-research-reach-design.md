# Research Reach: YouTube, Fetch Diagnostics, Archive Fallback and a Local Browser

Status: the owner approved all five recommendations on 2026-10-28 ("looks good"). Sections marked **Builder's call** were settled by me (Claude). Builds on `docs/superpowers/specs/2026-10-26-research-library-design.md`.

## Why

The owner said the generated ideas are improving ("the 1099k one is pretty good"). Their concern now is that the research sources are narrow: "mostly blog posts and websites". They also noted that "a lot of the sources could not be reached". They want social media, and some kind of engine to help the agent browse.

Research (October 2026) settled what is allowed and free:
- **YouTube Data API v3:** free, commercial use allowed. Quota: 100 `search.list` calls per day, plus 10,000 units per day for everything else; `commentThreads.list` costs 1 unit. **Public API data may be stored for at most 30 calendar days, then it must be refreshed or deleted** (Developer Policies §III.E.4). Reaching past the quota by using several projects is forbidden.
- **X:** pay-per-use only, about $0.005 per post read. Skipped for now (free-only rule).
- **TikTok:** the Research API forbids commercial use, and there is no other keyword search. Skipped.
- **Instagram:** hashtag search only through your own business account, after Meta app review, limited to 30 hashtags per week. Skipped.
- **Unreachable pages:** most failures are HTTP 403 (deliberate bot blocking) or pages that need JavaScript. Getting around blocks is detection evasion and is ruled out.
- **Internet Archive:** the Wayback availability and CDX APIs are free with no key; about 1 request per second is the informal norm, and HTTP 429 is possible.
- **Browserbase:** the free plan is 1 browser-hour per month, so it is not viable.
- **API Anything:** an interesting agent tool (it learns a site's frontend API and replays it over HTTP), but it is not on npm and replays private site endpoints. Used as inspiration only.

## Owner decisions (2026-10-28)

1. Add **YouTube** (video metadata plus comments) as a research source through the official API, using a free API key the owner creates.
2. **X:** skip.
3. **TikTok and Instagram:** skip.
4. **Browsing engine:** an Internet Archive fallback for blocked or missing pages, plus a **local headless browser** for JavaScript-heavy pages. No bot evasion.
5. **Measure first:** log every page fetch's outcome, so each fix can be judged.

## Goals

- **R1, diagnostics:** every collector page fetch (missions, and verify where cheap) records its outcome. The Library page shows the success rate and the top failing domains and reasons.
- **R2, YouTube:** missions can search YouTube and read video titles and descriptions plus top comments. Comments become evidence (mostly operator voice), with quotes verified against the comment text.
- **R3, 30-day rule:** YouTube-sourced data is refreshed or deleted within 30 days, automatically.
- **R4, archive fallback:** when a direct fetch fails with 403, 404, 410, 5xx or a timeout, and robots.txt allows the URL, the collector tries the Internet Archive's closest snapshot. It records that the text came from an archived copy, and its date.
- **R5, local browser:** when a direct fetch succeeds but the page has too little readable text (JavaScript-rendered), the collector renders it in a local headless Chromium. That uses the same robots.txt and banned-host rules, the PitchLab user agent, and no stealth or CAPTCHA solving. It is optional: the app works without the browser installed.
- **Measured success:** compared on the same mission topics before and after, page-fetch success rises and the share of sources from social or community platforms rises. A bench-v2 pass keeps real-need evidence at or above 50%.

## Non-goals

- X, TikTok and Instagram.
- Paid services: Browserbase, scraping APIs, proxies.
- Logging into any site. Solving CAPTCHAs. Rotating identities.
- Video transcripts. Downloading captions for others' videos needs the owner's permission under the API.

## Anti-goals

- Getting around a site's block (403 or a bot wall) by disguising the browser. That means no stealth plugins, no fake user agents, and no residential proxies.
- Using an archived copy of a page whose robots.txt disallows us. The site said no; we don't go around it.
- Keeping YouTube data longer than 30 days without refreshing it.
- The local browser reaching private or loopback addresses (SSRF) or the owner's never-fetch hosts.
- Storing commenter names, channel ids or profile links.

## Design

### 1. Fetch diagnostics

- **Table:** a `page_fetches` table with `id`, `url_domain`, `outcome`, `via`, `status`, `mission_id?`, `run_id?`, `at`.
  - `outcome` is one of: `ok`, `http_403`, `http_404`, `http_4xx`, `http_5xx`, `timeout`, `blocked_robots`, `blocked_host`, `too_large`, `not_html`, `thin_text`, `network`.
  - `via` is one of: `direct`, `archive`, `browser`.
  - It stores domains, not full URLs, to keep it small.
  - **Builder's call:** keep 90 days; prune on worker start.
- **Writing:** a single `recordFetch` helper is called wherever missions fetch pages. Verify's page fetches are included if cheap.
- **Library coverage panel:** fetch success rate over the last 30 days, overall and by `via`; top 10 failing domains with their main reason; counts by outcome.

### 2. YouTube source (`research/sources/youtube.ts`)

- **Key:** `YOUTUBE_API_KEY` (optional; skipped cleanly without it). Shown in Settings → Connections.
- **Calls:** `search.list` (type `video`, relevance, English, the mission's countries as `regionCode` where possible) → `videos.list` (title, description, channel title is not stored, published date) → `commentThreads.list` (top-level comments, order `relevance`, up to 100 per video, 1 page). It is plain HTTPS to `www.googleapis.com` through the existing fixed-host request helper.
- **Quota guard:** a daily counter in settings (`youtube.quota`: date (Pacific day), searchCalls, units). A mission stops using YouTube when the day's caps are near: **Builder's call:** stop at 90 searches or 9,000 units. Each mission uses at most 5 searches.
- **Becoming entries:**
  - Each comment becomes a raw item (`sourceType: 'youtube'`, url = the video URL with `&lc=<commentId>`, text = the comment).
  - The video title and description are a separate item.
  - Normal extraction, verification (quote verbatim in the comment text, at least 6 words or 30 characters) and privacy scrubbing apply.
  - Author fields are never read.
- **30-day rule:**
  - `knowledge_sources` gains `expires_at` (nullable). YouTube sources get `fetched_at + 30 days`.
  - A daily maintenance step in the worker deletes expired YouTube sources. If a source is re-collected by a later mission, its `fetched_at` and `expires_at` are refreshed.
  - An entry left with no sources is deleted. Signals already copied into runs from expired YouTube sources are redacted (quote replaced with "[expired YouTube data]") rather than deleted, so run history stays intact.
  - **Builder's call:** deletion over refresh. Refreshing would spend quota re-fetching every comment.

### 3. Archive fallback (`research/archive.ts`)

- **When:** after a direct fetch fails with `http_403`, `http_404`, `http_410`, `http_5xx` or `timeout`. Only if robots.txt allowed the original URL and the host isn't banned or never-fetch.
- **How:** query `https://archive.org/wayback/available?url=<url>`. If a snapshot exists and is at most **3 years** old (**Builder's call**), fetch its raw form (`/web/<timestamp>id_/<url>`) through `fetchPage` with the PitchLab user agent. The archive host is fixed and still passes the SSRF guard.
- **Rate limit:** 1 request per second to archive.org. On 429, stop using the archive for the rest of the mission and record a warning.
- **Source record:** `via: 'archive'`, the snapshot date, and the original URL. The library shows "from an archived copy (date)". Quotes are verified against the archived text.

### 4. Local headless browser (`research/browser.ts`)

- **Dependency:** Playwright with Chromium, as an **optional** dependency (`playwright-core`, plus `npx playwright install chromium` run by the owner). It is detected at runtime, and the feature is unavailable when missing. Settings shows the status and how to install it.
- **When:** a direct fetch returned HTML but readable text is under **800 characters** (**Builder's call**; `thin_text`), and robots.txt allows the URL.
- **How:**
  - A new browser context per mission, with JavaScript on, images, media and fonts blocked, a 20-second navigation timeout, and up to 3 pages at once.
  - User agent `pitchlab-research/0.1` (the same identity robots.txt is checked against).
  - Extract readable text with the existing readability step.
- **Safety:**
  - Every request the browser makes (`page.route`) is checked first: the host is resolved with the guarded lookup and must be public, not banned and not never-fetch, otherwise it is aborted. Only GET requests are allowed.
  - Downloads and pop-ups are refused.
  - The browser profile is temporary and deleted after the mission.
  - **Builder's call:** the approach to DNS-rebinding risk must be stated in the plan. Preferred: route the browser through a local forwarding proxy that uses the guarded lookup and pins the checked address. Otherwise, the per-request check plus blocking non-document, non-script request types from other registrable domains, with the residual risk documented.
- **Cost:** no model cost. Time cost is bounded by the timeouts and the concurrency cap.

### 5. Mission integration

- **Order per web URL:** direct fetch → (thin text → browser) or (failure → archive) → give up with a warning. Each attempt is recorded in `page_fetches`.
- **Planner:** `youtube` joins the free sources (run first, not budget-gated beyond the quota guard) when the key is set. The plan prompt gets a new version that explains YouTube queries ("people describing the problem in comments: reviews, how-to, complaint videos").
- **Docs:** README (sources and keys), user guide, architecture (sources, fallbacks, 30-day rule), OWNER-TODO (create a YouTube API key; optionally install Chromium).

## Constraints

All existing rulings bind:
- SSRF guard;
- robots.txt;
- banned and never-fetch hosts;
- untrusted text wrapped;
- privacy scrub;
- verified-quote rules;
- soft budgets;
- bounded queries;
- R13 and R20;
- no live network or model calls in tests (mock the YouTube API, the archive and the browser);
- merge gates, including core tsc;
- a secret scan, also checking `YOUTUBE_API_KEY`.

Migration `0011` only adds things: `page_fetches`, plus `knowledge_sources.expires_at` and `via` / `snapshot_at`.

## Decisions settled after the design review (Builder's calls)

- **Expiry scope (cautious).** When a YouTube source expires, every verbatim copy is removed:
  - **Library:** the source row is deleted. An entry whose only sources were YouTube is deleted, summary included.
  - **Run signals with `source = 'youtube'` past expiry:**
    - the quote and title become `[expired YouTube data]`;
    - the embedding is set to null;
    - `quoteHash` becomes a hash of the placeholder plus the signal id, which keeps `(url, quote_hash)` unique.
  - **Case claims whose `sourceUrl` is a YouTube URL:** `quote` is set to null with the review note "YouTube quote removed after 30 days".

  The model's own paraphrases (claim text, case prose, entry summaries that also had other sources) are kept, because they are derived writing, not stored API data.
- **No comment ids.** YouTube source URLs are the plain video URL (`https://www.youtube.com/watch?v=<id>`), with no comment id. Distinct comments stay distinct through their quote hash. YouTube rows are found through `signals.source = 'youtube'` and `knowledge_sources.source_type = 'youtube'`.
- **Fetch wrapper.** Fallbacks run in a new wrapper, `collectPage(url, opts)` in `research/`, which logs diagnostics and runs direct → browser or archive. `fetchPage` stays as it is (additive result fields are allowed if needed). `pipeline/verify.ts` gets diagnostics only, with no fallbacks.
- **Robots and the archive.**
  - The archive is tried only when `robotsAllows(originalUrl)` returned allow. A robots fetch failure already returns deny, failing closed, so there is no archive then.
  - `web.archive.org` itself is also robots-checked; it's cached.
  - Redirects that leave `web.archive.org` are refused.
- **Browser DNS rebinding.** A local forwarding proxy on `127.0.0.1` with a random port, alive for the mission only:
  - It resolves each `CONNECT` host or HTTP host with the guarded lookup and pins the checked address.
  - It refuses private, loopback and link-local addresses, plus banned and never-fetch hosts.
  - The browser is launched with this proxy and `--proxy-bypass-list=<-loopback>` cleared, so nothing bypasses it.
  - `page.route` additionally allows only GET and drops images, media and fonts.
  - The proxy has its own unit tests.
- **YouTube quota counter.** It is updated atomically (a single SQL `UPDATE … SET … = … + n` on a jsonb setting, or a small `youtube_quota` table keyed by Pacific date; builder picks). Calls from a cancelled mission still count.
- **Maintenance cadence.** It runs on every `gen` command start (`openDb`), at worker start, and every 24 hours in the worker loop (last-run timestamp in settings). The steps are: YouTube expiry, `page_fetches` pruning, and the redaction above. A process that opens the database therefore always clears expired data first. The README says so.
- **Social or community share** (for the measured-success goal and the coverage panel): the share of active entries' sources whose `source_type` is one of `youtube`, `hn`, `stackexchange`, `github`, `appstore` or `producthunt`.
- **Playwright packaging.** `playwright-core` is an optional dependency loaded with a dynamic `import()` behind a small typed interface, so core `tsc` passes without it. "Available" means the import succeeds and `chromium.executablePath()` exists on disk. Tests mock the interface.

## Left to the builder

- Exact thresholds beyond those marked, retry details, the coverage panel layout, the Playwright install guidance text, and how comment pages are sampled across videos.

## Done when

- Unit tests cover:
  - YouTube mapping, the quota guard and 30-day expiry deletion (with signal redaction);
  - the archive fallback conditions and the 429 stop;
  - the browser's request guard, which refuses private, banned and non-GET requests (with Playwright mocked or skipped when it isn't installed);
  - fetch logging and the coverage stats.
- With a YouTube key and Chromium installed, the owner runs two $5 missions on earlier topics. Fetch success and source variety are compared with the earlier missions, and a bench-v2 pass keeps real-need evidence at or above 50%.
