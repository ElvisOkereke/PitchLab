# Phase 2: Research Library and Collector

Status: the owner approved the picture on 2026-10-26 ("looks good"), with all four recommendations. Sections marked **Builder's call** were settled by me (Claude) and not discussed with the owner. Roadmap context: `docs/superpowers/specs/2026-10-25-idea-quality-roadmap-and-benchmark-design.md`. Phase 1 benchmark baseline-0 is saved in the live database.

## Why

Today each run does a small one-off search and keeps about 15 snippets ("signals") tied to that run. The sources are model web search plus five collectors: Hacker News, Stack Exchange, GitHub, WordPress forums and the App Store. Afterwards the snippets are mostly forgotten.

Baseline-0 shows the effect:
- only 20% of cited evidence is in the voice of people with the problem;
- 89% of gate entrants are killed as "already sold" or "needs manual work";
- there is no data at all on trends, startup outcomes or what people pay.

The owner wants "a much wider lens", "every bit of info we can get", from free sources only, even if that means building a research tool. In their words: "really build our knowledge base and the knowledge finding process".

## Goals

- **L1, library:** a persistent, growing store of research entries. Every entry is dated, sourced, tagged by country, industry and audience, and deduplicated. Every run draws from it.
- **L2, collector:** a worker-run collector that fills the library. It runs on **research missions** the owner starts on a topic, plus an **opt-in background trickle** with a daily spend cap.
- **L3, browsable:** a **Library** page to search and filter entries, see sources and coverage, start missions and reject bad entries.
- **L4, used by runs:** the harvest stage draws relevant library entries as evidence, so ideas cite them and the benchmark's real-need and demand measures can improve.
- **L5, free sources only:** official free interfaces where they exist, model web search for the rest, and each site's rules respected.

## Non-goals

- Rebuilding ideation, the gate or the business case. That is Phase 3. Phase 2 only changes where harvest gets its evidence.
- Paid data, translation, and non-English sources (decided: English-language sources from anywhere, tagged by country).
- Live dashboards of trends, and charts.

## Anti-goals

- **Spending without consent.** Missions show an estimated cost and run only when started. Background collection is **off by default**. It turns on only in Settings, under a daily cap (default $5 notional), and never exceeds it.
- **A library full of vendor marketing.** Every problem entry carries a voice tag (operator / neutral / vendor). Vendor content is kept but labelled, and retrieval prefers operator and neutral voices.
- **Duplicates and stale entries.** Near-identical entries merge into one entry with several sources. Entries show their age, and retrieval prefers recent ones.
- **Breaking site rules or storing personal data.**
  - Use official APIs where they exist, and check robots.txt before fetching pages.
  - Rate-limit each source.
  - Store short quotes (500 characters or less) plus a link, never full pages.
  - Never store usernames or profile links of the people quoted.
- **Untrusted text reaching prompts unwrapped.** All fetched text goes through the existing untrusted-text handling (`llm/untrusted.ts`) and the SSRF-guarded fetcher (`tools/fetch-page.ts`).

## What's in the library

### Entry kinds

Phase 2 is built in two slices. Slice A comes first.

| Kind | Slice | What it captures | Key facts (validated per kind) |
|---|---|---|---|
| `problem` | A | Someone describing a pain in their own words | who has it (persona), the quote, voice, how often or how costly if stated, workaround used |
| `startup` | A | A product or company and how it fared | what it does, business model, audience, outcome (active / dead / acquired / public / unknown), why (if known), founded and ended years, funding if public |
| `pricing` | A | Something people already pay for | product, price points and units, who buys, top complaints from reviews |
| `trend` | B | Something growing or shrinking | topic, direction, evidence (search interest, launches, adoption figures), time window |
| `rule_change` | B | A law, policy or platform change forcing action | what changed, who is affected, effective date, jurisdiction or platform |
| `market` | B | A segment or country with size clues | segment, geography, size clues from public data, growth clues |

### Common fields (every entry)

- `kind`, `title`, `summary` (2–3 sentences in the collector's words)
- `quote` (optional, 500 characters or less, verbatim from the source)
- `audience`: business / consumer / both
- `countries[]` (ISO codes, or `global`), `industries[]` (free text, normalised lowercase)
- `voice` (for problems and pricing complaints)
- `sources[]`: each has url, domain, source type, published date, fetched date, and whether the quote was verified on the page
- `facts` (per-kind JSON, validated by a zod schema per kind)
- `embedding`, `contentHash`
- `status`: active / rejected
- `missionId`, `createdAt`, `updatedAt`

**Builder's call:** one `knowledge_items` table with a `kind` enum and per-kind `facts` JSON validated in code, rather than six tables. A `research_missions` table holds missions.

### Deduplication

- **Exact repeats:** content hash.
- **Near repeats:** an entry of the same kind with cosine similarity ≥ 0.90 is merged. The new source is added to the existing entry's `sources[]` and `updatedAt` is bumped.
- **Builder's call:** the 0.90 threshold, tunable through a constant.

## Where entries come from

| Source | How | Kinds it feeds | Notes |
|---|---|---|---|
| Model web search | existing research calls | all | the general net; prefer owner communities and neutral bodies, as `harvest-research.v5` does |
| Reddit | official API, script-app OAuth, free | problem, pricing complaints | needs `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET` (the owner creates a free app). Skipped if not set. |
| Hacker News (Algolia) | existing | problem, startup | |
| Stack Exchange | existing (`STACKEXCHANGE_KEY`) | problem | |
| GitHub issues | existing (`GITHUB_TOKEN`) | problem | |
| App Store reviews | Apple's public customer-review RSS (JSON) | pricing complaints, problem | no key |
| Product Hunt | official GraphQL API, free developer token | startup, pricing | needs `PRODUCTHUNT_TOKEN`. Skipped if not set. |
| Y Combinator directory | public open dataset (yc-oss JSON on GitHub) | startup (status: active / inactive / acquired / public) | no key |
| Failure post-mortems | web search plus fetch of the found pages | startup (why it died) | fetch respects robots.txt |
| Government and open data | official APIs (e.g. Statistics Canada, US Census, World Bank) | market (Slice B) | no key |
| Trend evidence | web search for reports and launch data | trend (Slice B) | Google Trends has no official free API, so it is out unless a free official route appears |

**Builder's call:** each source sits behind the existing `SignalSource`-style interface, with per-source rate limits and a shared robots.txt check added to page fetches made by the collector.

## Research missions

**A mission is** a topic plus optional kinds, countries, audience and budget. For example: "AI tools for tradespeople", kinds problem + pricing, countries CA/US, audience business, budget $2.

**Steps** (each idempotent, R20):
1. **Plan:** one model call turns the topic into source-specific queries.
2. **Collect** from the chosen sources.
3. **Extract** entries. This is a structured model call over wrapped untrusted text, with kind-specific schemas.
4. **Verify** that quotes are on their pages, reusing `pipeline/verify.ts` logic.
5. **Embed.**
6. **Dedupe or merge.**
7. **Store.**

**Budget:** the mission stops adding work once its recorded model and data spend reaches the budget, and finishes with status `done (budget reached)`. The estimate is shown before starting. **Builder's call:** default budget $2, allowed range $0.50–10.

**Queue:** missions use the same pattern as validation jobs. They are queued from the Library page or `gen research <topic>`, and claimed by the worker after runs and validation jobs (`FOR UPDATE SKIP LOCKED`). Each mission records items added, items merged, cost and errors.

**Background trickle** (opt-in):
- Off by default. Settings has "Background research" on/off and a daily cap (default $5).
- When on, the worker queues small background missions ($1 each) while today's background spend (America/Toronto day) is under the cap. One runs at a time.
- Topics rotate through a seeded list of broad topics, about 40, spanning business and consumer, many industries and several regions. When an industry or country is thin in the library, it also picks "gap" topics. **Builder's call:** the seeded topic list and the gap rule.

## How runs use the library (Slice A)

- **New harvest source `library`:** for a run's seed (sectors, lenses, idea text, or open), it retrieves the most relevant active entries by embedding similarity. It prefers:
  - kinds `problem` and `pricing`;
  - operator and neutral voice;
  - entries from the last 24 months;
  - variety across sources.
- These entries become the run's signals in the existing signal format, with voice carried over and a new `signals.knowledge_item_id` link. Ideate then cites them as it cites signals today.
- Existing per-run harvest sources keep working, so the library adds to them. **Builder's call:** the library supplies up to half of a run's signals once it holds at least 50 relevant active entries; before that it supplies what it has.
- Phase 3 will go further, giving ideation startup outcomes, pricing and trends directly.

## Library page (dashboard)

- **Search** by text and meaning, plus filters for kind, audience, country, industry, voice, source and age.
- **Entry rows:** kind badge, title, summary, voice, countries, age and source count. An entry opens to show the quote, every source link (opened safely) and the facts.
- **Reject** an entry (with an optional reason). Rejected entries are excluded from retrieval. **Restore** undoes it.
- **Coverage panel:**
  - counts by kind, source and voice;
  - the share of problem entries in operator or neutral voice;
  - the countries and industries covered;
  - the newest and oldest entry dates.
- **Missions panel:**
  - a "Start research mission" form with topic, kinds, countries, audience and budget, plus the estimated cost;
  - the mission list with status, items added and merged, and cost;
  - the background status: on or off, spent today against the cap.
- All text is escaped (R13), and the page works at 375px.
- **Builder's call:** a short help tip and a tour step for the Library page, following the existing tour and glossary rules.

## Measures (feed the benchmark)

- **Library health** (on the page, not in the scorecard):
  - entries by kind;
  - share of problem entries in operator or neutral voice (target ≥ 60%);
  - countries covered (target ≥ 10 within the first month of background collection);
  - share of entries with a verified quote.
- **Benchmark:** after Slice A, a bench-v1 pass should move **real-need evidence** from 20% toward ≥ 50%. **Demand evidence** (metric 7) becomes measurable in Slice B, once trend entries exist and ideas can cite them. Before declaring Slice A done, the owner runs a benchmark pass.

## Constraints

- **All existing rulings bind:**
  - R13 escaping;
  - R20 idempotence;
  - Server Actions use `requireOwnerAction` + zod;
  - web-safe core imports;
  - bounded queries;
  - bound parameters only;
  - SSRF guard and untrusted-text wrapping;
  - banned-source domains enforced.
- **No live model calls or network in tests.** Sources and the model router are mocked, as in existing tests.
- **Merge gates as before.** New optional env vars (`REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `PRODUCTHUNT_TOKEN`) are documented in `.env.example`, and the Settings Connections panel shows them as connected or not set.
- **Notional spend** is logged per mission in `llm_calls` and `data_calls`. **Builder's call:** add a nullable `mission_id` column so mission spend is attributed exactly, rather than by time window.

## Decisions settled after the design review (Builder's calls)

### Library entries as run signals

Harvest already shares signal rows across runs:
- it upserts on `(url, quote_hash)`;
- it keeps the existing row;
- it passes ids forward through the stage output (`pipeline/harvest.ts`);
- `ideate` reads signals by id.

The library source follows the same pattern, so no unique index changes:
- For each selected entry it upserts one signal per entry source. The row has the run's `market_id`, the entry's verified quote, voice and source type, and the new nullable `signals.knowledge_item_id`.
- It returns those signal ids alongside the run's other signals.

### Which entries count as evidence

Only `problem` and `pricing` entries with a **quote verified on its page** become signals. That is what keeps the benchmark's real-need number honest.

Other entries can be browsed in the library but do not become signals in Slice A, either because they have no quote or because their quote is unverified. Phase 3 feeds startups and pricing facts to ideation directly.

Harvest trusts the stored verification flag. Re-verification happens when a mission merges a new source.

### Cost estimate and budget

The form shows **"up to $X"**, where X is the mission's budget, plus a typical-cost line taken from the average of the last 10 missions once any exist.

Budgets are soft:
- spend is checked between steps and between source batches;
- one in-flight batch may overshoot, recorded honestly;
- "notional" means computed from the existing price table (`config/prices.ts`).

The daily background cap works the same way, summing mission spend for background missions on the Toronto day.

### Merges

- On a near-repeat merge, the existing entry keeps its title, summary, quote and facts, and gains the new source.
- The entry's voice becomes the most independent voice among its sources (operator > neutral > vendor).
- A merge into a rejected entry keeps it rejected, so rejected content can't be resurrected by a later mission.

### Sources table

Sources are a child table (`knowledge_sources`: item id, url, domain, source type, published, fetched, quote verified, quote). This keeps filters and coverage counts as bounded, indexed queries.

### Structured sources

YC directory and Product Hunt records map straight to `startup` and `pricing` facts in code, with no model call. Their free text is still capped and treated as untrusted wherever it reaches a prompt later.

### Optional keys

Reddit and Product Hunt are built and tested behind their keys, and skipped cleanly without them. The Slice A done check runs with whatever keys the owner has set. The Library page's coverage panel shows the operator-voice share so the effect of adding Reddit is visible.

## Left to the builder

- Per-kind fact schemas and prompts, query planning, the retrieval ranking formula, rate-limit numbers, page layout, and table and column names, all within the above.
- The order of sources inside a mission, and how a mission splits its budget across steps.

## Done when (Slice A)

- A mission runs end to end on mocked sources and model calls. It plans, collects, extracts, verifies, embeds, dedupes or merges and stores, respecting its budget. Tests cover each step plus robots.txt refusal, quote-length caps and username stripping.
- Background collection is off by default, respects its cap and the Toronto day, and queues at most one mission at a time.
- Harvest's `library` source supplies signals linked to entries, and ideate cites them.
- The Library page searches, filters, shows coverage, rejects and restores entries, and starts missions with the cost shown.
- The owner runs a few missions and a benchmark pass, and real-need evidence is compared with baseline-0.

Slice B (trend, rule_change and market entries, government data, and metric 7) follows as its own plan on this design.
