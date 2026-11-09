# Sources Expansion: Finds, Automatic Feeds and Getting Past Blocks

Status: owner approved on 2026-11-08 ("I like the plan"; "add this" for Reddit). Owner decisions are quoted. Everything else is a **Builder's call** (Claude). This comes before the "worth and difficulty" round and before any more benchmark runs ("plug in more social media outlets, and as many other sources as possible, before we try more runs").

## Why

The owner sees good ideas while scrolling Instagram Reels, TikTok and other feeds, and wants PitchLab to use them. The library's evidence today comes from:
- web search (vendor-heavy, 59% of signals);
- YouTube comments;
- Hacker News;
- app reviews;
- Product Hunt and YC;
- government data.

Many useful pages block automated fetches.

## Owner decisions (2026-11-07/08)

1. **Fully automated capture** of links the owner shares, from Instagram, TikTok and YouTube Shorts, plus anything else: "I'd rather have it fully automated, if we have to make accounts and create a separate project … I don't mind … I don't care about rules and terms of service." Throwaway accounts are used, never the owner's personal ones.
2. **Easy from the phone:** "build something to make it easy for us". That means a private Telegram bot, plus pasting links on the desktop.
3. **Reddit is included** ("add this"), without an account, through its public pages.
4. **Getting past blocks:** "there has to be a way to work around all the sites that block bots, I'm open to all the methods". **Builder's call on limits:** use a real headed browser with a persistent profile, then a commercial scraping service (the owner's key), then the archive. No fingerprint spoofing and no paid human CAPTCHA solving; the scraping services cover those sites. robots.txt becomes a setting the owner can turn off (`fetch.respectRobots`, default on).

## Goals

- **A shared link becomes a library entry in under 10 minutes**, while the worker runs. The entry has the caption, a speech transcript, on-screen text, view and like counts where available, and the owner's note.
- **Automatic feeds** add at least 100 new library entries a week from at least 8 different sources, within a daily cap of $2.
- **Fewer blocked pages:** page-fetch success rises against the 2026-10-28 baseline. Sites that blocked (403 or a challenge) now load through the browser or the scraping service at least half of the time when those are set up.
- **Ideation uses finds:** a "seen in the wild" block, and a "From my finds" run type.

## Non-goals

- The worth and difficulty round (the next spec).
- Moving PitchLab online.
- X (paid).
- Downloading anything the owner didn't share, from Instagram or TikTok: no account-wide scraping of those platforms.

## Anti-goals

- Using the owner's personal social accounts.
- Bulk-scraping Instagram or TikTok.
- Fingerprint spoofing or human CAPTCHA farms.
- Keeping capture secrets (tokens, cookies) in git, logs or prompts.

## Design

### A. Capture service (`services/capture/`, a separate package in the repo that can be split out later)

- **Tools:** standalone, free Windows binaries, downloaded by `npm run capture:setup` into `.tools/` (git-ignored), at pinned versions:
  - `yt-dlp.exe`;
  - `ffmpeg.exe` and `ffprobe.exe`;
  - `whisper.cpp` (`whisper-cli.exe`) with the `base` multilingual model (about 150 MB).

  On-screen text comes from `tesseract.js` (a pure JavaScript dependency of the capture package only).
- **`captureLink(url, opts)`:**
  1. Detect the platform (instagram, tiktok, youtube, x, threads, linkedin, facebook, other).
  2. `yt-dlp` writes metadata (title or caption, uploader handle, views, likes, comments count, duration, upload date) plus the best audio and a low-resolution video, into a temporary folder.
  3. Instagram and Facebook use `--cookies-from-browser` pointing at the capture browser profile (`.data/capture-profile`). The owner logs into the throwaway accounts there once, with `npm run capture:login`, which opens a headed Chromium on that profile.
  4. **Transcript:** ffmpeg converts the audio to 16 kHz WAV, then whisper-cli transcribes it (with language detection).
  5. **On-screen text:** ffmpeg samples one frame every 2 seconds, up to 20 frames. tesseract reads them, and lines are de-duplicated.
  6. **Fallback** when the download fails: open the page in the capture browser and read the caption, the og: tags and the visible text. Recording the audio from a playing tab is a follow-up, only if downloads fail often.
  7. Temporary media is deleted after capture. Only text and stats are kept.
- **Safety:**
  - every external process runs with an argument array (no shell) and a 3-minute timeout;
  - URLs must be http(s);
  - the size is capped (`--max-filesize 200M`);
  - downloads run one at a time, with at least 20 seconds between Instagram or TikTok captures.
- **Interface to core:** `@bcg/capture` exports `captureLink`. core imports it dynamically from the worker only, so the web bundle never sees it (check-bundle guard).

### B. Finds

- **Table `finds`** (migration `0014`):

  ```
  id, url, platform, note, source ('telegram' | 'paste'), status ('queued' | 'capturing' | 'done' | 'failed'),
  caption, transcript, screenText, stats jsonb, error, knowledgeItemId, createdAt, capturedAt
  ```

  Unique on the normalised url.
- **Ways in:**
  - **Telegram:** the worker long-polls the Bot API (`getUpdates`, outbound only) when `TELEGRAM_BOT_TOKEN` is set.
    - The first `/start` sender is saved as `telegram.ownerChatId`. Messages from anyone else are ignored.
    - URLs in a message become finds. The rest of the text becomes the note.
    - The bot replies "Got it" and, once captured, "Captured: <title> — added to your library".
  - **Desktop:** a Finds page (Library → Finds) with a paste box. Several links are allowed, one per line, each with an optional note after a space.
- **Worker:** a `finds` job takes queued finds (after runs, validation jobs and missions), captures them, then extracts. Errors are stored and shown, with a Retry button.
- **Extraction (`find-extract.v1`):** turns caption, transcript, on-screen text, note and stats into one library entry of a new kind, `find`.
  - Facts:

    ```
    { what, whoPays, howItEarns, whyItWorks, claims[] (unverified), platform, views?, likes?, creatorType? }
    ```
  - The library kind enum gains `find` (migration `0014`).
  - Quotes are verified against the transcript, caption or on-screen text.
  - The privacy scrub applies. Creator handles are not stored in the entry text.

### C. Finds in ideation

- **`ideationContext` gains `seenInTheWild`:** up to 6 finds by similarity, most recent first. Wrapped as untrusted.
- **Ideate v14** adds the block, with this rule: do not copy a find. Use it as proof that demand or a behaviour exists, then:
  - make it 10× better;
  - serve the people doing it (picks and shovels);
  - move it to a new market;
  - or solve the harder problem underneath it.

  Ideas cite find ids in `libraryItemIds`.
- **New seed type `finds`:** `{ seedType: 'finds', findIds?: string[] }`, defaulting to the 10 most recent finds. Started from the Finds page ("Start a run from these finds") or with `gen run --finds`.

### D. Automatic feeds

**Worker job `feeds`:** runs every 6 hours (setting `feeds.everyHours`). The daily spend cap is `feeds.dailyUsd`, default $2. Each source is free, rate-limited and cached, and every request goes through the guarded fetch helpers.

| Source | What | How |
|---|---|---|
| Reddit | posts and top comments for topic queries and a rotating list of subreddits (entrepreneur, smallbusiness, SaaS, sidehustle, the sectors' subreddits) | public `.json` endpoints, no account, at most 1 request per 2 s, PitchLab user agent |
| Bluesky | posts matching topic queries | public AppView `app.bsky.feed.searchPosts` (an app password is needed only if the endpoint requires auth; then the owner adds `BLUESKY_HANDLE` and `BLUESKY_APP_PASSWORD`) |
| Hacker News | recent Show HN and Ask HN | the existing Algolia client |
| arXiv | new papers for capability queries | arXiv API (Atom) |
| Hugging Face | trending models and spaces | `huggingface.co/api/models?sort=trendingScore` and `/api/spaces` |
| GitHub | trending repositories | the trending page |
| Newsletters | AlphaSignal, TLDR, Ben's Bites, Trends.vc, and others the owner adds | RSS/Atom (list in setting `feeds.rss`) |
| Launches and funding | BetaList, Indie Hackers, TechCrunch startups, Crunchbase News | RSS |
| YouTube Shorts | short videos for topic queries | the existing YouTube API (`videoDuration=short`) under the quota guard; comments as now |

- **Topics:** a rotating list built from the market's sectors, the active lenses and rising trends in the library, with 10 to 20 queries per run.
- **Items:** go through the existing library extraction as problem, startup, trend or pricing entries, with source types named after the source.
- **Coverage:** shown on the Library page. Each source's last run, items and errors appear in Settings → Connections.

### E. Getting past blocks (`collectPage` escalation)

1. **Direct fetch** (as now).
2. **Real browser:** on a 403, a challenge page (Cloudflare or similar markers), or thin text, the page is fetched in a **headed** Chromium on a persistent profile (`.data/fetch-profile`, cookies kept), at a human pace (3–8 s per page, one tab at a time). The PitchLab user agent is replaced by the browser's real one in this mode only. This uses the existing guarded proxy.
3. **Scraping service:** used when `SCRAPER_API_KEY` and `SCRAPER_PROVIDER` (`scrapingbee` | `zenrows` | `apify`) are set and the page is still blocked. The page goes through the provider with JS rendering. The monthly page budget is the setting `fetch.scraperMonthlyPages`, default 900, which fits the free tiers.
4. **Archive** (as now).

- **Diagnostics:** every attempt is logged in `page_fetches`, with `via` extended to `real_browser` and `scraper`.
- **`fetch.respectRobots`:** setting, default true. When false, robots.txt is not checked for research fetches. It is never relaxed for never-fetch or banned hosts.

## Constraints

All existing rulings bind, except where an owner decision above overrides them (terms of service for capture, Reddit and blocked sites; robots.txt as a setting):
- the SSRF guard and pinning on every fetch, including through the scraping service and capture;
- banned and never-fetch hosts;
- untrusted text wrapped;
- the privacy scrub;
- verified quotes;
- bounded queries;
- R13 and R20;
- web-safe imports and check-bundle;
- no live network or model calls in tests (mock yt-dlp, whisper, tesseract, Telegram, the providers and the feeds);
- merge gates;
- a secret scan, adding `TELEGRAM_BOT_TOKEN`, `SCRAPER_API_KEY` and `BLUESKY_APP_PASSWORD`.

## Owner actions

- **Telegram bot:** open @BotFather, send `/newbot`, and put the token in `.env` as `TELEGRAM_BOT_TOKEN`. Then send `/start` to the bot.
- **Throwaway accounts:** one throwaway Instagram account and one throwaway TikTok account. Run `npm run capture:login` and log in once in the window that opens.
- **Optional:** a ScrapingBee, ZenRows or Apify free account. Put the key in `.env` as `SCRAPER_API_KEY`, with `SCRAPER_PROVIDER`.
- **Optional:** a Bluesky account with an app password, if the public search needs auth.
- **Setup:** run `npm run capture:setup` once to download the tools (about 400 MB with the model).

## Done when

- Tests cover:
  - capture orchestration (mocked tools), including timeouts and the fallback;
  - Telegram (owner lock, URL parsing, replies);
  - Finds paste and storage;
  - find extraction and quote verification;
  - the `seenInTheWild` block and the finds seed;
  - each feed collector (mocked, including rate limits and malformed responses);
  - the feeds job's caps;
  - the fetch escalation order;
  - the robots setting;
  - check-bundle (capture is never in the web bundle).
- The owner has shared at least 5 links through Telegram and they appear as finds in the library.
- One week of feeds is reported: entries per source, cost, and errors.
