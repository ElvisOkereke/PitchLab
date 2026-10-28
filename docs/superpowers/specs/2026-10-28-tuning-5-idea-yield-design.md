# Tuning 5: Idea Yield, Hard-to-Copy Ideas and Startup Coverage

Status: the owner said on 2026-10-28 "continue and keep continuing with your recommendation, only stop development if you need my input". Every decision below is a **Builder's call** (Claude), made from bench-v2 passes #1 and #2 and the research reach missions.

## Why

bench-v2 #2 (2026-10-28, $30.20, 5 runs) was the best pass yet on what happens after ideation:
- 5 cases;
- wasted gate entrants 25%, meeting its target for the first time;
- customer return median 4.0×.

But ideation is now the bottleneck:

| | bench-v2 #1 | bench-v2 #2 | Target |
|---|---|---|---|
| Ideas kept per run (12 asked) | 3.8 | 2.6 | 12 |
| Ideas dropped as invalid per run | 2.4 | 5.0 | about 0 |
| Consumer lens seed (2 consumer lenses) | 0 ideas, 6 dropped | 0 ideas, 5 dropped | at least 8 ideas |
| Easy to start, hard to copy (cases) | 0 of 4 | 1 of 5 | at least 50% |
| Ideas with toCopy ≥ 4 | 0 of 19 | (few) | some in every run |
| Business-model variety | 3.5 | 2.3 | at least 4 |
| Buyer variety | 4.5 | 3.3 | at least 8 |

Low variety follows from the low yield: a run with 2 ideas can't have 4 business models.

What the evidence shows:
1. **The answers are too long.** Each v8 idea costs about 1,500–2,000 output tokens. Lens seeds ask for 6 ideas per call (12 ideas ÷ 2 lenses). 7 of the 79 ideate calls in the two passes hit the 8,000-token output cap. Those calls lose every idea that was cut off, and the consumer lens seed (6 per call) never kept a single idea.
2. **Some fields are never trimmed.** `functionalGap` (600 characters) and each `knownIncumbents` entry (120 characters, at most 8) are validated strictly, with no trimming. Numbers given as strings ("1,200") and barrier scores like 2.5 also fail. The raw model output isn't stored, so the exact reasons can't be read today; the stage only stores a drop count.
3. **toCopy defaults to 3.** The prompt defines toStart and toCopy only as "1–5", with no scale. The model hedges at the middle.
4. **Startup entries dropped once YouTube joined missions.** On the property-manager / Shopify topic, startup entries went from 20 to 8 and YC sources from 19 to 3. The planner now spends its queries on YouTube, and extracting from YouTube comments uses up budget sooner. Startup entries feed the "already sold" list, which keeps ideation away from products that already exist.

## Goals (measured by a bench-v2 pass, #3)

- Ideas kept per run at least 9 on average, and every seed, including the consumer lens seed, at least 6.
- Invalid ideas dropped at most 1 per run on average, with the reasons visible.
- At least one idea with toCopy ≥ 4 per run, and cases that are easy to start and hard to copy at 30% or more, heading to the 50% target.
- Business-model variety at least 3.5 per run, buyer variety at least 6 per run.
- No regressions:
  - real-need evidence stays at or above 50%;
  - wasted gate entrants stay below 50%;
  - customer return median stays at or above 3×.
- Cost per run rises by at most 25%.
- Missions with startup in their kinds collect startup entries again: on a repeat of the property-manager / Shopify topic, at least 15 startup entries.

## Non-goals

- Slice B (trends, rule changes, markets).
- Changing the gate's kill rules or the screen's ranking formula.
- Storing raw model outputs. They can hold quoted evidence and would need their own retention rules.

## Anti-goals

- **Inflated toCopy.** A high toCopy with no named, plausible moat is worse than an honest 3.
- **Hiding drops.** Making the schema so loose that broken ideas pass, for example accepting an unknown business model or relabelling an audience.
- **Loops.** Ideation still makes at most one mix and top-up re-ask round per run.

## Design

### 1. Smaller ideate calls

- **Calls of at most 3 ideas.** A lens that needs more than 3 ideas is asked in successive calls of up to 3 (`IDEAS_PER_CALL = 3`). Each later call sees the titles from earlier calls, as lenses already do.
- **More room.** The ideate output limit rises to 16,000 tokens. That is a cap, not a cost: you pay for what is used.
- **Cut-off answers are visible.** Both adapters report when an answer was cut off (Anthropic `stop_reason: max_tokens`, OpenAI `finish_reason: length`). The structured re-ask says the output was cut off and asks for the same number of shorter items. Ideate counts cut-off calls in its stage output.

### 2. Fewer invalid ideas, and visible reasons

- **Drop reasons.** When an idea fails validation, the field path and the zod issue code are recorded (for example `functionalGap: too_big`, `barriers.toCopy: invalid_type`). Never the content. The ideate stage output gains `dropReasons: Record<string, number>`, `requested`, `returned` and `truncatedCalls`, and the log prints the top reasons.
- **Normalisation before validation**, extending `normalizeIdea`:
  - cut `functionalGap` to 600 characters, cut each `knownIncumbents` entry to 120, keep the first 8;
  - numbers written as strings (`"1,200"`, `"$15"`) become numbers for `valueToUser.amountPerYear`, `priceHint.amount`, `barriers.toStart` and `barriers.toCopy`;
  - barrier scores are rounded and clamped to 1–5;
  - enum strings are trimmed and lower-cased, with a short synonym list: `one-off` / `one_time` / `one-time` → `one_off`; `transaction fee` → `transaction_fee`; `service plus software` / `service+software` → `service_plus_software`; `consumers` / `individual` → `consumer`; `businesses` / `b2b` → `business`;
  - an unknown `mechanism` becomes `other`. The mechanism is only a label now; the business model drives the screen.
  - **Still strict:** an unknown `businessModel`, `audience` or `valueToUser.kind` drops the idea (anti-goal: no hidden relabelling).
- **Top-up in the existing re-ask.** After all lenses, if fewer than `ideaCount` valid ideas exist, the single re-ask round also asks for the missing number. That's up to `ideaCount − kept`, at most 6, in calls of at most 3, alongside the mix gaps. It is still one round, never a loop.

### 3. A scale for hard to copy (`ideate.v9`)

`ideate.v9` replaces v8's bare "1–5" with anchored scales.

**toStart** (lower is easier):
- **1:** one person can launch in weeks with public data and no approvals.
- **3:** months of work, or one partnership or approval.
- **5:** heavy capital, licences or many partners.

**toCopy** (higher is harder):
- **1:** a weekend clone.
- **2:** a few weeks for anyone.
- **3:** a competent team in 3–6 months with no special access.
- **4:** needs something that builds up over time:
  - data that only usage produces;
  - network effects or two-sided liquidity;
  - deep workflow integration with real switching costs;
  - a licence or certification we can get;
  - a distribution channel we can earn without depending on a platform's goodwill.
- **5:** several of those, reinforcing each other.

Rules:
- `toCopyWhy` must name the mechanism for any 4 or 5. A score of 4 or 5 without a named mechanism is treated as 3 in code (the stored value is lowered, and the stage output counts it). "Named" means `toCopyWhy` matches a small keyword list for the mechanisms above, such as proprietary or usage data, network effect, liquidity, two-sided, integration, switching cost, lock-in, licence or license, certification, distribution, community. It's a sanity check, not a judgement of quality.
- Each call is asked to include at least one idea aiming for toStart ≤ 2 and toCopy ≥ 4, built around such a mechanism.
- The control rule still binds: a moat that depends on access we don't control is not a moat.
- v8 is kept.

### 4. Startup coverage in missions

- **Startup reservation.** When a mission's kinds include `startup`, at least max(2, ⌈15% of queries⌉) planned queries go to startup sources: YC first, then Product Hunt when its token is set. If the planner gave fewer, deterministic topic-keyword queries are added, and the query cap is kept by dropping trailing queries for other sources. This works like the existing pricing reservation.
- **YouTube is lighter.** Comments per video drop from 100 to 40, so YouTube texts no longer use up most of the extraction budget. The per-mission search cap (5) is unchanged.

## Constraints

All existing rulings bind:
- untrusted text wrapped;
- verified-evidence rules;
- R13 and R20 (calls of 3 must stay deterministic per run: same lenses, same order);
- bounded queries;
- web-safe imports and check-bundle;
- no live model or network calls in tests;
- merge gates, including core tsc;
- a secret scan.

New prompts are new versioned files. No migration is expected; stage output is jsonb.

## Done when

- Tests cover:
  - calls of 3 and the deterministic split;
  - cut-off detection in both adapters and the re-ask wording;
  - drop reasons in the stage output;
  - each normalisation, and that the strict fields still drop;
  - the top-up inside the single re-ask;
  - the toCopy rule (4 or 5 without a mechanism is lowered to 3);
  - the startup reservation and the YouTube comment count.
- bench-v2 #3 is run and reported against #1 and #2, and one repeat mission on the property-manager / Shopify topic is compared for startup entries.
