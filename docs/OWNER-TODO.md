# Things only you can do

A running list of what is waiting on you. Done items are removed as work lands; tell Claude when you finish something.

## Keep it running

- [ ] Restart `npm run worker` (and `npm run web`) whenever Claude merges new work, so both run the latest code. Settings → Connections should then show YouTube, Product Hunt and the local browser as connected.
- [ ] Turn on **Background research** in Settings when you want the library to keep growing on its own.
- [ ] The automatic feeds (Reddit, Bluesky, Hacker News, arXiv, Hugging Face, GitHub, newsletters, YouTube Shorts) run every 6 hours while the worker is up and spend at most $2 a day (settings `feeds.everyHours`, `feeds.dailyUsd`). Settings → Connections → Feeds shows each source's last run. Nothing to do unless Bluesky says "search needs sign-in" (see the Bluesky item below).
- [ ] Check Settings → Connections → Feeds after the first run: a newsletter feed address that no longer works shows as an error there. Tell Claude which feeds to add or replace (the list lives in setting `feeds.rss`, with no editing screen yet). The default addresses were chosen from each publisher's usual feed path and could not be tested from here.
- [ ] YouTube-only library entries are deleted 30 days after collection (the 2026-10-28 batch goes around 27 Nov). New missions or background research on the same topics bring fresh ones back.

## Set up the new sources (after the sources work is merged)

- [ ] **Telegram bot (2 minutes, free).** In Telegram, open @BotFather, send `/newbot`, pick a name, then copy the token it gives you into `.env` as `TELEGRAM_BOT_TOKEN=…`. After the sources work is merged, restart the worker, open Settings → Connections (or the worker log) for your pairing code, and send `/start <code>` to your bot. Only the chat that sends the code becomes the owner; `gen telegram reset` gives a new code if you ever need to pair again. Then share any Reel, TikTok, Short or post to the bot.
- Capture tools: Claude runs `npm run capture:setup` at merge (it downloads yt-dlp, ffmpeg and the speech model, about 400 MB, into `.tools/`). Nothing for you to do; restart the worker afterwards so Settings → Connections shows the capture tools as installed. Until then finds wait in the queue.
- [ ] **Throwaway accounts for capture.** Make one Instagram account and one TikTok account you don't mind losing (never your personal ones). Run `npm run capture:login` and log in to both in the window that opens, then close it. Until you do, Instagram and TikTok links are tried without a login (public ones sometimes work) and a failure says to log in; press **Retry** on Library → Finds afterwards. YouTube works without it.
- [ ] **Optional: a scraping service key** for sites that block bots (G2, Capterra, Trustpilot and the like), used only after the real browser fails. Make a free account at ScrapingBee, ZenRows or Apify, then add `SCRAPER_PROVIDER=scrapingbee` (or `zenrows` / `apify`) and `SCRAPER_API_KEY=…` to `.env` and restart the worker. PitchLab stops at 900 pages a month (setting `fetch.scraperMonthlyPages`), inside the free tiers.
- [ ] **Optional: Bluesky.** Only if Settings → Connections later says Bluesky search needs a login: create an app password in Bluesky (Settings → App passwords) and add `BLUESKY_HANDLE=…` and `BLUESKY_APP_PASSWORD=…` to `.env`.

## Judge the ideas (your part of the quality loop)

- [ ] After bench-v3 #3 runs (the first pass on the new idea engine), sort its new cases on the **Board**: it is the comparison with bench-v3 #2 and the verdict on the engine. Nothing else is required to start; the engine is on by default.
- [ ] After each benchmark pass, sort its new cases on the **Board**: keep (move to Validating or Pilot) or kill. Your Board decisions are what PitchLab measures itself against.
- Claude runs the scale backtest (`gen audit scale --decided`, then `gen audit backtest`) against your Board decisions after each change to the scale rule; nothing for you to do except keep sorting the Board.
- [ ] Optional: rate ideas on **Runs** (thumbs up or down, plus tags). It covers ideas that never became cases.
- [ ] Optional: add 2 or 3 example ideas you would want in **Settings** (or `npm run gen -- audit holdout add "..."`). The generator never sees them; they only measure how close it gets.
- [ ] Tech forums are off (`harvest.techForums`). Ask Claude if you ever want WordPress and GitHub evidence back.

## Use the app

- [ ] Do not generate a validation pack for a consumer case yet. Its outreach drafts are cold emails, and CASL does not allow cold emails to individuals without consent. Consumer outreach rules come later.
- [ ] Walk through the tour ("Take the tour") once on your computer and once on your phone, in light and dark mode. Report anything confusing.
- [ ] Generate a validation pack on a real case (one you kept) from its Validate tab.

## Outreach (from the freight validation run)

- [ ] Set your sender identity in Settings (name, mailing address, phone or website). Every outreach email must include it.
- [ ] Rewrite the freight drafts with your identity in them: open the case's Validate tab and press **Run validation again** with "Rewrite drafts for prospects not yet contacted" ticked. Or run `npm run gen -- validate shipper-detention-proof-packets-for-freight-brokers --skip-prospects --redraft`.
- [ ] Contact the freight brokers yourself (the app never sends email), then log what happened on the Validate tab.
- [ ] Ask your friend for permission before anything about their pilot site is fetched or contacted.

## If PitchLab ever earns money or goes public

- [ ] Email hello@producthunt.com for commercial API permission (the developer token is for non-commercial use).
- [ ] Choose and add a LICENSE. The README currently says "all rights reserved".
- [ ] Remove or move private details. `docs/CONTEXT.md` and `docs/runs/*` name the pilot site and real prospects, and these are in the git history too.
- [ ] Decide on LLM configuration for other users. One key is used for both API formats, and the default base URLs point at your employer's gateway.
- [ ] The capture service downloads TikTok, Instagram and YouTube videos against those platforms' terms, and the research now reads sites whose terms forbid automated use (your call for a private prototype, 2026-11-08). Both would have to be removed or replaced before any public or commercial release.
