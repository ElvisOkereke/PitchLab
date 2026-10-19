# Owner-seeded runs of five screened-out ideas — 2026-10-19

Five ideas that earlier open runs screened out (below the cut at screen, so never gated) were written to
`docs/ideas/*.md` from their stored DB fields (no added evidence; commit `a8e3b50`) and run one at a time with
`npm run gen -- run --seed idea --file docs/ideas/<slug>.md` on `main` (tuning-2 merged), default models, no
`MODEL_OVERRIDES`. Then `npm run gen -- export --all`. No source changes. Nothing was fetched from or submitted to
gamersgetaway.ca.

Tools: two read-only scripts (not committed): `packages/core/scripts/find-ideas.ts` (find stored ideas by title words)
and `packages/core/scripts/owner-runs-report.ts` (cost, gate verdicts, claims by section × status per run).

## Runs

| # | Idea file | Run id | Status | Time | Cost |
|---|---|---|---|---|---|
| 1 | `freight-detention-proof.md` | `637adada-c512-442b-a782-b96570656f18` | succeeded | 5.6 min | $3.43 |
| 2 | `permit-market-share-report.md` | `9bde4bc1-f84f-4385-b557-61c1d1d5da3b` | succeeded | 6.3 min | $4.06 |
| 3 | `rent-notice-deadline-engine.md` | `41e829f9-e976-4b4e-aee9-c5f364fee8e8` | succeeded | 6.9 min | $4.33 |
| 4 | `media-fee-invoice-reconciliation.md` | `f2ba7943-fd3c-4e7f-8190-d65fae174f4f` | succeeded | 7.5 min | $5.46 |
| 5 | `checkout-outage-claim-pack.md` | `6470abc2-6f6d-435e-af46-8c3c8a9b05f3` | succeeded | 6.7 min | $4.29 |
| | | | | **33 min** | **$21.56** |

- All five succeeded first time: 130 LLM calls, 0 failed, 0 × 429, no resumes.
- Owner seeds skip screen and the gate is advisory only, so all five got a case, each with gate flags.
- Dedupe matched each owner idea to its stored original (similarity 0.94–0.997) and kept it, as it should for owner
  ideas.
- Biggest cost: writing the case, $2.27–$4.07 per run (64–75%). Then harvest $0.27–$0.85 (web search only; idea seeds make
  no free-source calls) and competitor research $0.37–$0.64.

## Per idea

Verification counts are verified / unsupported / needs_review / unreachable.

### 1. Shipper Detention Proof Packets for Freight Brokers

`output/cases/shipper-detention-proof-packets-for-freight-brokers.md`

- **Buyer:** owners or billing leads at small and mid-size US/Canadian truckload brokerages (5–50 staff, 200–1,000
  loads a month). The broker owes carriers detention but only collects it if the shipper accepts the proof.
- **Mechanism:** `money_recovery` (run 3 had declared it `compliance`).
- **Gate flags:** `autonomy` (packaging evidence that exists can be automated; getting evidence that was never captured
  cannot). `generic` passed. Competitors named: DetentionIQ, Laneproof, Transflo Workflow AI for Brokers. The case
  adds DockClaim ($49/mo, carrier-side), LongMile, outsourced freight auditors and TMS modules.
- **AI scores:** pain 2 · roi 1 · evidence 3 · speed 2 · autonomy 2 · novelty 4 · reach 4 = **2.57**.
- **Numbers:** $1/load × 500 loads = $6,000/yr. Problem cost $21,354, savings $6,406 (30%). **ROI 1.07×, payback 11.2
  months**, gross margin 82%, year-1 revenue $120k.
- **Inputs:**
  - Sourced: detention fee $63.71/hr (ATRI, quoted on DetentionIQ's site) and billing clerk wage $23.32/hr (BLS
    via nuecareer).
  - Assumed: 20 lost detention hours a month (the case calls it "the most important number to verify"; no
    broker-to-shipper loss data exists), 500 loads a month, the $1 price, the 30% reduction, 5 staff hours a week,
    4,000 reachable brokers, 0.5% capture.
- **Verification (26 claims):**

  | Section | Counts |
  |---|---|
  | Evidence | 7/0/0/0 |
  | Numbers | 2/0/0/0 |
  | Signal | 5/1/0/1 |
  | Competitor | 5/2/0/0 |
  | Competitor pricing | 1/2/0/0 |
  | **Total** | **20/5/0/1** |

  The unsupported signal is the Laneproof "lose disputes without timestamped BOL" quote, carried over from run 3. The
  case itself says not to quote it to buyers.
- **"For you to check": 5 items.** One trucker-forum thread the fetcher couldn't load, and unpublished pricing for
  DetentionIQ, Transflo, LongMile and TMS modules. All 5 are real things to open.
- **Signals:** 7 cited, all used. All are on the detention topic, but most are **carrier-side** complaints (drivers
  against brokers). The case's own problem is broker against shipper. The case says so openly.

### 2. Permit-share reports for HVAC marketing agencies

`output/cases/permit-share-reports-for-hvac-marketing-agencies.md`

- **Buyer:** small US agencies (1–20 staff) with several HVAC/plumbing clients in one metro. Canada was dropped: the
  research found no Canadian permit supplier.
- **Mechanism:** `data_product`.
- **Gate flags:**
  - `generic`: Construction Monitor already shows the most active builders; Shovels sells ZIP-level home-services
    permit data; AgencyAnalytics already does white-label reports.
  - `control`: scraping city portals; Apify scrapers cited.
  - `autonomy`: contractor and license matching, plus "jobs won" is not the same as a permit filed.
  - The case handles the control flag by switching to Shovels' resale-friendly licence. It admits the generic flag
    "mostly stands" and that Permit Ledger's $39/mo dashboard is a cheap DIY route.
- **AI scores:** pain 3 · roi 2 · evidence 3 · speed 4 · autonomy 2 · novelty 2 · reach 4 = **2.86**.
- **Numbers:** $49 per contractor client × 8 clients = $4,704/yr. Problem cost $36,000 (one lost $3k/mo retainer a
  year), savings $7,200 (20%). **ROI 1.53×, payback 7.8 months**, gross margin 85.2%, breakeven 2 buyers, year-1
  revenue $109k.
- **Inputs:**
  - Sourced: $3,000/mo retainer (digitalfootprintsolutions), 7,710 US HVAC marketing agencies (RevenueBase), analyst
    wage $43.03/hr (BLS), Shovels Basic $599/mo.
  - Assumed: the $49 price, 8 clients per agency per metro, one lost client a year, the 20% reduction, 0.3% capture.
- **Verification (37 claims):**

  | Section | Counts |
  |---|---|
  | Evidence | 6/2/0/0 |
  | Numbers | 4/0/0/0 |
  | Signal | 5/0/0/1 |
  | Competitor | 8/2/0/0 |
  | Competitor pricing | 6/3/0/0 |
  | **Total** | **29/7/0/1** |

- **"For you to check": 2 items.** One signal page that didn't load (provenleap) and Apify's unpublished pricing.
  Both are real.
- **Signals:** 6 of 7 harvested signals were cited. The writer dropped webtonic.io, and the log recorded it
  (cited-signals-only working). **No signal mentions permits or an agency asking for this.** All are about agency
  reporting time and missed calls. The case says so.

### 3. Rent-notice deadline engine for multi-state property managers

`output/cases/rent-notice-deadline-engine-for-multi-state-property-manager.md`

- **Buyer:** independent PM firms with 100 to a few thousand units across states or provinces. First targets: firms
  with units in WA, OR or CA.
- **Mechanism:** `compliance`.
- **Gate flags:**
  - `generic`: US Tech Automations already does multi-state notice orchestration with an audit trail; TenantPilot
    calculates lawful effective dates; mailbox.bot delivers mail with proof.
  - `autonomy`: a rent roll alone doesn't establish exemptions, increase history or allowed service methods.
- **AI scores:** pain 3 · roi 1 · evidence 3 · speed 4 · autonomy 2 · novelty 2 · reach 3 = **2.57**.
- **Numbers:** $1 per unit per month × 300 units = $3,600/yr. Problem cost $4,223, savings $2,111 (50%). **ROI 0.59×,
  payback 20.5 months**, gross margin 58%, breakeven 7 buyers, year-1 revenue $54k.
- **Inputs:**
  - Sourced: $600/yr per missed $50 increase (a notice-generator page) and property manager wage $33.65/hr.
  - Assumed: a 1% miss rate (3 leases a year), 300 units, the $1 price, 6 staff hours a month, the 50% reduction,
    1,500 reachable firms, 1% capture, $800/mo for rules upkeep and legal review, $200/mo E&O insurance.
  - The idea's own "$2,400 lost" example could not be traced to a source, and the writer did not use it. Good.
- **Verification (31 claims):**

  | Section | Counts |
  |---|---|
  | Evidence | 7/0/0/1 |
  | Numbers | 2/0/0/0 |
  | Signal | 4/0/0/1 |
  | Competitor | 7/0/0/1 |
  | Competitor pricing | 3/4/0/1 |
  | **Total** | **23/4/0/4** |

- **"For you to check": 4 items.**
  - SimpleCertifiedMail product and pricing: the same page, listed twice.
  - The mehiganlaw signal, which didn't load.
  - The WA landlord PDF behind the civil-penalty claim, which didn't load.
- **Signals:** 5, all on topic (CA rent-increase rules, a BiggerPockets thread on mailing notices).
- **Regulatory exposure:** wrong notices carry real legal risk (WA civil penalties up to $7,500 per violation, per the
  case). The case budgets E&O insurance and legal review.

### 4. Contingency ad-invoice recovery for mid-size DTC brands

`output/cases/contingency-ad-invoice-recovery-for-mid-size-dtc-brands.md`

- **Buyer:** the controller, VP Finance or head of growth at US/CA DTC brands spending $1–5M a year on paid media
  across a DSP, affiliates and direct deals. The case says this is the end business, not an aggregator. It suggests
  fractional-CFO firms as an untested channel.
- **Mechanism:** `money_recovery`.
- **Gate flags:** `autonomy`. The revenue-producing work (reading contracts, settling count disputes, negotiating) is
  manual, and contingency pricing means the owner absorbs every investigation that recovers nothing. `generic`
  passed. Competitors named: Media Audit Group ($100K minimum), Abintus, Bionic, apexanalytix.
- **AI scores:** pain 2 · roi 4 · evidence 2 · speed 2 · autonomy 1 · novelty 4 · reach 2 = **2.43**.
- **Numbers:** 30% of about $4,000 a year in credits = $1,200/yr per buyer. Problem cost $13,920, savings $4,176.
  - **Buyer ROI 3.48×, payback 3.5 months**, but **gross margin −285% and no breakeven**: 6 human hours a month per
    buyer ($360) against $100/mo of fee revenue.
  - Year-1 revenue $18k.
- **Inputs:**
  - Sourced: only the 2% data-fee rate (mrktcorrect, "2%–8%").
  - Assumed: everything else. The case marks the key rates "NOT FOUND": 10% of data fees misapplied, 3% of direct
    spend overbilled, 5% of affiliate commissions not reversed, 30% credited back, and the spend levels.
- **Verification (27 claims):**

  | Section | Counts |
  |---|---|
  | Evidence | 7/0/0/2 |
  | Numbers | 1/0/0/0 |
  | Signal | 4/1/0/1 |
  | Competitor | 3/3/0/2 |
  | Competitor pricing | 1/1/0/1 |
  | **Total** | **16/5/0/6** |

- **"For you to check": 11 items, the largest list.**
  - 6 rows for unreachable pages, covering 4 pages: apexanalytix appears as an evidence claim and as a competitor,
    and aimediagroup as a competitor and as its pricing.
  - 5 "pricing not published" rows. **Two of these are wrong:** apexanalytix ("20 to 30 percent of recovered
    overpayments") and IAS/DoubleVerify ("5-10% of media spend") do quote a price, as a percentage (defect D1).
  - With apexanalytix appearing 3 times, about 8 distinct things to check.
- **Signals:** 6, but only 2 bear on billing:
  - 1 is a competitor's marketing (Abintus).
  - 3 are about dead Shopify checkouts. They support only the makegood angle, which the case itself drops as
    unclaimable.
  - The payouts.com quote ("recovered about 11% of programmatic spend") was **not found on the page** (unsupported,
    0.96).
  - No signal shows a merchant finding ad-vendor overbilling.

### 5. Checkout-outage loss reports for multi-store Shopify merchants

`output/cases/checkout-outage-loss-reports-for-multi-store-shopify-merchan.md`

- **Buyer:** owner or finance lead at multi-store US/CA Shopify merchants buying Google and Meta traffic. The case
  suggests paid-media agencies with 20+ Shopify clients as the better aggregator (untested).
- **Mechanism:** `money_recovery`.
- **Gate flags:**
  - `control`: no entitlement to payment. Shopify staff say it offers no reimbursement for missed sales, and
    Cloudflare SLA credits are capped at one month of fees.
  - `autonomy`: deciding causation needs human review on every incident.
  - `generic` passed. Named: Alertly, MDD (forensic accountants), sherocommerce.
  - The case reframes the service honestly: "most of the value is in knowing the number and stopping the next burn,
    not in getting money back".
- **AI scores:** pain 2 · roi 2 · evidence 3 · speed 4 · autonomy 2 · novelty 3 · reach 2 = **2.57**.
- **Numbers:** $490 per incident, 1 incident a year. Problem cost $7,747, savings $1,162 (15%). **ROI 2.37×, payback
  5.1 months**, **gross margin −17.6%, no breakeven** ($40.83/mo of revenue against $48 delivery). Year-1 revenue $12k.
- **Inputs:**
  - Sourced: CPC $3.49 (shno.co) and $7 per downtime minute (AlertsDown's marketing copy).
  - Assumed: incident frequency (NOT FOUND), 300 clicks, 900 store-minutes of downtime, 8 staff hours at $50/hr,
    the 15% reduction, 5,000 reachable merchants, 0.5% capture.
  - The scorer called out that the ROI applies 15% to gross revenue the case says is unrecoverable.
- **Verification (33 claims):**

  | Section | Counts |
  |---|---|
  | Evidence | 7/1/0/1 |
  | Numbers | 2/0/0/0 |
  | Signal | 8/0/0/2 |
  | Competitor | 6/0/1/0 |
  | Competitor pricing | 1/4/0/0 |
  | **Total** | **24/5/1/3** |

- **"For you to check": 6 items.**
  - 1 claim page that didn't load (isdown).
  - 2 signal pages that didn't load.
  - Alertly, `needs_review` ("checker unsure (confidence 0.40)").
  - 2 unpublished app prices.
  - All are real.
- **Signals:** 10, all cited and on topic, including the Cloudflare thread where a merchant asks how to get
  compensation.

## Ranking

| Rank | Case | AI avg | ROI / payback | Margin | Gate flags | Pitch-worthy now? |
|---|---|---|---|---|---|---|
| 1 | Shipper detention proof packets (freight brokers) | 2.57 | 1.07× / 11.2 mo | 82% | autonomy | **Maybe**: only after the broker interviews below |
| 2 | Permit-share reports (HVAC agencies) | 2.86 | 1.53× / 7.8 mo | 85% | generic, control, autonomy | No (cheap to test) |
| 3 | Checkout-outage loss reports (Shopify) | 2.57 | 2.37× / 5.1 mo | −18% | control, autonomy | No |
| 4 | Contingency ad-invoice recovery (DTC) | 2.43 | 3.48× / 3.5 mo | −285% | autonomy | No |
| 5 | Rent-notice deadline engine (PM firms) | 2.57 | 0.59× / 20.5 mo | 58% | generic, autonomy | No |

The ranking is my judgement, not the AI average. Permit scores highest, but its `generic` failure stands. Freight is
the only one where the gate found no one already selling it.

## Read

**None of the five is ready to pitch as a first paid service.** The pipeline worked well on them: five honest cases
for $21.56, all of which state their own weak points. But every case failed `autonomy`, and every ROI rests on an
input marked NOT FOUND.

- **Freight detention proof: the best of the five, still unproven.**
  - Strongest part: a real gap, with nobody selling it. The broker-to-shipper side isn't served: DetentionIQ and
    DockClaim are carrier-side, and Laneproof audits the other direction. `generic` passed. The buyer is a true
    aggregator, and the levels table is clear.
  - Biggest hole: no data at all on how much brokers lose to shippers for lack of proof. The 20 hours a month is
    invented, which gives ROI 1.07×. The service also can't create evidence that was never captured. And Transflo
    is moving into broker back-office work.
  - Check by hand: the case's own next action. Call 5–10 FMCSA-listed brokers, get last month's rejected or
    short-paid shipper detention claims, and sort them into (a) evidence existed but was scattered or sent late,
    (b) partial or contested, (c) never captured. Only (a) is sellable.
- **Permit-share reports: fast to build, but a thin moat.**
  - Strongest part: speed and reach. It's buildable on Shovels' licensed data in days, and there are 7,710 listed
    agencies.
  - Biggest hole: it's packaging on top of data Shovels, Construction Monitor and Permit Ledger ($39/mo) already
    sell. No signal shows an agency wanting permit data. And a permit filed is not a job won through marketing.
  - Check by hand: whether Shovels' free plan gives clean contractor matches for one metro (more than about an hour
    of matching per client kills it), then ask 10 agencies about $49 per client.
- **Checkout-outage loss reports: the pitch fails its own control finding.**
  - Strongest part: well-evidenced pain, with on-topic merchant threads and a CSV-only pilot in days.
  - Biggest hole: no one pays the money back. Without recovery it's a $490 report about a roughly yearly event,
    with negative margin once human review is counted, and outreach has to land within days of an outage.
  - Check by hand: ask merchants from the 18 Nov 2025 thread whether they'd pay with no recovery promised. A better
    angle may be the spend-pause product the case mentions, sold to paid-media agencies.
- **Contingency ad-invoice recovery: not something one engineer can run.**
  - Strongest part: novelty. Nobody serves sub-$2M brands on contingency, and the buyer carries no risk.
  - Biggest hole: it's people work (contract reading, disputes, negotiation) with slow credit cycles. Margin is
    −285% under the case's own assumptions. Every recovery rate is NOT FOUND, and the evidence for overbilling is
    thin.
  - Check by hand: whether any ad vendor actually grants such credits. One diagnostic on data-fee and affiliate
    refunds would answer it.
- **Rent-notice engine: weakest economics, already sold, legal exposure.**
  - Strongest part: the timely WA rule changes and a buildable CSV-only pilot.
  - Biggest hole: ROI 0.59×. US Tech Automations already does this. Wrong notices carry civil penalties, and the
    rules table needs legal upkeep.
  - Check by hand: only worth it if PM firms say they'd pick a no-integration tool over US Tech Automations.

**Overall:** these ideas were screened out for a reason. The full pipeline confirms it rather than overturning it.
- The screen's low ranks matched the case-level picture: weak ROI inputs, human labour, or a gap others already fill.
- The one place the screen arguably got it wrong is freight. It is the most distinct idea and the only one that
  passed `generic`, and it deserves an owner-led discovery test before any build.

## Tuning-2 behaviours exercised live (first time on new cases)

| Behaviour | Exercised? | Behaved sensibly? |
|---|---|---|
| `needs_review` status | Yes, once: Alertly product claim, judge confidence 0.40 (case 5) | Yes. Listed in "For you to check" as "checker unsure (confidence 0.40)" and shown as 🔍 in the table. The GitHub "too short" path wasn't hit |
| Competitor product / pricing split | Yes: 40 product claims and 28 pricing claims across the 5 cases | Mostly. "Not published" prices go to the owner list (12 items) instead of failing. Two flaws: D1 and D2 below |
| Cited signals only | Yes: case 2 dropped 1 of 7 harvested signals (webtonic.io) and logged it; the other cases used all their signals | Yes |
| GitHub issues verified via the API | **No**: 0 GitHub URLs in any harvested signal or claim (idea-seed harvest is web search only) | Still untested live |
| Entity decoding | Yes: no stray `&#…;` / `&rsquo;` in the 5 new exports | Yes. One `E&amp;O` in case 3 is the export's deliberate Markdown escaping of `&`, not a decoding miss |

## Defects and gaps found (recorded, not fixed: shared checkout, no source edits)

No run failed and none needed a resume. These are behaviour gaps, not crashes.

| # | Where | What happened | Diagnosis |
|---|---|---|---|
| D1 | `hasPriceFigure` (`packages/core/src/case/schema.ts`, `PRICE_PATTERNS`); run `f2ba7943` | Percentage-priced competitors ("a percentage of recovered overpayments, usually between 20 to 30 percent"; "typically 5-10% of media spend") show "🔍 not published — check" and appear in "For you to check" as "pricing not published". | The patterns only recognise currency, billing-unit or "free" forms, so `N%` / "N percent" prices never get a `competitor-pricing` claim. Contingency and percent-of-spend pricing is common in recovery and audit services. |
| D2 | `competitor-pricing` verify (deep-case stores one `url` per competitor) | 14 of 28 pricing claims came back ❌ unsupported. About 10 of those are hedged or second-hand strings the writer attributed honestly, e.g. "Not published (third-party estimate: $200 to $800 a month)", "Not published; market rate $300–$500/hr", "… per inso.codes", "Not published (a reviewer says it was free)". They contain a figure, so they are checked against the competitor's own page and fail. Unsupported items stay out of the owner list, so these show ❌ but nobody is told to look. | Pricing text mixes "not published" with a third-party figure, and there is only one URL to check against. Either the writer should cite a pricing source URL per competitor, or hedged pricing should go to `needs_review`. |
| D3 | `competitor` product claims | Category "competitors" ("Outsourced freight auditors", "Manual workaround: AP three-way match", "Ad verification (IAS, DoubleVerify)", "TMS detention modules") and competitors linked through third-party blog posts (Swydo, DashThis, Media Audit Group) are judged ❌ unsupported. All 7 unsupported product claims are of this kind. | A product check on a category, or on someone else's article, can't confirm anything. Small noise, but it makes the Product column look worse than it is. |
| D4 | "For you to check" list | The same unreachable page is listed once per claim: apexanalytix 3×, aimediagroup 2×, SimpleCertifiedMail 2×. | Items are per claim, not per URL. Cosmetic: grouping by URL would cut case 4's list from 11 rows to about 8. |
| D5 | harvest → signals | Two cited signal quotes are not on their pages: Laneproof (case 1, carried over from run 3) and payouts.com "recovered about 11%" (case 4), both 0.95+ unsupported. Both still count toward the gate's `evidence` source count. | The harvest extractor produced quotes the page doesn't contain. The case shows ❌ on them, which is correct, but the gate's evidence rule counts them as independent sources before verify runs. |

## What the owner should check by hand (across all five)

1. **The key unsourced input in each model.** Freight: shipper detention lost per broker. Permit: whether agencies
   lose clients they could keep with this report. Rent: the notice miss rate. Ad invoices: vendor credit success
   rate. Checkout: incident frequency. Each case's "Next action" names the test, and they are good.
2. **Closest competitors.** Freight: Transflo Workflow AI broker edition (pricing and roadmap). Permit: Permit
   Ledger's $39 dashboard and Shovels. Rent: US Tech Automations.
3. **Owner-list pages the fetcher couldn't load.** These are listed in each case.
