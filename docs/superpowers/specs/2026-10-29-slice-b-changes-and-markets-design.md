# Slice B: What's Changing and Where the Market Is

Status: the owner said on 2026-10-28 "continue and keep continuing with your recommendation, only stop development if you need my input". Every decision below is a **Builder's call** (Claude). Builds on the research library design (`2026-10-26-research-library-design.md`, which reserved the `trend`, `rule_change` and `market` kinds for this slice) and Tuning 5.

## Why

bench-v2 #4 (2026-10-29) met most idea targets: 49 ideas, 9.2 buyers and 4.8 business models per run, 13% wasted gate entrants, and 3 of 6 cases easy to start and hard to copy. Three things still fall short:
- **Repetition 0.63** (target below 0.55): ideas resemble past ones, because ideation sees the same kinds of input each time (problems, startups, prices).
- **Demand evidence: not measured** (metric 7, target 80%). No idea can show that demand is rising, that a rule forces people to act, or how big the market is.
- **Customer return median 2.93×** (target at least 3×): value claims rest on problem cost alone, with no market or change context.

The library has no data on what is changing. The owner asked for exactly that at the start: "new problems people have today and in the future", "emerging markets, new startup trends".

## Goals (measured by bench-v2 #5 after a library fill)

- Demand evidence measured: at least 50% of generated ideas cite a trend, rule-change or market entry, heading for the 80% target.
- Repetition below 0.60, heading for 0.55.
- No regressions against bench-v2 #4:
  - ideas at least 8 per run;
  - real-need evidence at least 50%;
  - wasted gate entrants below 30%.
- The library holds at least 40 trend, 30 rule-change and 20 market entries after the fill.

## Non-goals

- Google Trends (no official free API), paid data, X, TikTok, Instagram.
- Charts or a trends dashboard. Entries show in the Library like the other kinds.
- Changing the gate or the screen.

## Anti-goals

- **Invented trends.** A trend entry needs measured evidence (numbers from an API or a verified quote), never the model's impression.
- **Stale rules.** A rule change older than 3 years, or one whose effective date has passed by more than 2 years, is not "what's changing".
- **Citing for the metric.** Ideas cite a change or market only when it is relevant. The prompt says so, and nothing in code rewards a citation beyond the metric.

## Design

### 1. Kinds and facts (`library/kinds.ts`)

Facts schemas for the three reserved kinds:

- **`trend`:** `{ topic, direction: 'rising' | 'falling' | 'steady', evidence: [{ metric, value, period }] (1–6), window, basis: 'measured' | 'reported' }`.
  - `measured` comes from an API series in code.
  - `reported` comes from a verified quote in a source (a report or article).
- **`rule_change`:**
  - `{ title, change, whoIsAffected, jurisdiction, status: 'final' | 'proposed' | 'announced', effectiveDate (ISO date or null), publishedDate (ISO date or null) }`.
  - `jurisdiction` is free text such as `US-federal`, `CA-federal`, `CA-ON`, `EU` or `platform: Apple`.
- **`market`:** `{ segment, geography, sizeClues: [{ metric, value, unit, year }] (1–8), growthClues: [{ metric, change, period }] (0–6) }`.

`SLICE_A_KINDS` stays. Mission kinds accept all six. Web forms and filters list the new kinds with plain labels:
- Trend: "What's growing or shrinking"
- Rule change: "A rule or platform change"
- Market: "Market size clues"

### 2. Free sources (`research/sources/`)

All use the existing guarded HTTP helpers and the PitchLab user agent, need no key, and are mocked in tests.

**`federalregister.ts`**, rule changes in the US:
- Calls `https://www.federalregister.gov/api/v1/documents.json`, with conditions `term` (the planner's query), `type[]` RULE and PRORULE, and `publication_date[gte]` within the last 24 months. Up to 10 results, newest first.
- Each document becomes a text item: the title plus the abstract, with url `html_url`. Hints for `effectiveDate` (`effective_on`), `publishedDate` and `status` (final for RULE, proposed for PRORULE) pass through to the draft.
- Extraction turns the item into a `rule_change` entry with a quote verified in the abstract.
- Federal Register material is public; we never use NARA or OFR logos.

**Canada (Gazette and provinces):** the Gazette RSS only signals whole issues, so a dedicated collector would scrape issue pages. Instead the planner may write web queries aimed at `gazette.gc.ca` and provincial registries, collected with `collectPage` like any web page. `rule_change` lists `web` among its sources.

**`wikipageviews.ts`**, measured trends:
- The planner gives a topic. The collector resolves it to an English Wikipedia article with the OpenSearch API (`https://en.wikipedia.org/w/api.php?action=opensearch&limit=1`).
- It then reads monthly `user`-agent pageviews for the last 36 full months: `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia.org/all-access/user/<Article>/monthly/<start>/<end>`.
- Direction compares the last 12 months with the 12 before: at least +20% is `rising`, at most −20% is `falling`, anything else is `steady`.
- It emits a structured `trend` draft with basis `measured`, metric `Wikipedia monthly views (people, not bots)`, url the article, and no quote. Like YC entries, it goes through no extraction and no model cost.
- An article with fewer than 1,000 views in the window is skipped as too thin.
- Pageview data is public (CC0). The user agent names PitchLab, as the Wikimedia policy asks. A 429 stops this source for the mission with a warning.

**`hn` trend counts**, a second measured trend:
- For a trend query, the existing HN Algolia client counts stories per year for the last 4 calendar years (`search_by_date` with `numericFilters=created_at_i` ranges, `hitsPerPage=0`, reading `nbHits`).
- Direction uses the last full year against the one before, with the same thresholds. A series with fewer than 20 stories in total is skipped.
- It emits a structured `trend` draft with metric `Hacker News stories per year` and url the HN search page.

**`worldbank.ts`**, country market clues:
- For each mission country (not `global`), the collector reads a fixed indicator set from `https://api.worldbank.org/v2/country/<ISO2>/indicator/<code>?format=json&mrv=6`:
  - population `SP.POP.TOTL`;
  - GDP per capita `NY.GDP.PCAP.CD`;
  - internet users % `IT.NET.USER.ZS`;
  - mobile subscriptions per 100 `IT.CEL.SETS.P2`;
  - new business density `IC.BUS.NDNS.ZS`;
  - urban population % `SP.URB.TOTL.IN.ZS`.
- It emits one structured `market` draft per country: segment "everyone in <country>", the latest value per indicator as size clues, and the change over the returned years as growth clues. It runs once per mission.
- The data is CC BY 4.0. The source URL is stored as attribution.
- Market entries for specific segments, such as "dental clinics in Ontario", come from web queries through extraction, with verified quotes.

### 3. Mission integration

- **Which sources feed which kind:**
  - trend: `wikipageviews`, `hn`, `web`;
  - rule_change: `federalregister`, `web`;
  - market: `worldbank`, `web`.
- **Planner (`library-plan.v4`):** new hints per source. Rule changes ask "what changed, who must act, by when". Trends need measured growth, never opinion pieces. For markets, use statistics offices and associations.
- **Extraction (`extract-signals.v5`):** gains the three kinds, with their facts and quote rules. A `reported` trend needs a verified quote containing the number.
- **Free sources run first**, as now. All new collectors are free sources.
- **Missions:** the CLI `--kinds` and the web mission form accept the new kinds, and the defaults stay as they are. Background research rotates the new kinds into its topics.
- **Freshness:** rule changes outside the stale window (anti-goals) are dropped in code before storage, with a count in the mission warnings.

### 4. Ideation (`ideate.v10`) and the metric

- **Library context:** `ideationContext` gains two sections. Each uses the same embedding (lens pattern plus seed), the same country rule and only live entries.
  - **`changing`:** up to 10 entries, trends with a known direction and rule changes, rule changes first when the effective date is within 18 months of today.
  - **`markets`:** up to 6 entries.
- **Rendering:** each line shows the id, the gist, the key number or date, and the url. The sections render "none found" when empty and are wrapped as untrusted.
- **`ideate.v10`:** v9 plus a "what's changing" block and a "market size" block.
  - Prefer ideas that ride a rising trend or a rule change that forces action. Cite their ids in `libraryItemIds` when, and only when, the idea depends on them.
  - When citing a market entry, use its numbers to ground `valueToUser` or reach.
  - v9 is kept.
- **Metric 7, demand evidence (`bench/scorecard.ts`):**
  - The share of generated ideas whose `libraryItemIds` include at least one `trend`, `rule_change` or `market` entry, over ideas with `libraryItemIds` set (v8 and later).
  - Meets at ≥ 0.8. `no_data` when nothing is set.
  - Remove the phase marker.

### 5. Docs

README sources table, user guide (missions with the new kinds), architecture (sources, kinds, ideation blocks, metric 7), glossary (trend, rule change, market, demand evidence) in both copies, CONTEXT, OWNER-TODO (nothing new to sign up for; score the bench-v2 #5 cases).

## Constraints

All existing rulings bind:
- the SSRF guard and the user agent;
- robots.txt for web pages (APIs are fixed hosts through `request()`);
- untrusted text wrapped;
- the privacy scrub;
- verified-quote rules for text items;
- soft budgets and bounded queries;
- R13 and R20;
- web-safe imports and check-bundle;
- no live network or model calls in tests;
- merge gates and a secret scan.

New prompts are new versioned files. Migration: none expected, since `knowledge_items.kind` already allows the six kinds. If the facts or a filter need a column, it is additive only.

## Done when

- Tests cover:
  - each facts schema;
  - each collector (mocked HTTP: success, empty, too thin, 429, malformed);
  - the direction thresholds;
  - the stale-rule filter;
  - the planner offering only available sources;
  - the new ideation sections, including "none found";
  - the v10 prompt variables;
  - metric 7 on fixtures, including `no_data`.
- A library fill is run and reported: 3 missions at $5 with kinds trend, rule_change and market, on the bench topics' sectors and the consumer topic, with entry counts per kind.
- bench-v2 #5 is reported against #4.
