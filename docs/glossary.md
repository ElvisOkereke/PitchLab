# PitchLab glossary

Plain-language meanings for the terms you will see in PitchLab. The first group matches the "?" tips in the app; the second group covers the steps a run goes through and the validation tools.

## Terms with a "?" tip in the app

### Seed
The starting point for a run. Open looks across every sector, Sectors and Lenses narrow it to the ones you tick, and Your idea builds a case for an idea you describe.

### Lenses
A lens is a pattern for spotting a business idea, such as a silent failure to monitor or a task to turn into a fixed-price service. Tick lenses to make the run look only through those patterns.

### Sectors
The kinds of small business the run can research, such as HVAC, dental clinics or managed IT providers. Tick some to keep the run to those sectors.

### Ideas to generate
How many raw ideas the run writes down before it filters them. More ideas give the filters more to choose from.

### Ideas to turn into cases
How many of the surviving ideas get a full business case with sources and numbers. Each case is the expensive part of a run, so keep this small.

### Gate flags
The gate runs checks on each idea (not generic, regulation, control, autonomy, reachability, evidence), and a flag means one failed. For an idea you wrote yourself it only advises, so you still get the case and decide whether to keep or kill it. For other seeds, an idea that fails can be killed at the gate before it gets a case.

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
A fixed set of 5 runs you repeat after each change, so you can compare idea quality before and after. The scorecard measures how varied and well-evidenced the ideas are, and your own gut scores on its cases count too. Press Run benchmark on the Progress page, or use `npm run gen -- bench run`. The current set is bench-v2: the four bench-v1 runs plus a run through two consumer lenses (earn on the side, save on a car). Older passes keep their own scores and are not changed.

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
