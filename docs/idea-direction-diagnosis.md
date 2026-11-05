# Why the ideas come out small, niche and edgeless

A diagnosis of the whole idea flow, written on 2026-11-04 after the owner said the ideas "don't seem scalable, are too niche, don't have any perceived intelligence edge", and that there is too much WordPress. Nothing has been changed yet. Data comes from the last three benchmark passes (bench-v2 #4, #5 and #6 in progress): 110 generated ideas and 161 signals.

## Short answer

The architecture is sound. The direction comes from what each stage is told to look for, and every stage pushes the same way:

> Find a documented complaint → turn it into a small fix one person can ship fast → keep it only if nobody sells it yet → rank it on how fast it pilots.

That combination produces exactly what you are seeing: narrow tools that patch one leak for one buyer type, in places big companies ignore. It is not one bad prompt. Seven settings stack up.

## How an idea is made, stage by stage

### 1. Seed (where a run starts)

- Benchmark seeds are fixed:
  - "open";
  - two sector seeds: dental clinics + restaurants, and property management + Shopify brands;
  - lens seed `platform-shockwave` + `public-data-decision`;
  - lens seed `consumer-earn-side` + `consumer-save-auto`.
- **What it pushes toward:** four of five runs start inside small-business verticals that are classic "niche SaaS" territory. Every benchmark pass measures improvement only inside these five boxes.

### 2. Lenses (the idea patterns)

All 14 lenses are fix-it patterns. None asks for something big or new.

**Business lenses:**
- `silent-failure`: something looks fine but quietly loses money.
- `money-leak`: recover lost money; price as a % of what's recovered.
- `compliance-demand`: a rule the customer must follow.
- `platform-shockwave`: a platform changed its rules and businesses need a quick fix.
- `review-gap`: mine incumbents' bad reviews for a narrow, underserved job.
- `public-data-decision`: reformat public data into a report.
- `aggregator`: sell to whoever serves many small businesses.
- `manual-to-productised`: automate a recurring manual task.

**Consumer lenses:**
- `consumer-save-auto`: cut a bill.
- `consumer-earn-side`: side income.
- `consumer-life-stage`: paperwork around a life event.
- `consumer-ai-chore`: a dull task done for a fee.
- `consumer-creator-solo`: tools for a business of one.
- `consumer-leapfrog`: copy a proven product into a new market.

**What's missing:** no lens for:
- an AI-native product that replaces expensive human work across a large market;
- a 10× better or cheaper version of something people already buy in volume;
- a new capability that wasn't possible two years ago;
- a network or marketplace;
- a data flywheel;
- platform infrastructure.

`review-gap` literally says "narrow, underserved".

**What it pushes toward:** small corrective tools. In the 110 ideas, `platform-shockwave` and `consumer-save-auto` alone produced about 40.

### 3. Harvest (the evidence for a run)

The research prompt (`harvest-research.v6`) asks, in its first line, for evidence that people "lose time or money to a recurring problem".

**What it pushes toward:** complaints, so every idea starts as a patch for a complaint. Nothing looks for what is growing, where money is moving, what people already pay a lot for, or what new technology makes possible.

**What the evidence actually is** (the last 3 passes):
- **Voice:** 92 of 161 signals are vendor voice (marketing pages and vendor blogs). 38 are operators, 29 are neutral.
- **Domains:** the top ones are wordpress.org (17), github.com (11) and community.shopify.com (7). The rest are vendor sites such as laneproof.com, invoicifyai.com, fieldnudge.com, leasebase.ai and baselane.com.
- **Why WordPress shows up:** whenever a seed includes "ecommerce brands (Shopify)", harvest also queries WordPress plugin support forums. The fixed slugs are contact-form-7, wp-mail-smtp, woocommerce and bookly, plus GitHub issues. That is where 28 of the 161 signals and 9 of the 110 ideas come from. It is a hard-wired source choice, not something the market asked for.

### 4. Research library (context shown to ideation)

- **Contents:** 796 problem entries, 170 pricing, 140 startups, 72 trends, 131 rule changes, 22 markets.
- **Where the problems come from:** app-store reviews, YouTube comments, HN and web pages, all complaint-shaped.
- **How the library is used:**
  - "Already sold" startups are shown so ideation avoids them.
  - Markets and trends were added last week. Ideas cite them 32% of the time.

**What it pushes toward:** away from anything an existing startup already does, toward unserved corners. Market size data is too thin to pull ideas toward big markets.

### 5. Ideation (`ideate.v11`)

The first line frames the owner as wanting "a small, highly automated business he can pilot fast".

Hard requirements:
- Every idea must cite at least 3 operator or neutral signals from 3 different websites.
- `soloBuildable` is asked for.
- Software does most of the work, with at most about 2 hours per customer per month.
- No licence; nothing that depends on a platform we don't control.

**What it pushes toward:**
- "Small" and "pilot fast" are literal instructions.
- The 3-quote rule means only well-documented, specific pains qualify. A genuinely new idea rarely has three people already complaining about its absence online.
- The model is never asked for an edge: no question about what is smarter, faster, cheaper or newer than today's options.

### 6. Screen (ranking)

The criteria are:
- pain;
- buyer ROI clarity;
- evidence strength;
- speed to market;
- autonomy;
- novelty against history;
- reachability;
- money case;
- barrier to entry.

**What it pushes toward:** "speed to market" and "evidence strength" reward small, documented fixes.

**What's missing:** nothing scores:
- market size or scale (reach means "can we contact them", not "how many are there");
- technical or intelligence edge;
- growth potential.

The barrier score's moat keywords (data, network, integration, licence, distribution) never mention AI capability or proprietary insight.

### 7. Gate (pass or kill)

`generic` kills an idea when established competitors already do the same thing, unless it has a real functional gap. "Positioning, packaging or channel" differences don't count. `control` (now option B) and `regulation` kill platform-dependent and licensed ideas.

**What it pushes toward:** this is the strongest niche force. Doing something that already sells, but much better ("optimise what already works", in your words), is killed by design. A product only survives if it does something nobody sells, which in practice means a sub-sub-segment nobody bothered with.

### 8. Case and scoring

- **The money model:** the value multiple is value to the buyer divided by price. Most value claims are "money recovered or saved per buyer".
- **What's missing:** no score for total market or scale.

**What it pushes toward:** leak-recovery economics, small and per-buyer.

## Root causes, most important first

1. **Pain-first framing everywhere.** Harvest looks only for loss, lenses are fix-it patterns, and ideation must cite complaints. Ideas become patches.
2. **The gate's `generic` rule plus the "already sold" list.** Anything with incumbents dies unless it fills a functional hole. Better-than-incumbent ideas have no path, so ideas retreat into niches.
3. **No edge is ever asked for or scored.** Nothing asks what makes the idea smarter, faster or cheaper than what exists, or what it can do that wasn't possible before. The moat check ignores AI capability and proprietary insight.
4. **"Small, solo, pilot fast" as hard framing.** The ideation identity line, `soloBuildable`, the 2-hour autonomy guide and "speed to market" in the screen together select for small tools.
5. **No scale signal.** Screen and case ignore market size. Market data is thin (22 entries) and cited by a third of ideas.
6. **Narrow evidence sources, and vendor-heavy.**
   - 57% of run signals are vendor pages.
   - The WordPress and GitHub collectors are hard-wired for Shopify seeds.
   - Operator voices come from a few forums.
7. **Narrow benchmark seeds.** Improvements are tuned and measured inside dental, restaurants, property management and Shopify, so the system gets good at niche SMB tools in exactly those boxes.

## What is not the cause

- **The pipeline structure:** harvest → ideate → screen → gate → case → verify → score.
- **The models.**
- **The evidence quality machinery:** verified quotes and voice tags work. They are just pointed at the wrong question.

## What a fix would touch (for discussion, not decided)

| Lever | Change | Effect |
|---|---|---|
| Seeds | Replace the benchmark's four SMB boxes with a wider rotating set (consumer, prosumer, mid-market, developer, health, finance, education, logistics, media), and let open seeds draw from trends and markets rather than from the evidence's sectors. | Breadth |
| Lenses | Add ambition lenses and demote or drop the narrowest fix-it lenses:<br>- AI replaces expensive human work;<br>- 10× better or cheaper than the incumbent people already pay for;<br>- new capability enabled by recent tech;<br>- marketplace or network;<br>- data flywheel;<br>- picks and shovels for a growing trend. | Bigger, newer ideas |
| Harvest | Research opportunities, not only pain:<br>- spend and adoption data;<br>- fast-growing categories;<br>- job posts showing what companies pay people to do by hand;<br>- what's working at startups.<br><br>Make the WordPress and GitHub collectors opt-in. | Evidence that points at markets, not leaks |
| Ideation | Ask every idea for its edge (what is smarter, faster or cheaper, and why now) and its scale (who and how many), alongside the money case. Soften "small, pilot fast". | Ideas carry an edge and a size |
| Evidence rule | Accept demand evidence (trend, market size, spend, job posts) as well as complaint quotes, for example 1 complaint + 1 demand source, not 3 complaints. | New ideas can qualify |
| Gate `generic` | Allow ideas that compete with incumbents when they state a concrete, checkable edge (much cheaper, much faster, does it automatically, serves a segment the incumbent can't price for). Keep killing "same thing, different label". | "Optimise what works" becomes possible |
| Screen | Add `scale` (market size) and `edge` (intelligence or technical advantage) criteria, and reduce the weight of `speed`. Add AI capability and proprietary insight to the moat check. | Ranking rewards scalable, smart ideas |

Each lever has a cost or risk. More competition-friendly ideas mean more gate judgement calls. Bigger ideas are harder for one person to build. Weaker complaint evidence risks ideas nobody needs. The owner decides the balance.
