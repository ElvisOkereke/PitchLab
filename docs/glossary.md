# PitchLab glossary

Plain-language meanings for the terms you will see in PitchLab. The first group matches the "?" tips in the app; the second group covers the steps a run goes through and the validation tools.

## Terms with a "?" tip in the app

### Seed
The starting point for a run. Open looks across every sector, Sectors and Lenses narrow it to the ones you tick, Your idea builds a case for an idea you describe, and From my finds starts from the links you shared.

### Lenses
A lens is a pattern for spotting a business idea, such as a silent failure to monitor or a task to turn into a fixed-price service. Tick lenses to make the run look only through those patterns.

### Sectors
The kinds of small business the run can research, such as HVAC, dental clinics or managed IT providers. Tick some to keep the run to those sectors.

### Ideas to generate
How many raw ideas the run writes down before it filters them. More ideas give the filters more to choose from.

### Ideas to turn into cases
How many of the surviving ideas get a full business case with sources and numbers. Each case is the expensive part of a run, so keep this small.

### Gate flags
The gate runs checks on each idea (not generic, regulation, control, autonomy, reachability, evidence, revenue ceiling), and a flag means one failed. For an idea you wrote yourself it only advises, so you still get the case and decide whether to keep or kill it. For other seeds, an idea that fails can be killed at the gate before it gets a case.

### Stage
Where this case is in your own process: New, Validating, Pilot, Live or Killed. You move it by hand; PitchLab never changes it for you.

### AI scores
The AI rates the case on each criterion from the sources it found. They are a starting opinion, separate from your own scores, which you enter below.

### CASL basis
CASL is Canada’s anti-spam law. This says how the prospect’s email address was found: published by the business itself, on a third-party site, or unknown. If it says unknown, do not email; PitchLab never sends email itself. The three values are self-published, third-party and "unknown — do not email".

### Checklist
The targets that decide whether an idea is worth pursuing, such as 50 emails sent, 3 positive replies and 5 buyer interviews. Each one passes when your tracked numbers reach its target.

### Overturn kill
Moves a killed case back to New so you can work on it again. Use it when you killed an idea too early or the facts changed.

### Worker
The background program that does the work in your queued runs and validation packs. Run it with npm run worker. It checks in regularly, and it shows as not seen after 60 seconds of silence.

### Notional spend
An estimate of what the AI calls cost, worked out from a price table. It is not a billed amount, so your provider’s invoice is the real figure.

### Benchmark
A fixed set of 6 runs you repeat after each change, so you can compare idea quality before and after. The scorecard measures how varied and well-evidenced the ideas are, and your own gut scores on its cases count too. Press Run benchmark on the Progress page, or use `npm run gen -- bench run`. The current set is bench-v3: two open runs, two sector runs (logistics and construction, healthcare and education) and two lens runs (AI replaces labour with 10x on an incumbent, and a consumer chore with a new capability). bench-v1 and bench-v2 stay as they were. Older passes keep their own scores and are not changed.

### Business model
The way an idea earns money, such as a subscription, a one-off sale, a fee per transaction, ads or affiliate links. Ideas are written with one of these models, and an idea from before this existed reads as a subscription (the scorecard leaves them out). The eleven models are subscription, one-off, usage, marketplace, transaction fee, data sales, ads, affiliate, licensing, freemium, and service plus software.

### Value multiple
How much a year of the product is worth to the person who pays, divided by what it costs them for a year. A multiple of 3× means they get three times the price back, and ad- or affiliate-funded ideas, where the user pays nothing, have none (they sit in the middle of the money ranking). Data sales use the value and price for the client who buys the data, and freemium the paid tier's price. It uses the value and price the idea cites (a library entry, a signal or a stated assumption), and the Numbers tab shows it beside the older return figure.

### Barriers
Two 1 to 5 scores on an idea: how hard it is for someone to start it (1 is easy) and how hard it is for a rival to copy it (5 is hard). The best ideas are easy to start and hard to copy. The scorecard counts a case as easy to start and hard to copy when the first score is 2 or less and the second is 4 or more.

## How a run works

### Run
One pass of the pipeline. You queue it with a seed and two counts, the worker picks it up, and it ends with zero or more cases.

### Harvest
The first step. It researches the web for real complaints and signs of demand in the sectors or lenses you chose.

### Signal
One piece of evidence found while harvesting, such as a forum thread or review, with its link.

### Voice
Who wrote a signal: someone inside the affected business (operator), an independent third party (neutral), or someone selling to that market (vendor). It helps show whether the pain is real.

### Ideate
The step where the AI writes business ideas based on the signals, up to the number you asked for.

### Dedupe
Removes ideas that are near copies of each other, or of ideas that already have a case or were already killed, so you do not see the same idea twice.

### Screen
A quick filter that keeps the most promising ideas and limits how many share the same way of delivering value, before the stricter gate.

### Gate
The stricter pass/fail check on each remaining idea. See Gate flags above.

### Case
The full business case for one idea: summary, evidence, numbers, competitors and pitch. Cases are what appear on the board.

### Claim
A specific factual statement in a case, such as a price or a number, that can be checked against a source.

### Verify
Checks the claims against their sources. The share of claims that hold up limits how high the evidence score can go.

### Score
The AI's rating of a case on each criterion, capped by how well its claims verified. You add your own scores next to them.

## Validation tools

### Validation pack
A set of documents the AI generates for a case: an MVP spec, a pilot plan, an interview kit, the checklist, a landing page, prospects and draft emails for them. Generating one costs money, about $0.60–1.50.

### Prospect
A real business that could be a customer, found for a case along with its website, location and CASL basis.

### Draft
A ready-to-edit outreach email for a prospect (a first email and two follow-ups). You review and send it yourself, outside PitchLab, then record what happened.

### Landing page
A simple page that describes the offer and asks visitors to leave their email, so you can measure interest. Its conversion rate feeds the checklist.

### Library
The research PitchLab keeps between runs: problems people describe, what products charge and how startups fared. Each entry links to its sources, and runs draw on entries whose quotes were checked against the source text.

### Research mission
A research job on a topic you choose. The worker searches public sources, adds what it finds to the library and shows the cost first. You set the budget, and a mission stops starting new steps once it is spent.

### Archived copy
A saved copy of a web page from the Internet Archive (the Wayback Machine). PitchLab uses one only when the live page refuses it or does not answer, robots.txt allows it, and the copy is no more than three years old. The entry says it came from an archived copy and shows the date of the copy.

### Social share
The share of sources in the library that come from community sites, such as Hacker News, Stack Exchange, GitHub, Product Hunt, app stores and YouTube comments, where people describe problems in their own words. A higher share means more real voices and fewer company pages.

### Pages read
How many of the pages PitchLab tried to read over the last 30 days came through with usable text, overall and by route (directly, from an archived copy, in the local browser, in the real browser or through a scraping service). The sites that fail most are listed with their main reason.

### Trend
A topic that people are searching for or posting about more, less or about the same as before, shown with the numbers behind it. Pageview and Hacker News counts are measured by PitchLab, and a figure from an article is kept only when its quote contains the number.

### Rule change
A new or proposed rule, or a platform policy change, that forces people to act, with what changed, who is affected and the dates it was published and takes effect. Rules published over three years ago, or in force for over two, are left out.

### Market
How big a group of customers is and whether it is growing, for example the people in a country or the clinics in a province, shown as size and growth clues with their year and source.

### Demand evidence
The share of generated ideas that rest on a trend, a rule change or a market entry from the library. Ideas cite one only when they depend on it, and the benchmark aims for 80 percent.

### Rating ideas
Rate ideas so PitchLab can tell whether changes make them better. Your ratings are never shown to the idea generator.

### Owner likes
The share of the ideas you rated that you liked. Rate ideas on the Runs page. Your ratings are never shown to the idea generator.

### Idea reviewer
A separate model pass that scores each generated idea from 1 to 5 for scale, edge, novelty and niche, without seeing your ratings. Run it with npm run gen -- audit review --last. It costs about 1 to 2 cents an idea.

### Niche share
The share of reviewed ideas that the idea reviewer called niche or small: a niche score of 4 or more, or a scale score of 2 or less. Lower is better, and the benchmark aims for 30 percent or less.

### Audit flags
Plain warnings under each pass when one thing dominates: one website supplying more than 15 percent of the evidence, sellers writing more than 40 percent of it, one lens making more than 35 percent of the ideas, one gate check making more than 50 percent of the kills, or a niche share above 30 percent.

### Holdout examples
Up to 10 ideas you would want, written in your own words on the Settings page. Each benchmark report shows how close the nearest generated idea is to each one. They are never shown to the idea generator or the reviewer.

### Realistic paying buyers
How many buyers would actually pay, not everyone who has the problem. It is the size of the group, times the share with the problem, the share willing to pay and the share you can reach. A share with no source is capped, so a wild guess cannot inflate it (for ads and affiliate, it counts regular users).

### Revenue ceiling
The most the idea could earn in a year: realistic paying buyers (or regular users) times the yearly price, which for ads and affiliate is our revenue per user. Generated ideas under $1M a year are stopped at the gate, but a price of 0 (a free product) leaves it unknown and passes with a note.

### Upside
Whether the idea earns money for the buyer or only saves them time, risk or money. Earning scores 5, saving time or risk 3, saving money 2. Ideas that earn rank higher.

### Owner keeps
The share of the cases you decided on the Board that you kept. A case counts as decided once it leaves New, and as kept in Validating, Pilot or Live. A case you move back from Killed counts as kept.

### Finds
Links you shared from social media or the web, by Telegram or by pasting them on the Finds page. PitchLab downloads each one, transcribes it, reads the on-screen text and adds it to your library.

### Seen in the wild
Up to 6 recent finds shown to the idea generator as proof that people want something. It may not copy a find; it has to make the idea much better, serve the people doing it, move it to a new market or solve the harder problem underneath.

### Feeds
Sources the worker reads on its own every 6 hours: Reddit, Bluesky, Hacker News, arXiv, Hugging Face, GitHub trending, newsletters and launch feeds, and YouTube Shorts. What they find goes into the library, for at most $2 a day. Settings shows each source's last run and errors.

### Sketch
A short, cheap draft of a business idea: title, buyer, problem, how it earns, its edge and why it is not trivial. A run writes about 90 of them first, then filters and ranks them, and only the best get written up as full ideas.

### Tournament
How a run ranks its sketches. A different AI family judges them head to head, twice per pair with the order swapped, on which business you would rather build. It learns from examples of cases you kept over cases you killed, but your own verdict on the Board is what counts.

### Elo
A rating that rises when a sketch wins a head-to-head match and falls when it loses, starting at 1200. The run page lists the top 12 sketches by Elo. It is a ranking inside one run, not a score out of 5.

### Diversity cell
A slot defined by buyer kind (business, prosumer or consumer), edge kind (such as data, workflow or regulation) and business model. The run keeps at most 2 ideas per cell, so the top ideas differ from each other instead of being 12 versions of one.

### Dossier
A fact sheet on one startup in the library: who pays, the pricing unit, funding, outcome and why it worked or died. Every fact comes from a page the worker fetched, with a verified quote. Dossiers are what make the comps on a case useful.

### Source strength
A 1 to 5 rating of how far to trust a library entry, worked out in code. It rises for operator or customer voices, a verified quote, other independent sites saying the same thing and official sources, and falls for vendors and old pages. The Library page shows it as a badge.

### Trivial
A gate check that kills an idea when a person with a spreadsheet, or one prompt to a frontier AI given the data, would deliver most of its value. It exists because you killed most ideas for exactly that reason. The verdict names the hard part, or says there is none.

### Pairing code
A one-time code that ties your Telegram bot to your chat: send /start and the code to the bot. Anyone else who writes to the bot is ignored, and a chat that sends 10 wrong codes is ignored from then on. Reset pairing makes a new one.

### Real browser
A visible Chromium window the worker uses only for sites that block it or show a "verify you are human" page. It keeps its cookies between visits and goes slowly, one page at a time. It never fakes its identity or solves puzzles.

### Scraping service
An optional paid service (ScrapingBee, ZenRows or Apify) that loads a page from its own network when a site still blocks PitchLab. It needs your key and is capped at 900 pages a month by default, which fits the free tiers.
