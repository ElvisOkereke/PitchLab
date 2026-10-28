# Things only you can do

A running list of what is waiting on you. It is kept up to date as work lands; tick items off or tell Claude when they're done.

## Set up the research library (Phase 2)

- [x] **Product Hunt developer token (free).** Done 2026-10-27. Used for new products, what they charge, and how they did.
  1. Sign in and open https://www.producthunt.com/v2/oauth/applications
  2. Create an application. The redirect URL can be `https://localhost:3000/callback`.
  3. Use the **Developer Token** (not the API key or secret) and add it to `.env` as `PRODUCTHUNT_TOKEN=…`.
- [ ] After merging, restart `npm run worker`. It applies the database update, which missions and the heartbeat need.
- [ ] After adding the token, restart `npm run worker`. Settings → Connections shows Product Hunt as connected.
- [ ] If PitchLab starts earning money, email hello@producthunt.com for commercial API permission (the developer token is for non-commercial use).
- [ ] Turn on **Background research** in Settings when ready.
- [ ] After a few missions, run a benchmark pass on the Progress page and compare real-need evidence with baseline-0.

## Use the app

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
