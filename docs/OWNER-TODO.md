# Things only you can do

A running list of what is waiting on you. It is kept up to date as work lands; tick items off or tell Claude when they're done.

## Set up accounts and keys (for the research library, Phase 2)

- [ ] **Reddit app (free, about 5 minutes).** This is the best free source of people describing their own problems.
  1. Sign in to Reddit and open https://www.reddit.com/prefs/apps
  2. Click **create another app…**
  3. Choose type **script**. Name it e.g. `pitchlab-research`, and set the redirect uri to `http://localhost:8080` (it isn't used).
  4. If Reddit asks you to accept its Data API terms or request API access, describe it as personal, non-commercial research.
  5. Copy the id shown under the app name and the **secret**. Add them to the repo-root `.env` as `REDDIT_CLIENT_ID=…` and `REDDIT_CLIENT_SECRET=…`. Never paste them into chat.
- [ ] **Product Hunt developer token (free).** Used for new products, what they charge, and how they did.
  1. Sign in and open https://www.producthunt.com/v2/oauth/applications
  2. Create an application. The redirect URL can be `http://localhost:8080`.
  3. Use **Create Token** (developer token) and add it to `.env` as `PRODUCTHUNT_TOKEN=…`.
- [ ] After adding keys, restart `npm run worker`. Settings → Connections shows them as connected.

## Use the app

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
