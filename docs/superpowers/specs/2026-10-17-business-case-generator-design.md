# Business Case Generator: Design

- **Status:** Builder-checked; owner's round-4 answers folded in. **Pending owner approval**
- **Date:** 2026-10-17
- **Owner:** the user (solo SWE, Toronto)
- **Living context:** `docs/CONTEXT.md` (decisions log). This document is the buildable spec.

Notation: **[Owner]** = decided by the owner. **[Claude's call]** = a default chosen during design that the owner can override.

---

## 1. Intent

The owner wants to stack cash from side businesses and eventually buy a larger business. As a solo engineer with heavy
LLM access, their edge is the ability to **research, build, and run many small software services at once**.

This system is the front of that funnel: a **hosted, always-available generator** that researches and produces
business cases for **non-generic, software-delivered B2B services**. Each case should be strong enough that the owner can
act on it the next day: pitch it, pilot it, and start collecting cash. The system then helps **validate** each case
(prospects, outreach drafts, landing pages, MVP spec, pilot plan) and **learns the owner's taste** from scores and
outcomes, so later runs get better.

### The quality bar, by example
The owner's own idea, `docs/Lead Gen Test.md` ("lead-flow verification"), is the reference case. Its strengths are the
generator's target pattern:
1. **A silent, costly failure** existing tools miss (the form "works" but the lead never arrives)
2. **A "levels" argument** showing exactly why current solutions fall short (uptime → browser automation → lead-flow verification)
3. **Buyer ≠ obvious buyer**: sell to the aggregator who feels the pain repeatedly (the agency with 20–100 client sites)
4. **One engine, many clients**: automatable delivery
5. **No regulation, fast to pilot**

### What "good" means to the owner [Owner]
- Saves the buying company **time or money**, and sells on usefulness alone
- **Not** generic or off-the-shelf
- Gives the owner **confidence to go pitch**: the value must make sense, backed by **real research, calculations, and evidence**
- **Somewhat autonomous** to run, because many will run simultaneously
- **Fast to market, consistent cashflow**

---

## 2. Goals, non-goals, anti-goals

### Goals
- G1. Generate business cases on demand (**single run**) and nonstop (**continuous mode**) [Owner]
- G2. Every number and claim in a case is **traceable**: to a cited, verified source, or to a shown calculation with stated assumptions
- G3. A harsh **kill gate** removes generic, regulated, uncontrollable, or unsellable ideas before the owner sees them
- G4. Each surviving case comes with a **validation pack**: prospect list, outreach drafts, landing page (file and/or live), MVP spec, pilot plan, interview questions [Owner: "as many validation features as possible"]
- G5. A **web dashboard** (hosted, phone-friendly) to run the generator, review cases, score them, and track each through stages [Owner]
- G6. Owner scores (8 criteria) and real-world outcomes **feed back** into generation and scoring [Owner]
- G7. Market is configurable: start with **Canada + US, English**, and design so other markets are a config addition, not a rebuild [Owner]

### Non-goals
- Sending email. The owner sends outreach themself; the system drafts and tracks [Owner]
- Running the resulting businesses. This system finds and validates them; each business gets built separately
- Multi-user or team features (single owner)
- Fully autonomous "idea → live business" with no human in the loop

### Anti-goals (would make this a failure even if it technically works)
- **Generic output**: "AI chatbot for X", "AI marketing agency", thin SaaS-for-vertical with no insight
- **Fabricated evidence**: invented stats, dead or misquoted links, LLM arithmetic presented as fact
- Ideas needing **licenses or regulatory approval**, or depending on things **outside the owner's control** that slow go-to-market (partnerships, unofficial APIs, a single platform's goodwill) [Owner]
- A pretty dashboard full of cases the owner doesn't trust
- **Runaway spend** in continuous mode

---

## 3. Constraints

| Constraint | Detail |
|---|---|
| Operator | Solo owner; no hires [Owner] |
| Location / market | Toronto, ON, Canada. Selling to Canada + US first [Owner/Claude's call] |
| Regulation | Avoid anything requiring licensing. Compliance-driven *demand* is fine if the owner needs no license [Owner] |
| LLM access | **Fuelix** gateway (employer-provided; owner confirmed OK). Details in §9.1 |
| Hosting | Vercel preferred; **Pro acceptable**; cheaper alternatives must be compared [Owner]. See §10 |
| Paid data | OK to pay, but options must be weighed [Owner]. See §11 |
| Secrets | API keys only in environment variables / platform secret store. **Never committed** |
| Email law | CASL (Canada) / CAN-SPAM (US) shape the outreach drafts and the landing page forms. See §11 |

---

## 4. System overview

```
                 ┌──────────────────────── Dashboard (Next.js, hosted, auth'd) ─────────────────────────┐
                 │  Board · Leaderboard · Command center · Case tabs · Runs · Settings                  │
                 └───────────────▲───────────────────────────────┬──────────────────────────────────────┘
                                 │ reads                          │ start/stop runs, scores, stage moves
                         ┌───────┴────────┐               ┌───────▼────────┐
                         │   Postgres     │◄──────────────│ Pipeline engine│  durable, step-based (see §10)
                         │  + pgvector    │   writes      │  (workflows)   │
                         └───────▲────────┘               └───┬───────┬────┘
                                 │                            │       │
                ┌────────────────┴──┐             ┌───────────▼─┐   ┌─▼──────────────────────┐
                │ Landing pages     │             │ Model router│   │ Research tools          │
                │ (public, per case)│             │ (Fuelix)    │   │ search · fetch · data   │
                └───────────────────┘             └─────────────┘   └─────────────────────────┘
```

Components:
1. **Pipeline engine**: runs the stages in §5 as durable, resumable steps
2. **Model router**: maps each pipeline stage to a provider + model through config (§9)
3. **Research tools**: web search, page fetch, pain-signal sources, prospect data (§11)
4. **Postgres + pgvector**: all entities plus embeddings for dedupe and taste learning (§8)
5. **Dashboard**: the owner's interface (§7)
6. **Landing page publisher**: public pages per case, with interest forms and analytics (§6.3)
7. **Learning module**: turns scores and outcomes into better generation (§6.4)

---

## 5. The pipeline

A **run** = one pass through these stages with a config: mode, seed, idea count, budgets, market.

### 5.0 Run seeds
| Seed type | What happens |
|---|---|
| **Open exploration** | Full pipeline from signal harvesting |
| **Sector focus** | Harvest/ideate within given sectors (e.g. "trades", "dental groups", "web agencies") |
| **Lens focus** | Ideate only through chosen lenses (§5.2) |
| **Specific idea** | Skip open harvesting and ideation. Take a written idea (e.g. `Lead Gen Test.md`) → **targeted evidence search** for that idea → gate → deep case → validation pack |

**Owner-seeded ideas and the gate** [Claude's call]: a specific idea first gets a targeted signal/evidence search (so it
isn't killed simply for arriving with zero signals). For owner-seeded ideas the gate is **advisory**: the full case is
still produced, with any failed checks shown prominently at the top of the Summary tab. The owner then decides whether to
move it to Killed. Generated ideas keep the hard gate.

### 5.1 Signal harvesting
Collect **pain signals**: real evidence of businesses losing time or money. Examples: complaints in forums and
communities, 1–3★ reviews of incumbent tools, job posts and freelance gigs describing repetitive manual work, platform
changes that break many businesses at once, plugin/support-forum threads.

Each signal is stored with: text/quote, source URL, date, sector, pain type, and the market it came from.
Signals go into a persistent **signal bank** that later runs reuse, so continuous mode doesn't re-scrape the same things.

### 5.2 Ideation through lenses
Ideas are generated by applying **lenses** to signals. Lenses are **data, not code**: stored in the DB and editable in Settings.
Each lens's hit rate (owner scores of the ideas it produced) is tracked.

Initial lens library [Claude's call]:
| Lens | Pattern |
|---|---|
| **Silent failure monitor** | Something "looks fine" but is quietly losing money (benchmark lens) |
| **Sell to the aggregator** | Find whoever serves *many* affected SMBs (agencies, MSPs, franchisors, bookkeepers, associations) and sell to them |
| **Manual task → productised service** | Recurring manual work (from job posts/gigs) delivered by an automated engine at a fixed price |
| **Money-leak recovery** | Recover lost money (billing errors, missed rebates, duplicate charges, unclaimed credits). Price as a % of recovered |
| **Platform-change shockwave** | A platform changes rules (email sender requirements, API deprecations, policy changes) and many businesses need a fix fast |
| **Compliance-driven demand (no license)** | Customer faces a rule; the owner needs no license to help |
| **Public data → paid decision** | Reformat public/open data into a report someone pays to make a decision |
| **Incumbent review gap** | Mine incumbents' bad reviews for a narrow, underserved job-to-be-done |

### 5.3 Dedupe and quick screen
- Embed each idea; compare against **all past ideas, including killed ones**. Near-duplicates are merged or dropped. Threshold is configurable
- A cheap model quick-scores the remainder on the 7 AI criteria (§6.4). The **taste model** adjusts ranking (§6.4)
- The top N (configurable) proceed

### 5.4 Kill gate (adversarial)
Judged by a **different model family** from the one that generated the idea, to avoid self-agreement [Claude's call].
Every check produces a verdict + reasoning + sources, stored and shown in the case.

| Check | Kill if… |
|---|---|
| **Generic / crowded** | Web search finds established competitors doing the same thing and no sharp differentiator |
| **Regulation** | Delivery requires a license, certification, or regulatory approval |
| **Out of control** | Depends on unofficial APIs, a partnership, or one platform's ToS/goodwill |
| **Autonomy** | Delivery can't be mostly automated (it's really consulting labour) |
| **Reachability** | Buyers can't be identified and contacted at scale |
| **Evidence** | Fewer than a minimum number (configurable, default 3) of independent real signals |

Killed ideas go to the **Killed** column with their reason. The owner can **overturn** a kill, which is a strong feedback signal.

### 5.5 Deep research → full case
Surviving ideas get a full case. Sections map one-to-one to the case tabs (§7.2):

- **Summary**: one-liner, buyer, problem, solution, price, why now, why it wins, recommended next action
- **Evidence**: cited signals with quotes and links; a **claims table** (claim → source → verified? → confidence)
- **Numbers**:
  - **Buyer ROI**: cost of the problem to one buyer vs the price
  - **Market sizing, bottom-up**: number of reachable buyers in the market (sourced) × price × realistic capture
  - **Unit economics**: delivery cost per client (LLM, infra, data), gross margin
  - **Revenue scenarios**: e.g. 10 / 50 / 200 clients, time to cash-flow positive
  - **Rule:** the LLM supplies *structured inputs with sources/assumptions*; **arithmetic is done by code**, and formulas are displayed. No LLM-computed numbers presented as fact
- **Competitors**: name, URL, pricing, gap; a **levels table** like the benchmark's
- **Pitch**: elevator pitch, cold email variants + follow-ups, call script, objection handling, pricing-page copy
- **Validate**: the validation pack (§6.3)
- **Score**: AI scores with rationale; owner scores

### 5.6 Evidence verification
After a case is drafted, a verification step **fetches every cited URL** and checks it exists and supports the claim/quote.
Unverified claims are flagged red in the UI and lower the Evidence score. This enforces anti-goal "no fabricated evidence".

---

## 6. Modes, validation, learning

### 6.1 Run modes and limits [Owner: keep all options]
- **Single run**: pick a seed and parameters, press Run, watch progress live
- **Continuous**: the scheduler keeps starting runs (back-to-back or every N minutes) until stopped or a limit is hit
- **Limits** (each independently on/off): unlimited · daily run cap · daily spend cap · per-run spend cap · max concurrent runs
- **Spend tracking**: every LLM call and paid data call is logged with cost. LLM cost is **notional** (Fuelix is employer-paid) but still tracked and capped for awareness and rate-limit safety; paid data APIs are real money
- **Pause/resume**, and runs survive restarts (durable steps)
- **Continuous-mode allocation** [Claude's call]: split effort between *exploit* (lenses/sectors/sources the owner scores highly) and *explore* (untested ones), with a configurable explore share (default 30%)

### 6.2 Stages (board columns) [Owner]
`New → Validating → Pilot → Live → Killed`. The owner moves cases by drag or button; each move is logged as feedback.

### 6.3 Validation pack
Generated **automatically** for cases above a configurable AI-score threshold, and **on demand** (button) for any case
[Claude's call: avoids spending paid prospect data on weak cases].

| Item | Detail |
|---|---|
| **Prospect list** | Target buyer companies in the market, with website, location, size signals, a relevant contact (role/email where available), and a reason each is a fit. Email-verified where a verifier is configured. CSV export |
| **Outreach drafts** | Per-prospect personalised cold emails + 2 follow-ups, CASL/CAN-SPAM-aware (sender ID, physical address, unsubscribe line). The owner copies/sends; the dashboard tracks **sent / replied / positive / meeting** per prospect [Claude's call] |
| **Landing page** | Generated per case. **Both** modes [Owner]: (a) downloadable files; (b) **publish to a live URL** (subdomain of an owner domain by default). Includes interest form (email, company, optional "what would you pay"), consent checkbox, privacy note. Visits + conversions tracked; submissions appear in the case as signals |
| **MVP spec** | The smallest sellable version: features, architecture sketch, build estimate, what to fake/manual at first |
| **Pilot plan** | How to run a first pilot, what to measure, success thresholds |
| **Interview kit** | Sectors and roles to contact, and the questions to ask (supports the owner "farming info" from people they reach out to) |
| **Validation checklist** | Pre-set go/no-go thresholds, e.g. "≥3 positive replies from 50 emails" or "≥5% landing conversion". Updated live from tracked outcomes |

### 6.4 Scoring and learning [Owner: multi-criteria, must evolve]
**Criteria (1–5 each + a short note):** Pain severity · Buyer ROI clarity · Evidence strength · Speed to market ·
Autonomy · Novelty/non-generic · Reachability · **Your gut** (owner-only; the AI scores the other 7).

Learning mechanisms [Claude's call on mechanisms; the owner confirmed the feedback loop]:
1. **Calibration**: track AI vs owner score gaps per criterion; include recent owner-scored cases as few-shot examples in the scoring prompt
2. **Taste profile**: a short, auto-maintained document summarising what the owner likes and dislikes (from notes, kills, overturns). Injected into ideation, screening, and gate prompts. Viewable and editable in Settings
3. **Similarity steering**: ideas near high-scored cases (by embedding) get boosted; near killed ones get penalised
4. **Lens/source/sector performance**: drives continuous-mode allocation (§6.1)
5. **Outcome signals weigh most**: outreach replies, landing conversions, and pilot results outrank opinion scores

---

## 7. Dashboard

Hosted, behind auth (single owner), responsive for phone [Owner: hosted; Claude's call: auth].

### 7.1 Views
- **Board (home)** [Owner]: columns New / Validating / Pilot / Live / Killed. Card = name, AI score, owner score (if any), one key metric (e.g. "12/50 emailed", "38 signups"). Filters by sector/lens/score
- **Leaderboard** tab: sortable table of all cases by any criterion
- **Command center** tab: generator status, today's runs/cases/kills, spend vs caps, and a **"Needs you"** list (cases to score, replies to log, pilot check-ins)
- **Runs**: start a run (seed, params), live step-by-step progress log, run history with cost
- **Settings**: model per stage, limits, lenses, markets, scoring criteria, taste profile, API connection status (never shows key values)

### 7.2 Case view [Owner: tabs]
Tabs: **Summary · Evidence · Numbers · Competitors · Pitch · Validate · Score**. Actions: move stage, score, overturn
kill, regenerate a section, generate the validation pack, publish/unpublish the landing page, export (Markdown/PDF).

Mockups approved by the owner are in `.superpowers/brainstorm/` (home-layout.html → B; case-detail.html → A).

---

## 8. Data model (sketch) [Claude's call]

`Market` · `Lens` · `Run` (config, status, cost) · `Signal` (+embedding) · `Idea` (+embedding, lens, signals) ·
`GateVerdict` (idea, check, pass/fail, reasoning, sources) · `Case` (idea, stage, sections JSON, versions) ·
`Claim` (case, text, source, verified, confidence) · `Score` (case, criterion, value, note, by: ai|owner, model/prompt version) ·
`StageEvent` · `Prospect` · `OutreachDraft` · `OutreachEvent` (sent/replied/positive/meeting) · `LandingPage` ·
`LandingEvent` (visit/submit) · `TasteProfile` (versioned) · `LlmCall` (stage, model, tokens, cost, latency) ·
`DataCall` (provider, cost) · `Setting`.

Every `Case`, `Score`, and `LlmCall` records the **prompt version and model**, so learning can tell whether improvements came from the owner's feedback or from prompt changes.

---

## 9. Models

### 9.1 Fuelix gateway (tested 2026-10-17)
- Base URL `https://api.fuelix.ai/`, bearer token (currently in the owner's global Claude settings; the app gets its own env var)
- **Anthropic Messages API** (`/v1/messages`): works, including **custom tool use** and Anthropic's **server-side `web_search` tool**
- **OpenAI-compatible** (`/v1/chat/completions`): works for non-Claude models (Gemini, GPT). Reasoning models need generous `max_tokens`
- **Embeddings** (`/v1/embeddings`): `text-embedding-3-small` (1536-d) works
- ~120 models available, including image models (imagen-4, dall-e-3) usable for landing page visuals
- **Quota** [Owner]: **no limits imposed by the owner**; they monitor costs per API themselves. Continuous-mode caps
  therefore **default to off/unlimited** but stay available in Settings. Per-call cost logging still ships, so the owner can see spend.
  The gateway's own technical rate limits are unknown, so the router must still handle 429s with backoff and respect a
  configurable concurrency limit
- The direct-provider path stays a config change (base URL + key per adapter). It is **not** a v1 test requirement

### 9.2 Model router [Claude's call]
- Two adapters (Anthropic-format, OpenAI-format) behind one interface; **base URL + key from env**, so swapping to a direct provider is config-only
- Per-stage model config, editable in Settings. Defaults:

| Stage | Default model | Why |
|---|---|---|
| Signal harvesting / extraction | claude-haiku-5-5 or gemini flash | volume, cheap |
| Ideation | claude-opus-5-5 | creativity and insight |
| Quick screen | claude-haiku-5-5 | volume |
| Kill gate | gpt-6-sol or gemini-3.1-pro | **different family** from the generator |
| Deep research / case writing | claude-opus-5-5 (with web_search) | quality |
| Evidence verification | claude-sonnet-5-5 | careful but cheaper |
| Embeddings | text-embedding-3-small | dedupe and taste |

- Structured outputs via tool-use/JSON schemas, validated (e.g. zod); invalid output → retry with the error
- Prompts live as versioned files in the repo

---

## 10. Hosting and pipeline execution

Researched 2026-10-17 (sources in `docs/research/hosting-and-data-2026-10-17.md`). Re-check prices at build time.

### 10.1 Facts that shape the choice
- **Vercel Hobby ToS:** "restricted to non-commercial personal use only". Live landing pages for real businesses are commercial, so they **cannot go on Hobby**
- Vercel Hobby cron runs **once/day max**; function max is **300s**. Pro: per-minute cron, 800s functions, $20/mo incl. $20 usage
- The pipeline is **I/O-bound** (waiting on LLMs and search) and runs for 10–60+ minutes. Per-step or per-second billing gets pricey in continuous mode; **flat-priced always-on workers are cheapest**
- Neon free tier (100 CU-h/mo) runs out if continuous mode keeps the DB awake 24/7

### 10.2 Options compared (estimated monthly cost, excl. LLM and data)
| Option | Dashboard | Pipeline | DB | Landing pages | ~Cost |
|---|---|---|---|---|---|
| **A. Lean** | Next.js on Railway | Node worker on Railway + **pg-boss** (Postgres job queue) | Railway Postgres | Cloudflare Pages (free) | **$10–15** |
| **B. All-Vercel** | Vercel Pro | Vercel Workflow (or Upstash Workflow, ~$3) | Neon | Vercel Pro (hostname routing) | **$25–50** |
| **C. Hybrid** | Vercel Pro | Node worker on Railway + pg-boss | Railway Postgres | Vercel Pro or Cloudflare Pages | **$25–35** |
| Rejected | Inngest (free tier caps at 50K executions, then $99), Trigger.dev (~$90–175 continuous), Cloudflare Workflows (runtime rewrite) | | | | |

### 10.3 Decision [Owner: Option A, 2026-10-17]
**Write host-agnostic code; deploy Option A** (Railway for dashboard + worker + Postgres; Cloudflare Pages for landing pages).
- The **pipeline is a plain Node/TypeScript worker** consuming a **Postgres-backed queue (pg-boss)**: retries, concurrency limits, scheduled/repeating jobs for continuous mode, and no step-duration limits (long Opus + web_search calls are safe). Each pipeline stage is a job; a run is resumable from its last completed stage. Runs anywhere Node runs (Railway, Fly, a VPS, Vercel Daemons)
- The **dashboard** is a standard Next.js app with no Vercel-only APIs, so moving it to Vercel Pro (Option C) is a redeploy, not a rewrite
- **Landing pages** are generated as **static sites** (this *is* the "files" mode). "Publish" deploys them to **Cloudflare Pages** via its API under `<slug>.<owner-domain>`. Forms POST to the dashboard's public API endpoint (rate-limited, with a honeypot). Visits via Cloudflare Web Analytics (free) + our own `LandingEvent` table for conversions
- **Domains:** Cloudflare Registrar (at-cost, ~$10/yr .com). The owner buys one base domain for landing subdomains; per-case custom domains are optional later
- **DB:** Postgres with **pgvector**. Builder to confirm the pgvector extension on the chosen host; Neon/Supabase both support it if Railway's doesn't
- **Spend safety:** platform hard limits where available (Railway usage limit / Vercel spend management) + app-level caps (§6.1)

---

## 11. Research and data sources

Researched 2026-10-17. Many vendor prices were taken from third-party mirrors of official pages; items marked
[unverified] were not confirmed first-party. **Re-check prices at build time.**

### 11.1 Landscape facts that shape the design
- **Reddit is effectively closed**: commercial use needs a contract; new API access requests stop 31 Oct 2026; public API ends Mar 2027. **Not used.**
- **Bing Search API is retired** (Aug 2025). **Google Custom Search** is closed to new customers and ends 1 Jan 2027. **Not used.**
- **G2, Trustpilot, Upwork, Indeed, and LinkedIn ban scraping** in their ToS. **Not used** (anti-goal: nothing outside the owner's control).
- **Fuelix `web_search` works** (§9.1). It is the **primary search tool** at no direct cost to the owner. Paid search APIs are pluggable fallbacks.

### 11.2 Search and fetch
| Need | Primary | Fallback / supplement | Notes |
|---|---|---|---|
| General web search | **Fuelix web_search** (Claude server tool) | **Brave** ($5/1k, ~1k free/mo; independent index) or **Serper** ($1/1k, Google results) | Brave ToS bans storing results long-term: store our *derived* claims + URLs, not raw result dumps |
| Semantic "find companies like X" | — | **Exa** ($7/1k; $20 + $10/mo free) | Useful for competitor discovery |
| Page fetch | **Own fetch + Playwright** | **Firecrawl** (1k free/mo; $19 → 5k pages), **Jina Reader** (free tier is non-commercial) | Most SMB sites need no paid scraping |

### 11.3 Pain-signal sources (legal, programmatic)
| Source | Access | Use |
|---|---|---|
| **Hacker News** (Algolia API) | free, no key | tech-adjacent pain, "Ask HN" complaints |
| **Stack Exchange API** | free key, 10k/day; CC BY-SA (attribute) | operational/tooling pain [ToS page unverified] |
| **GitHub issues** | free, 5k/hr | broken integrations, plugin failures |
| **WordPress.org plugin support forums** | public RSS per plugin | silent-failure signals (forms, SMTP, CRM) |
| **Apple App Store reviews** | public RSS (≤500 recent/country) | incumbent review gaps |
| **Web search via Fuelix** | — | forums, blogs, news, platform-change announcements, public complaints the search engine surfaces |
| **Owner-submitted signals** | dashboard form | things the owner hears from people they talk to (interview kit output) |

Sources are **pluggable modules** with per-source on/off and per-market config.

### 11.4 Prospect data (Canada + US)
| Source | Cost | Role |
|---|---|---|
| **Google Places API (New)** Text Search | free monthly allowance (~1k Enterprise-tier calls incl. website/phone), then ~$35/1k requests (≤20 places each) | **Primary** for local/SMB buyers (agencies, trades, clinics…) |
| **Prospect's own website** (fetch + extract) | ~$0 | **Primary** for contact emails. Also the strongest CASL basis (§11.6) |
| **Corporations Canada** open data/API | free | Canadian company validation |
| **Outscraper** | 500 free/mo; ~$3/1k + $3/1k for contacts | Bulk Maps + contact enrichment |
| **Hunter** | 50 free/mo; $49 → 2k credits; API on free plan | Email find/verify, with the source of each address recorded |
| **Apollo** | 75 free credits; $49–65/mo | Optional for role-based B2B contacts. Third-party emails are a weaker CASL basis |
| **BuiltWith / Wappalyzer** | from ~$250–295/mo | **Not in v1**. Tech-stack detection by fetching the site ourselves (e.g. WordPress, form plugins) |

### 11.5 Email verification
**MillionVerifier** (~$3.90/1k, credits never expire) as default. NeverBounce (~$5–8/1k) as an alternative.

### 11.6 CASL / CAN-SPAM requirements (not legal advice; sources: CRTC, FTC)
- CASL applies to messages sent **from Canada**, so the owner's emails to US prospects are covered too. Individual penalties reach $1M per violation
- **Implied consent by conspicuous publication** requires that the person published the address *themselves*, with no "no solicitation" notice, and that the message relates to their role. Third-party directories don't count (CompuFinder decision)
- Therefore every `Prospect` email stores **source URL, how it was found, and date captured**, and the UI shows a **CASL basis** badge: *self-published* (strong) / *third-party* (weak, warn) / *unknown* (block from outreach list by default)
- Every outreach draft includes: sender name, a mailing address valid 60 days, one other contact method, and a working unsubscribe line. The dashboard tracks unsubscribes and suppresses those prospects (must honour within 10 business days)
- CAN-SPAM (US) is opt-out. Meeting CASL meets it too
- The owner sets their sender identity and mailing address once in Settings; drafts fill them in

### 11.7 Recommended v1 data set [Claude's call]
At roughly 3k searches, 5k fetches, and 2k prospect records per month:
- **Lean (~$0–20/mo):** Fuelix web_search · own fetch/Playwright (+ Firecrawl free) · free signal sources · Google Places free tier · website-scraped emails · MillionVerifier pack · Corporations Canada
- **Upgrade when validating seriously (~$60–120/mo):** + Firecrawl Hobby $19 · Hunter Starter $49 · Outscraper (~$10) · Exa/Brave as search supplements
- **v1 starts Lean.** Every paid provider is behind a config switch with its cost per call logged (§6.1)

---

## 12. First runs and acceptance

1. **Benchmark run** [Owner]: seed = specific idea `docs/Lead Gen Test.md`. Pass if the case:
   - identifies the agency as the buyer (or argues convincingly for a better one)
   - reproduces or sharpens the levels argument
   - gives sourced buyer-ROI and market numbers with code-computed arithmetic
   - includes a validation pack with a **pilot plan using the friend's game truck business site**, plus a Toronto/Ontario-first agency prospect list

   **Pilot site inputs** [Owner]: `gamersgetaway.ca`, a WordPress site whose lead acquisition is handled mostly by
   **custom plugins the owner's friend built with Claude** (no off-the-shelf form plugin to look up). Leads destination unknown.
   **No permission yet.** Therefore:
   - The system may only **passively** inspect public pages (fetch HTML, find forms and fields, detect WordPress and visible integrations). It must **never submit forms** or send test leads to this site
   - The pilot plan's **first step is getting the friend's written OK**, plus the leads destination (inbox/CRM) needed for downstream verification
   - Worth noting in the case: custom AI-built plugins are a strong example of the silent-failure risk (no vendor maintaining them, and updates to WordPress core can break them)
   - **General rule** [Claude's call]: the pipeline never submits forms or otherwise interacts with third-party sites beyond reading public pages
2. **Open exploration run**: ≥5 cases pass the gate. The owner reviews; target ≥2 that the owner would genuinely pitch (gut ≥4)
3. **Evidence integrity**: in the benchmark and first open run, 100% of displayed sources resolve, and unverified claims are visibly flagged

## 13. Build phasing (for the plan) [Claude's call]
Aim: real cases in the owner's hands as early as possible.
1. **Core**: model router, DB, pipeline stages 5.0–5.6 runnable as a single run, cases stored → benchmark run passes
2. **Dashboard**: auth, board, case tabs, runs page with live progress, scoring
3. **Validation pack**: prospects, outreach drafts + tracking, MVP spec, pilot plan, interview kit; landing pages (files, then live publish + analytics)
4. **Continuous + learning**: scheduler, limits, spend tracking, taste profile, calibration, allocation

## 14. Left to the builder
Exact prompts, UI styling, specific libraries within the chosen stack, default thresholds (dedupe similarity, auto-validation
score threshold, explore share), and the internal structure of the workflow steps.

## 15. Risks
| Risk | Mitigation |
|---|---|
| Fuelix technical rate limits unknown (owner sets no spend limit) | Backoff, concurrency cap, per-stage model swap; provider swappable via env |
| Employer gateway dependency | Owner confirmed OK; router keeps a direct-provider path one config change away |
| Hallucinated evidence or maths | Evidence verification step (§5.6); code-computed numbers (§5.5) |
| Data-source ToS changes | Sources are pluggable; prefer official APIs; per-source on/off |
| Spend runaway | Caps (§6.1), all calls logged |
| Generic-idea drift | Kill gate, novelty criterion, taste profile, owner overturns |
