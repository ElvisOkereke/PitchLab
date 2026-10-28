# Things only you can do

A running list of what is waiting on you. It is kept up to date as work lands; tick items off or tell Claude when they're done.

## Set up the research library (Phase 2)

- [x] **Product Hunt developer token (free).** Done 2026-10-27. Used for new products, what they charge, and how they did.
  1. Sign in and open https://www.producthunt.com/v2/oauth/applications
  2. Create an application. The redirect URL can be `https://localhost:3000/callback`.
  3. Use the **Developer Token** (not the API key or secret) and add it to `.env` as `PRODUCTHUNT_TOKEN=…`.
- [ ] After merging, restart `npm run worker`. It applies the database update, which missions and the heartbeat need. Until the worker is restarted on the new code, Settings → Connections may show YouTube as "not set" and Chromium as "not installed".
- [ ] After adding the token, restart `npm run worker`. Settings → Connections shows Product Hunt as connected.
- [ ] If PitchLab starts earning money, email hello@producthunt.com for commercial API permission (the developer token is for non-commercial use).
- [ ] Turn on **Background research** in Settings when ready.
- [ ] After a few missions, run a benchmark pass on the Progress page and compare real-need evidence with baseline-0.

## Research reach

- [ ] **YouTube API key (free, optional).** Lets research missions read public YouTube comments.
  1. Open the Google Cloud console and create a new project.
  2. Enable **YouTube Data API v3** for it.
  3. Go to Credentials, create an **API key**, and restrict it to YouTube Data API v3.
  4. Add it to `.env` as `YOUTUBE_API_KEY=…`, restart `npm run worker`, and check that Settings → Connections shows YouTube as connected.
  Comments are kept for 30 days and then deleted.
- [ ] **Local browser (optional).** In `packages/core` run `npx playwright-core install chromium` (about 150 to 300 MB, installed to `%LOCALAPPDATA%\ms-playwright`, usually on C:). It helps with pages that need JavaScript. Settings → Connections shows whether it is installed (once the worker has run).
- [ ] After the key and Chromium are set up, run two $5 missions and compare **Pages read** (Page fetching card) and **Social share** on the Library page with what they were before.

## Use the app

- [ ] Do not generate a validation pack for a consumer case yet. Its outreach drafts are cold emails, and CASL does not allow cold emails to individuals without consent. Consumer outreach rules come later.

- [ ] Run a bench-v2 pass after merging and score the cases. It is the first pass with consumer ideas, business models, barriers and the value multiple, and the scorecard rows for them read "no data" until then.
- [ ] Give each case a **Your gut** score (Score tab). It feeds the owner verdict on the Progress page; press **Recompute** on a pass afterwards.
- [ ] Walk through the tour ("Take the tour") once on your computer and once on your phone, in light and dark mode. Report anything confusing.
- [ ] Try **Hide** and **Reset** on the example case (Settings → Example case).
- [ ] Generate a validation pack on a real case from its Validate tab.

## Outreach (from the freight validation run)

- [ ] Set your sender identity in Settings (name, mailing address, phone or website). Every outreach email must include it.
- [ ] Rewrite the freight drafts with your identity in them: open the case's Validate tab and press **Run validation again** with "Rewrite drafts for prospects not yet contacted" ticked. Or run `npm run gen -- validate shipper-detention-proof-packets-for-freight-brokers --skip-prospects --redraft`.
- [ ] Contact the freight brokers yourself (the app never sends email), then log what happened on the Validate tab.
- [ ] Ask your friend for permission before anything about their pilot site is fetched or contacted.

## Before any public release

- [ ] Choose and add a LICENSE. The README currently says "all rights reserved".
- [ ] Remove or move private details. `docs/CONTEXT.md` and `docs/runs/*` name the pilot site and real prospects, and these are in the git history too.
- [ ] Decide on LLM configuration for other users. One key is used for both API formats, and the default base URLs point at your employer's gateway.
