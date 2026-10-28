# PitchLab user guide

This guide follows the same eight chapters as the in-app tour, in the order you will use them. Each step says what to
do, why it matters and what "good" looks like. Two sections at the end cover the judgement calls:
[how to judge a case](#how-to-judge-a-case) and [when to kill](#when-to-kill).

New words are defined in the [glossary](glossary.md). Installation and settings are in the
[setup guide](dashboard.md). For how it works inside, see [architecture](architecture.md).

**Contents**

1. [Welcome and setup](#1-welcome-and-setup)
2. [Generate cases](#2-generate-cases)
3. [The board](#3-the-board)
4. [Read a case](#4-read-a-case)
5. [Score it](#5-score-it)
6. [Validate](#6-validate)
7. [Outreach](#7-outreach)
8. [Decide](#8-decide)
9. [How to judge a case](#how-to-judge-a-case)
10. [When to kill](#when-to-kill)
11. [Track idea quality](#track-idea-quality)

## The idea in one paragraph

PitchLab is a funnel. A run reads real complaints on the web, writes many ideas and throws most of them away. The few
that survive get a full business case with sources and numbers. You then decide which cases deserve your time, test
them with real buyers, and kill the rest quickly. Most of PitchLab's value is in what it lets you kill early and
cheaply, before you build anything.

## The tour and the example case

The tour starts the first time you log in. **Take the tour** in the top bar replays it from where you left off, starts
over, or runs one chapter. The tour only points at things and explains them. It never presses a button that spends
money.

A built-in **example case** (marked Example) lets you practise every step without spending anything. Its data is
invented. You can score it, move it between stages and log made-up outreach. In **Settings → Example case**, **Reset
example case** puts it back as it was and **Hide example case** takes it off the board. Neither touches your real
cases. The example is left out of spend, counts and "Needs you", and you cannot generate a validation pack for it.
It already has one.

## 1. Welcome and setup

### Start the worker

- **What:** In a terminal in the PitchLab folder, run `npm run worker` and leave it open. In the dashboard open
  **Command center**. The Generator card should show the worker as last seen a few seconds ago.
- **Why:** The dashboard only records what you ask for. The worker is the background program that does the work: it
  calls the AI models and fetches web pages. Without it, queued runs and validation packs wait forever.
- **Good:** "last seen" just now. "Not seen" means the worker is not running, or it is pointed at a different
  database.

### Check your connections

- **What:** Open **Settings** and look at Connections. **LLM API** must say connected. GitHub, Stack Exchange,
  Google Places, Product Hunt and YouTube are optional extra data sources. **Local browser (Chromium)** says installed or
  not installed; it is optional and only helps with pages that need JavaScript.
- **Why:** Every step of a run needs the LLM key. The worker reports which keys it has, never their values, so these
  say unknown until the worker has run once.
- **Good:** LLM API connected. If it says not set, put your key in `LLM_API_KEY` in `.env` and restart the worker.
  For YouTube, put a free key in `YOUTUBE_API_KEY` and restart the worker. For the local browser, run
  `npx playwright-core install chromium` in `packages/core`.

### Fill in who your emails come from

- **What:** Under **Sender and landing page** enter **Your name**, **Mailing address** and **Phone or website**, then
  press **Save settings**. Company and reply-to email are optional.
- **Why:** Canada's anti-spam law (CASL) and the US CAN-SPAM Act require every commercial email to identify the sender,
  give a mailing address and another contact method, and offer a way to unsubscribe. PitchLab adds these to every
  draft, so it will not generate a validation pack until they are set.
- **Good:** All three required fields filled in, with an address you can receive mail at.

## 2. Generate cases

### Build the research library

- **What:** Open **Library** (next to Board). It holds the research PitchLab keeps between runs: problems people
  describe in their own words, what products charge, and how startups fared. Search it, filter it by kind, country,
  voice, source and age, and open an entry to read its quote and sources. To add to it, fill in **Research missions**
  with a topic, tick what to collect, and press **Start research mission**.
- **Why:** Runs draw on the library, so a fuller and more varied library gives your ideas more real evidence to start from.
  Only problem and pricing entries whose quote was checked against the source text count as evidence. Those show a
  "verified quote" badge; anything else shows "unverified".
- **Cost:** The form shows the most a mission can cost ("up to $X"), and a typical cost once a mission has finished.
  The budget (0.50 to 25 dollars, default 2) buys more research: a mission plans
  about 6 queries per dollar (12 to 60). With Pricing ticked, a quarter or more of its web searches go to vendor pricing
  pages, and paid App Store apps add their listed price. The budget is a soft limit: a mission stops starting new steps once it is spent, and the step in progress can run a little over.
  Missions need `npm run worker` running, and at most 3 can wait at once. Or run `npm run gen -- research "your topic"`.
- **Background research:** Off until you turn it on in **Settings → Research**. When on, the worker starts one small
  $1 mission at a time, until the daily cap is spent (the day ends at midnight in Toronto).
- **Where pages came from:** An entry's sources say when a page came from an archived copy (with the date of the copy),
  was rendered in the local browser, or, for YouTube comments, when it will be deleted (they are kept for 30 days).
- **Page fetching:** The **Page fetching, last 30 days** card shows how many pages came through, overall and by route,
  the sites that fail most and why ("blocked (403)", "too little text (needs JavaScript)"). It stays empty until your
  next mission. The Coverage card also shows the **social share**: how much of the library comes from community sites.
- **Good:** The Coverage card shows two health targets: at least 60% of problem entries in operator or neutral voice
  (people who run the business, or neutral sources, rather than vendors), and entries from 10 or more countries.
- **Fix mistakes:** Open an entry and press **Reject** to take it out of search and out of runs. It stays rejected if it
  is collected again. Show rejected entries with Status, then press **Restore** to bring one back.

### Pick a seed

- **What:** Open **Runs** and choose a seed. **Open** looks across every sector. **Sectors** and **Lenses** narrow
  the run to the ones you tick. **Your idea** builds a case for an idea you describe in at least 50 characters.
- **Why:** The seed decides where the run looks for pain. Open is best for discovery. Sectors suits a market you know
  or can reach. A lens is a pattern for spotting an idea, such as "a silent failure nobody monitors". Your idea is for
  testing something you already have in mind.
- **Good:** For your own idea, describe the buyer, the problem and what the service does. A vague idea gives a vague
  case.

### Set the counts

- **What:** **Ideas to generate** (1 to 30, default 12) is how many raw ideas to write. **Ideas to turn into cases**
  (1 to 10, default 3) is how many survivors get a full case.
- **Why:** Ideas are cheap and cases are expensive. More ideas give the filters more to choose from. More cases
  cost more.
- **Good:** The defaults, which cost about $3–7 per run.

### Queue the run

- **What:** Press **Queue run**. History shows it as queued, then running with its current stage, then finished with
  its cost and number of cases. The page refreshes every 10 seconds while a run is active. If a run fails, press
  **Resume**: it continues from the failed stage and reuses the work already done.
- **Why:** Runs take several minutes. Up to three can wait in the queue at once.
- **Good:** Do not worry if an Open, Sectors or Lenses run ends with **no case**. The gate is strict on purpose, and
  most ideas fail it. "Your idea" runs always produce a case: there the gate only advises, and its verdicts show as
  flags.

### Check "Needs you"

- **What:** The **Command center** lists what needs you: cases to score, flagged ideas to keep or kill, replies to log
  and failed runs. It also shows spend for today and this week.
- **Why:** It is the one place to look each day.
- **Good:** An empty list.

## 3. The board

### Stages

- **What:** The board (home page) has five columns: **New**, **Validating**, **Pilot**, **Live** and **Killed**. Each
  card shows the AI score, your score and a key number. On a phone, one column shows at a time; switch with the
  stage buttons.
- **Why:** The stage is where a case sits in *your* process. PitchLab never moves a case for you.
- **Good:** Few cases in Validating at once. Testing two or three properly beats ten half-tested.

### Filters

- **What:** Show one lens only, or only cases with at least a given AI score, then press **Filter**. **Clear**
  removes the filters.
- **Why:** Once you have many cases, filters keep the board readable.

### Killed and gate kills

- **What:** The Killed column holds cases you killed. Under it, **Gate kills** lists ideas the gate stopped, each with
  its failed checks. **Re-run as owner idea** queues a full case run for one of them (about $4).
- **Why:** The gate is a model and can be wrong. If a reason looks mistaken to you, re-running the idea is how you
  overrule it, and PitchLab records that you did.
- **Good:** Read a few gate kills now and then. They show what the gate thinks "generic" or "not autonomous" means,
  and that teaches you what a strong idea looks like.

### Open a case

Click a card's title. The **Leaderboard** page lists every case with its totals and per-criterion scores, sortable by
column, when you want to compare cases.

## 4. Read a case

A case page has a header (stage, gate flags, export) and seven tabs: Summary, Evidence, Numbers, Competitors, Pitch,
Validate and Score.

### Header

- **What:** The stage chip, a yellow **Gate flags** banner if any gate checks failed, and **Export Markdown**, which
  downloads the whole case as a text file.
- **Why:** Gate flags tell you which parts to read with extra care.
- **Good:** No banner. A banner on your own idea is normal; read the reasons.

### Summary

- **What:** The one-liner, buyer, problem, solution and price, then why now, why it wins and the suggested next
  action. Then the gate verdicts, failed checks first. At the bottom, **For you to check** lists sources and claims
  that nobody could confirm automatically.
- **Why:** This is the case in brief. "For you to check" is the work PitchLab could not do for you.
- **Good:** A buyer you could name and find, a problem that costs them real money or time, and a short "For you to
  check" list.

### Evidence

- **What:** The signals (quotes from the web) and the claims behind the case, each with its source and a
  verification flag. A **voice** label says who is talking: an **operator** (someone who runs that kind of business),
  **neutral** (a trade body, regulator, journalist or analyst) or a **vendor** (someone selling to that market).
- **Why:** Vendor blog posts exaggerate pain to sell their product. Operators complaining in their own words is the
  evidence that counts. The gate counts only operator and neutral sources.
- **Good:** Several operator quotes from different sites, mostly verified.

### Numbers

- **What:** The inputs (price, the cost of the problem, reachable buyers and so on), each with its source or marked as
  an **assumption**, then the results: buyer ROI, payback, market size, unit economics, revenue scenarios and the
  formulas used.
- **Why:** The AI supplies the inputs, and code does all the arithmetic, so the formulas are exact. The results are
  only as good as the inputs.
- **Good:** The inputs that drive the result (usually the cost of the problem and the number of buyers) have sources.

### Competitors

- **What:** Each competitor with a product check and a pricing check, plus a "levels" table that shows what existing
  tools check and where each one falls short.
- **Why:** "No competitors" usually means the search missed them. The levels table is the argument for why a buyer
  would switch.
- **Good:** Real, named competitors, and a gap they genuinely leave open.

### Pitch

- **What:** An elevator pitch, three cold emails, two follow-ups, a call script, answers to objections and
  pricing-page copy.
- **Why:** A first draft that saves you starting from a blank page.
- **Good:** Use it as raw material and put it in your own words. The emails you actually send come later, from the
  validation pack.

## 5. Score it

### AI scores

- **What:** Open **Score**. The AI rates the case from 1 to 5 on seven criteria: Pain severity, Buyer ROI clarity,
  Evidence strength, Speed to market, Autonomy, Novelty/non-generic and Reachability. Each score has a note.
- **Why:** It is a starting opinion. Evidence strength is capped by how many of the case's claims were verified (fewer
  than half verified: at most 2; fewer than 80%: at most 3).
- **Good:** Read the notes, not only the numbers.

### Your scores

- **What:** Pick 1 to 5 for any criterion and add a short note on why, including **Your gut**, which only you score.
  Press **Save my scores**. Blank criteria keep their current value.
- **Why:** Your scores sit next to the AI's on the Leaderboard, which can rank cases by yours. Your scores, kill
  reasons and stage moves are all stored, so a planned feature can later tune runs to your taste.
- **Good:** A note on every score you give. In three months, "why I gave Reachability a 2" is what you will want
  to know.

## 6. Validate

Validation means testing the idea with real businesses before you build anything.

### Generate the validation pack

- **What:** Open **Validate** and press **Generate validation pack**. Options: **Prospects to find** (1 to 100,
  default 25), **Skip new prospect search**, **Refresh the pack documents** and **Write the emails again**. The job
  shows "Waiting for the worker", then "Running since …", then "Finished" with its cost. It takes several minutes,
  and the page refreshes itself.
- **Why:** The pack turns a case into a plan you can act on this week.
- **Cost:** about $0.60–1.50. The prospect search is about $0.45–0.60 of that. Tick **Skip new prospect search** when
  you only want new documents or drafts.
- **Good to know:** Only one job per case can be queued or running at a time. If the worker stopped mid-job, the job stays
  "Running". After two hours the tab says so, and you can start the worker again and press the validation button
  again. The worker also saves
  the files to `output/validation/<case-slug>/` on its computer: `pack.md`, `prospects.csv`, `outreach.csv`,
  `outreach-drafts.md` and `landing/index.html`.

### The pack documents

- **What:** An **MVP spec** (what to build first, and what to do by hand at first), a **pilot plan** with success
  measures, and an **interview kit** with questions to ask buyers.
- **Good:** An MVP you could build in a few weeks, and interview questions about the buyer's past behaviour ("when did
  this last happen, what did it cost") rather than "would you buy this?".

### The checklist

- **What:** Your go or kill targets, such as emails sent, positive replies, meetings, buyer interviews and landing
  page conversion. Each line shows your current number against its target and turns to **pass** when you reach it.
- **Why:** It sets the bar *before* you see the results, so you cannot move the goalposts later.
- **Good:** Targets you can reach in a few weeks. The pack shows how many usable addresses you have next to the
  "emails sent" target. If the target is far above that, plan to find more prospects (or import your own with
  `gen prospects import`).

### Prospects

- **What:** Real businesses that might buy, found on the web, each with a website, location, why it fits and, where
  found, an email address. **CASL basis** says how the address was found: **self-published** (on the business's own
  site: best), **third-party** (on someone else's site: take care) or **unknown — do not email**.
- **Why:** Under CASL you may email an address without prior consent only if the person published it themselves and
  your message relates to their role. Third-party directories do not count. Drafts are written only for
  self-published addresses unless you ask otherwise (`gen validate --include-weak`).
- **Good:** Spot-check a handful of prospects. Is each one really the buyer in the case, of the right size? Expect
  some poor fits.

### Landing page

- **What:** Copy for a simple page (headline, offer, call to action) that asks visitors to leave their email. The page
  file is in the output folder on the worker's computer.
- **Why:** Sign-ups from a page with a clear price are a cheap test of interest, and the conversion rate feeds the
  checklist.
- **Note:** Publishing the page and collecting its sign-ups need a hosted form endpoint, which is not built yet.

## 7. Outreach

### Send the drafts yourself

- **What:** Click a prospect to see a cold email and two follow-ups written for them. Copy one into your own email
  program, edit it, and send it yourself.
- **Why:** PitchLab never sends email. You stay in control of what goes out in your name, and you carry the
  responsibility for it.
- **Good:** Each email edited until it sounds like you. Keep the footer: it is your legal identification and
  unsubscribe line. Cold emails and the first follow-up contain no figures; the second follow-up may quote only
  verified ones.

### Log what happened

- **What:** Under **What happened**, choose **I sent it** and press **Record**. Later log **They replied**, **Positive
  reply**, **Meeting booked**, **Not interested** or **Unsubscribe**. After a call, choose **Interview note** and write
  what you learned (the note is required).
- **Why:** These events feed the checklist counts. **Unsubscribe** suppresses the address for good: it is never
  drafted or exported again, as the law requires. Prospects who said no are never drafted again either.
- **Good:** Log on the day it happens. The CLI can do the same: `gen outreach mark <prospect> <type>`.

### Watch the numbers

- **What:** The outreach counts (sent, replied, positive, meetings and more) go up as you log, and the checklist moves
  with them.
- **Good:** Enough sends to mean something. Five emails with no reply tells you little; fifty does.

## 8. Decide

### Move the case

- **What:** In the case header pick **Validating**, **Pilot** or **Live** and press **Move**. To kill a case, pick
  **Killed** and write why in the note (a reason is required).
- **Why:** Every move is logged with its reason. Kill reasons are the most useful feedback for improving future runs.
- **Good:** A kill reason someone else could understand, such as "buyers said their booking software already does
  this", not "meh".

### Changed your mind?

A killed case has an **Overturn kill** button. It moves the case back to New. Use it when you killed an idea too
early or the facts changed.

### Every day

Start in the **Command center**. "Needs you" lists cases to score, flagged ideas to keep or kill, replies to log and
failed runs.

## How to judge a case

A case is a well-researched argument, not a verdict. Check these four things before you spend time or money on it.

1. **Evidence quality.** Open Evidence. Count the operator quotes from distinct sites. One busy forum thread is one
   source, not five. Vendor quotes are marketing. If the pain rests on a single thread or on vendor blogs, treat it as
   unproven.
2. **Verification flags.** Each claim and link has a flag:
   - **verified**: the source was fetched and supports the claim;
   - **unsupported**: the source was fetched and does *not* support it, a real warning;
   - **unreachable**: the page could not be read (blocked, or built by JavaScript), so check it yourself;
   - **needs review**: the checker was unsure, or could not confirm a competitor's price or product;
   - **unverified**: not checked.
   Everything not verified lands in Summary → For you to check. Work through that list.
3. **The numbers' assumptions.** On Numbers, find the two or three inputs that drive the result. Usually these are
   the cost of the problem to one buyer and the number of reachable buyers. If they are assumptions, the ROI is a
   guess. A buyer ROI multiple below 1× means the buyer pays more than they save. A buyer needs a clear multiple to
   bother switching. A thin margin, or a breakeven at hundreds of customers, means a hard business even if the pain is
   real.
4. **Unverified competitors.** A competitor list is a starting point. Search for the problem yourself, the way a buyer
   would. If you find an established product doing the same job, the case's gap is probably not real. Pricing marked
   "needs review" may simply not be published.

Also ask: could you reach fifty of these buyers in a month? And can you deliver mostly by software, without becoming a
consultant? Those are the two questions the gate's reachability and autonomy checks try to answer.

## When to kill

Kill early. A killed case costs nothing to keep, and you can overturn it later. Kill when:

- **The evidence collapses.** The key claims are unsupported, or the pain comes only from vendors.
- **The numbers need a miracle.** The ROI only works with the most generous assumption, or the margin is negative.
- **Someone already sells it,** and the gap is only a new buyer, channel or packaging rather than something the
  incumbents cannot do.
- **It cannot be automated.** Each customer would need your judgement or manual work every week.
- **It needs permission you do not have**: a licence, a partnership, or one platform's goodwill.
- **Buyers say no.** You hit your outreach target and the checklist's positive-reply or interview targets are still
  far off. Interviews show the problem is rare, cheap or already solved.
- **You would not pitch it.** Your gut score is a 1 or 2 after reading everything. You are the one who has to sell it.

Write the reason in the kill note. Reasons like these help the next runs avoid the same dead ends.

## Ideas for people as well as businesses

- **What:** Each idea now says who pays (a business, an individual, or both), how it earns money (its business
  model: subscription, one-off, usage, marketplace, transaction fee, data sales, ads, affiliate, licensing, freemium,
  or service plus software), and two barrier scores: how hard it is to start and how hard to copy. A consumer idea
  must name an individual who pays, or whose attention or data is the product. A business idea is never relabelled
  as "both" to fill the mix.
- **Why:** Earlier runs only found business-to-business ideas. Consumer ideas, and models such as ads or affiliate,
  widen the search, and the barrier scores point you to ideas that are cheap to start and hard to copy.
- **Value multiple:** a case now shows how much a year of the product is worth to the paying user against what it
  costs them, with the source of each figure. Data sales use the value and price for the client who buys the data, and
  freemium uses the paid tier's price. Ad- and affiliate-funded ideas, where the user pays nothing, show a note instead of
  the multiple, the return figure and payback, and sit in the middle of the money ranking. A multiple under 1× gets the
  "value below price" flag and the case is kept for you to judge. The older return figure is still shown. The Summary tab
  labels the idea's own figure "Idea's estimate of value to the user".
- **Consumer lenses:** six lenses aim at individuals: earn on the side, save money automatically (bills, subscriptions,
  fees, insurance), life stages, solo creators, leapfrogging a market, and an AI assistant or free-to-user attention
  product. Tick them under **Lenses** when you start a run. Runs without a lens pick at most 6 lenses and include at
  least 2 consumer ones when the seed allows.
- **Consumer pitch:** a case for individuals has no cold emails, since Canada's anti-spam law (CASL) allows no implied
  consent for them. Its Pitch tab lists channels (communities, search, app stores, content, partnerships, paid ads) and
  landing-page copy instead.
- **Evidence before the gate:** an idea reaches the gate only when its signals already meet the gate's evidence rule, so
  no gate slot is spent on an idea that would be killed for thin evidence. Runs with consumer lenses or segments also
  collect individuals' own posts about their problems as evidence.

## Track idea quality

- **What:** Open **Progress**. It scores how varied, well-evidenced and valuable your generated ideas are, and shows
  the scores for a baseline and your newest benchmark passes side by side. Each row has a target, with a green or red
  badge when a result meets it or misses it.
- **Why:** After you change something in PitchLab, you need to know whether ideas got better or only different. A
  benchmark is a fixed set of 5 runs (called bench-v2), so every pass is measured the same way.
- **Do it:**
  1. Freeze a baseline once with `npm run gen -- bench baseline`. Until then the page says "No baseline yet".
  2. After a change, press **Run benchmark**. It queues 5 runs, about $15–35 in model calls, and only when you press
     it. It is refused while other runs are waiting or a pass is already running. Keep `npm run worker` running.
  3. The page refreshes while the pass runs. When it finishes, a new column appears. A pass where a run failed is
     marked "incomplete".
  4. Under **Score these cases**, open each case and give it your gut score. A pass freezes when its last run ends,
     so scores you give afterwards show only after you press **Recompute** under that pass's column. That adds a new
     column with today's scores; the old one stays as it was. Retrying a failed run after its pass froze doesn't change
     the pass either: press Recompute to include the retried run.
- **What good looks like:** Repetition and near-duplicates fall, buyer variety rises, and your own verdict stays above
  3.5. The newer rows should also rise: consumer share (at least 30% of ideas for individuals), business-model variety (at least 4 models per run) and easy-to-start, hard-to-copy ideas (at least half of cases). Passes from before these fields existed show "no data" on those rows. With only 5 runs, small differences (under about 0.05 similarity, or one case) may be noise.
- **From the terminal:** `npm run gen -- bench report` prints the scorecard and writes it to `output/bench/`.
  Add a pass id and `--recompute` to freeze a new snapshot of that pass with today's data (the same as the Recompute
  button). Each column shows a short pass id, and the report prints the full one. `npm run gen -- bench baseline
  --dry-run` shows what a baseline would hold without saving it.
