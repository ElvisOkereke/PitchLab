# Validation pack, first live run: freight detention case (2026-10-19)

Plan 3, Task 9. Case `shipper-detention-proof-packets-for-freight-brokers`. Sender settings were deliberately left
unset, no `--pilot-site` was passed, and nothing was sent anywhere.

## What ran

| # | Branch / command | Result | Model cost |
|---|---|---|---|
| 1 | `main`: `validate <slug> --prospects 25` | exit 0. Pack generated; 10 prospects; 4 emails; 4 × 3 drafts; landing page; 5 files | $1.04 (11 calls) |
| — | `outreach status <slug>` | 10 prospects (4 with email), new 6 / drafted 4, checklist 0 of 5 | — |
| 2 | `main`: same command again (idempotency) | exit 0. Pack and landing kept (0 model calls); 7 found, 5 new, 2 already listed; 4 drafts kept, 2 new | $0.58 (6 calls) |
| 3 | `fix/validation-live`: same command plus `--refresh` (checking the fixes live) | exit 0. Pack and landing regenerated; 15 found, 13 new; 7 new emails; 7 new prospects drafted | $1.52 (17 calls) |

**Total: $3.14, 34 LLM calls, 0 failed calls, 0 data calls.** The research call (Sonnet with 6 web searches,
$0.45–0.58) runs every time unless `--skip-prospects` is passed. The pack (Opus) costs $0.37–0.62, outreach costs about
$0.02 per call, and the landing page about $0.05. There were 10 structured-output re-asks out of 23 outreach calls (43%),
plus 1 pack re-ask. The router does not log why it re-asked.

**DB:** backup taken at `.data/pglite-backup-20261019-222601`. Migrations 0004 and 0005 applied on first start.
signals 161, ideas 68, cases 9 and claims 220 were unchanged after all three runs. Final state: 28 prospects, 39 drafts
(13 × 3), 1 pack, 1 landing page, 0 settings, 0 events, no duplicate (case, domain) rows.

## Prospects

**Requested 25. Got 10 (run 1), then +5 and +13.** The research step returns 7–15 candidates per call.

**Defect 1 (fixed):** the research prompt passed the market as `CA, US`, and the model read it as California. All 17
prospects from runs 1 and 2 were described as California businesses, and none was Canadian. Several were not even in
California: IEDS is in Spokane, WA ("Inland Empire" is the Spokane region), Cowtown is in Fort Worth, TX, and Book
Freight is in Birmingham, AL. After the fix, run 3 returned 7 Canadian firms out of 13 new prospects (Toronto, Vancouver,
Calgary, Valleyfield QC, Saskatoon).

**Spot-check (14 sites fetched):** all 14 are real operating businesses. None is a software vendor or a directory.

| Fit | Prospects |
|---|---|
| Good: small or mid-size broker, fits the 5–50 staff truckload buyer (7) | Horizon Fast Freight (Toronto, family-owned), Book Freight (AL, broker agent), Sac Freight Lines (Sacramento), Cal West Freight Lines (Ontario CA, MC 848367), Radius Transports (MC 1452881), Qeep Logistics (North York, MC-1613475), Cowtown (TX, "50+" staff, at the top of the range) |
| Partial (2) | Logic-ology (BC 3PL/forwarder, part of the Stryder group), Butter Freight (small San Diego freight firm; broker status unclear; its site returned 403 to our fetcher) |
| Poor (5) | Tax Air Nationwide (Milwaukee, about 500 staff), Direct Drive Logistics (network of 50+ offices), CalFreight (asset carrier and warehousing, acquired by Trimac), IEDS (Spokane warehousing/asset hybrid), Cavalier (TFI International asset LTL carrier) |

About half are usable broker fits. `location` is often blank or wrong, and `fit_reason` sometimes repeats the wrong
California framing.

**Emails: 13 of 28 prospects (46%).** All 13 are `self_published` and all are shared role inboxes (info@ × 9, sales@,
brokerage@, contact@, carriers@). None is a named person. **CASL split: self_published 13, unknown 15 (no email),
third_party 0.**

- **Defect 2 (fixed):** Book Freight's contact page lists `info@` and `carriers@`. `carriers@` is not in the role-inbox
  list, so it ranked as a named person and won. That inbox is for carrier recruitment, which is the wrong audience. The
  stored address is kept as is (by design), so the owner should use `info@gobookfreight.com` by hand.
- `nfo@cavalier.ca` is a typo on Cavalier's own page: an empty `mailto:nfo@` link sits right after the visible
  `info@cavalier.ca`. "nfo" is not a known role, so it ranked first. This is not a parser bug, and Cavalier is a poor fit
  anyway.
- Missed addresses: Cloudflare email obfuscation hid the addresses on Sac Freight, Radius and the Book Freight homepage.
  Radius also has `info@` only inside a script/JSON-LD block, which is stripped. Butter Freight's `SmoothOps@` is visible,
  but the site blocks our fetcher (403).

**Emailable today:** 13 rows in `outreach.csv`. Drop Cavalier (bad address, and a carrier) and switch Book Freight to
info@. That leaves **about 11 addresses, of which 6–7 are good-fit brokers**. Nothing can go out until the sender
identity is set.

## Outreach drafts (read 9 cold emails and 8 follow-ups in full)

- **Honest and restrained.** Every draft hedges ("I don't know your setup, so this may not apply", "I'd guess"). None
  promises recovered dollars, and the ask is a free look at past rejected claims. No figure appears beyond the verified
  "2 free hours, then an hourly rate" and the case price. The unverified Laneproof 70% figure and the ROI numbers never
  appear. No drafts contain links, domains or addresses. Footers show `[SET SENDER NAME]`, `[SET SENDER ADDRESS]` and
  `[SET SENDER CONTACT]` plus a reply-unsubscribe line, and all three files carry the loud CASL warning.
- **Prospect facts come from their sites or the research.** Examples: "Northern California brokerage since 1989"
  (CalFreight), "family-owned" (Horizon, Keller), "licensed brokerage in Ontario, CA" (Cal West). No invented facts were
  found. Two problems, though: the personal line is thin (one sentence restating the services list), and on poor-fit
  prospects it is aimed wrong (Cavalier is an asset carrier).
- **Defect 3 (fixed):** the price was passed to the model as "1 per load processed", with no currency sign. Run 1 shipped
  "Pricing is 1 per load processed, billed monthly." in Book Freight's follow-up 1 and in the landing page offer. After
  the fix, all 7 new drafts and the regenerated landing page say "$1 per load processed". The 4 run-1 drafts are kept
  unchanged by design, so the Book Freight follow-up 1 still needs a manual "$".
- **Would I send them?** Not as they are. Changes I would make:
  1. Drop the price from the cold email, since the goal this week is interviews, not sales.
  2. Ask one question instead of asking for "last month's rejected claims", which is a heavy first ask from a stranger.
     For example: "Do shippers ever refuse your detention rebills because the check-out time or notice was missing?"
  3. Cut the generic line "Brokers can usually pay detention only if the shipper accepts the documentation". The
     prospect knows this, and it reads like a lecture.
  4. Say who you are in the body: a Toronto software engineer researching this, not selling.

Example, unedited (Horizon Fast Freight, run 3, cold):

> Hello,
>
> I saw that Horizon Fast Freight does FTL, expedited and cross-border brokerage in Ontario. I don't know your setup, so
> this may not apply.
>
> Brokers can usually pay a carrier's detention only if the shipper accepts the proof. That proof is often scattered: an
> arrival time in a driver text, a check-out time handwritten on the BOL, the ELD record somewhere else.
>
> I'm building a small tool that pulls those timestamps from your emails, texts and BOL scans. It checks them against
> each shipper's free-time and notice terms while the load is still moving. It costs $1 per load processed, billed
> monthly.
>
> Could I run last month's rejected or written-off detention claims for free and show you what proof was already there?
> A reply is enough.
>
> --
> [SET SENDER NAME]
> [SET SENDER ADDRESS]
> [SET SENDER CONTACT]
> If you'd rather not hear from me, reply "unsubscribe" and I will remove you right away.

Prospect rows (prospects.csv, prospect_id column omitted):

```
"Horizon Fast Freight Inc.","https://horizonfastfreight.com/","Ontario, Canada","info@horizonfastfreight.com","https://horizonfastfreight.com/","2026-10-20","self_published","drafted","Family-owned business handling domestic and cross-border freight throughout Ontario, offering FTL, expedited and cross-border brokerage."
"IEDS Logistics (Inland Empire Distribution Systems, Inc.)","https://ieds.net/","Inland Empire, California","","","","unknown","new","Provides both LTL and TL freight brokerage; the page is old (2017), so it needs confirmation that the business is still operating."
```

The second row shows the California misreading: IEDS is in Spokane Valley, WA, and its site is current (2026 footer).

## MVP spec

This is the strongest part of the pack, and it matches the case closely: shipper-side detention packets, not
carrier-side, and no driver chasing. Run 1 estimated 10–22 days and run 3 estimated 9–20, both for one engineer with
explicit assumptions: inbound email through Postmark/SES (no inbox OAuth), shipper rules as hand-edited files for about
10 shippers, owner review of every extraction, one PDF template, and a daily digest instead of real-time alerts. That is
believable for a forward-to-address MVP. The manual-first parts are sensible: the retro audit as a spreadsheet (zero
build days), rules typed in and confirmed by the broker, hand-written gap digests for 2–4 weeks, and Stripe invoices by
hand. It also says plainly that building should wait until one broker's group (a) is large. It flags the weak ROI
(1.07×, resting on an unsourced 20 h/month) and the failed autonomy gate.

## Pilot plan and interview kit

- **They match the case's next action** ("call 5–10 brokers about rejected shipper detention claims"). The pilot opens
  with a free retro audit that sorts claims into (a), (b) and (c), followed by a go/no-go at the end of week 1 (group
  (a) at least 40% of lost dollars and at least $1,000/month). Only then come shipper rules and a live month.
- **Permissions:** every step that touches the broker's data or people starts with written permission. There are no
  logins to the inbox, TMS or portals; the broker's own IT sets up forwarding; and drivers, carriers and shippers are
  never contacted. A separate item forbids touching third-party systems without the owner's written permission.
  **The tripwire fallback did not fire:** there are no `reviewNotes` in either pack.
- **Interview kit:** both versions have 11 questions that are open, specific and mostly about the past. Run 3's version
  is the one on disk: "Take the most recent shipper detention claim that got rejected. Walk me through what happened…",
  "Last time a shipper refused detention, did you still pay the carrier? Who made that call and how much was it?". Each
  question comes with why to ask it and what to listen for. The last question is a real commitment test ("what would stop
  you from sending them?"). Run 1's Q10 anchored on per-load pricing; run 3's asks about current tool spend instead.
  Q9 offers a list of past fixes, which is mildly leading. The red flags are good, especially "mostly (b)/(c)" and "only
  pays carriers when the shipper pays".
- **Where to find them** names FMCSA L&I files, LinkedIn titles, TIA, r/FreightBrokers, factoring companies and
  TheTruckersReport threads. It gives no Canadian channel (run 1 put Canada last), even though the owner is in Toronto.

## Checklist and landing page

- **Checklist:** 50 emails, 3 positive replies, 2 meetings, 5 interviews (go if at least 2–3 can name lost dollars), and
  5% landing conversion (marked secondary in run 3). These are sensible as signals, but **50 emails is about 4× the
  addresses this tool found** (13, about 11 usable). The owner will need FMCSA, LinkedIn or Places sources to reach the
  first gate.
- **Landing page:** everything is escaped, with one inline script and one inline style, both hash-pinned. The CSP is
  `default-src 'none'`, `connect-src 'none'` (no endpoint yet) and `form-action 'none'`, plus `no-referrer`. The form
  has a required consent checkbox and a privacy line that shows `[SET PRIVACY CONTACT]`. On submit it says "This form is
  not connected yet". The copy is honest: it is not for carriers, not a fit when evidence was never captured, "We cannot
  promise the shipper will pay", and it quotes only verified figures ($63.71/hr, 4 in 10 stops, about half paid, labelled
  carrier-side). The price line now reads "$1 per load processed, billed monthly". Two small issues: "Data is kept
  separately per customer and can be deleted" is a promise the owner must actually keep, and the optional field asks
  "per month" while the price is per load.

## Idempotency (run 2)

Exit code 0. The pack and landing page were skipped (0 model calls), and no duplicate prospects or drafts were created
(the 2 re-found domains reported "already listed"). The 4 existing drafts were kept. The run cost $0.58: research and
extract $0.49, plus $0.08 to draft 2 new prospects. Every run also re-fetches the sites of all prospects without an email
(11, then 22). That is harmless but slow.

## Defects

| # | Command / symptom | Root cause | Fix (branch `fix/validation-live`) |
|---|---|---|---|
| 1 | `validate`: 0 Canadian prospects; everyone framed as Californian | `prospect-research` rendered `countries` as ISO codes, so "CA" was read as California | `c502e79`: country names in the research prompt (Places already did this) |
| 2 | `validate`: drafts and landing page say "1 per load processed" | `allowedOfferTerms`/`caseMaterial` formatted the price without a currency sign | `478bec2`: `offerPrice()` formats it the way the case export does ("$1 per load processed") |
| 3 | `validate`: Book Freight drafted to `carriers@` | `carriers` was not a role inbox, so it ranked as a named person | `c61af12`: carrier, driver, jobs, press and similar inboxes rank after the general role inboxes |

Each fix was written test-first (RED captured). Full suite 584/584 and typecheck green; the first full-suite run hit a
known timing flake (the 60k nested divs parse took 6.5 s against a 5 s ceiling under load) and passed on re-run. Run 3
confirmed fixes 1 and 2 live. Not fixed (follow-ups): Cloudflare-obfuscated addresses are not decoded, re-ask reasons
are not logged, research runs on every `validate`, and the prospect yield is below `--prospects`.

## Recommendation: testing the freight case this week

1. **Set your identity first:** `config set sender.name`, `sender.address` (a real mailing address, which CASL
   requires), `sender.contact` (phone or site) and `landing.privacyContact`. Then run
   `validate <slug> --skip-prospects` so the footers refresh at no model cost.
2. **Contact first:** Horizon Fast Freight and Qeep (Toronto, so meeting in person is possible; for Canadian brokers
   filter TIA members and LinkedIn by Ontario/Quebec, which the kit does not suggest), Cal West
   (brokerage@, MC listed), Cowtown and Book Freight (use **info@**, not carriers@). Phone Sac Freight Lines and Radius,
   since their emails are hidden. Skip Cavalier, CalFreight, Tax Air, IEDS and Direct Drive. That gives 6–7 real
   conversations, not 50 emails.
3. **Edit each draft before sending:** remove the price, replace the claims request with one yes/no question about
   rejected rebills, delete the "brokers can usually pay…" line, and add one sentence saying who you are. Fix "$" in
   Book Freight's follow-up 1.
4. **To reach the checklist's 50 emails:** build a list from FMCSA/LinkedIn (billing or AR leads by name), or import a
   CSV with `prospects import`. Expect about 45% email yield and about 50% fit from web research.
5. **Treat the interview kit as the real test:** the go/no-go is whether brokers can name last month's lost shipper
   detention dollars and whether those losses were "proof existed but buried" (group a).
