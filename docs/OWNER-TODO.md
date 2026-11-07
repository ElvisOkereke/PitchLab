# Things only you can do

A running list of what is waiting on you. Done items are removed as work lands; tell Claude when you finish something.

## Keep it running

- [ ] Restart `npm run worker` (and `npm run web`) whenever Claude merges new work, so both run the latest code. Settings → Connections should then show YouTube, Product Hunt and the local browser as connected.
- [ ] Turn on **Background research** in Settings when you want the library to keep growing on its own.
- [ ] YouTube-only library entries are deleted 30 days after collection (the 2026-10-28 batch goes around 27 Nov). New missions or background research on the same topics bring fresh ones back.

## Judge the ideas (your part of the quality loop)

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
- [ ] The planned capture service downloads TikTok, Instagram and YouTube videos against those platforms' terms (your call for a private prototype). It would have to be removed or replaced before any public or commercial release.
