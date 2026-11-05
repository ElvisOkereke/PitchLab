# Idea Quality Loop and the Ambition Round

Status: the owner approved the four recommendations in `docs/idea-direction-diagnosis.md` on 2026-11-04 ("go with your recommendations"), and asked for a way to "continuously audit this and try to improve this". Every decision below not quoted from the owner is a **Builder's call** (Claude).

## Why

The owner judged recent ideas "not scalable, too niche, no perceived intelligence edge", with too much WordPress.

The diagnosis found seven stacked causes:
- pain-first framing;
- the gate's `generic` rule;
- no edge asked for or scored;
- "small, pilot fast" framing;
- no scale signal;
- vendor-heavy, narrow sources (WordPress and GitHub collectors hard-wired for Shopify seeds);
- narrow benchmark seeds.

Separately, today's scorecard measures cases and variety, but not whether ideas are any good in the owner's eyes. So there is no fast way to tell whether a change helped.

## Owner decisions (2026-11-04)

1. **Ambition over smallness:** keep "software runs most of it", and drop "small" and "pilot fast" as goals. Judge ideas on edge and scale.
2. **Competition allowed with an edge:** the gate lets through an idea that competes with what already sells when it states a concrete, checkable edge. "Same thing, new label" still dies.
3. **Evidence:** one complaint plus one demand source qualifies an idea, as well as the current three complaint sources.
4. **Wider benchmark:** the four small-business boxes give way to wider markets. This creates a new benchmark version, and old passes stay as they are.
5. **Continuous audit:** a standing loop, so improvements are measured, not guessed.

## Goals

**Part A, the loop:**
- The owner can rate any generated idea in one click, with reason tags.
- Every benchmark pass gets automatic idea reviews (scale, edge, novelty, niche), a funnel and source audit with flags, and a holdout comparison.
- The scorecard shows "owner likes ideas", median edge, median scale and the niche share.
- Baselines come from reviewing bench-v2 #4, #5 and #6.

**Part B, the ambition round, measured by bench-v3 against that baseline:**
- median edge at least +1 point against the baseline;
- median scale at least +1;
- niche share (scale ≤ 2) below 30%;
- no single signal domain above 15% of a pass's signals;
- vendor share of signals below 40%;
- cases at least 1 per run;
- real-need evidence (complaint or demand) at least 50%;
- once the owner rates bench-v3 ideas, "owner likes ideas" at least 50%.

## Non-goals

- Changing the case writer, verification or the validation pack.
- New paid data sources.
- Feeding the owner's holdout examples, or any owner ratings, into ideation prompts. They are measurement only.

## Anti-goals

- **Teaching to the test:** holdout examples never reach a prompt. Owner tags never become prompt text automatically; a human (Claude with the owner) decides changes.
- **Hype edges:** "uses AI" alone is not an edge. The edge must be concrete and checkable (a cost, speed or accuracy claim against today's option, a capability, a data or network effect), and the gate checks it.
- **Losing evidence discipline:** demand sources must be real (a cited library trend, market, rule change or pricing entry, or a verified opportunity signal). Complaints stay verified quotes.

## Design

### Part A: the loop

**A1. Owner idea ratings.**
- **Schema:** `ideas` gains three nullable columns (migration `0012`, additive only):
  - `owner_rating`: smallint, −1, 0 or 1;
  - `owner_tags`: text[];
  - `owner_rated_at`: timestamptz.
- **Tags:** `too niche`, `no edge`, `not scalable`, `already exists`, `boring`, `platform-dependent`, `wordpress or plugin`, `love it`, `would build`. Exported as `OWNER_IDEA_TAGS` (web-safe).
- **Web:** the run page idea list shows thumbs up / thumbs down / clear, plus tag chips, saved through a Server Action in the existing pattern. A small note field is not needed.
- **Scorecard:** a new metric `ownerLikes`, the share of rated generated ideas rated +1. It meets at ≥ 0.5, and `no_data` when no idea is rated. The report also lists the top 3 tags.

**A2. Idea reviewer (`idea-review.v1`).**
- **What it does:** a model stage outside the run pipeline reviews generated ideas.
- **What it scores** (1–5, each with a one-sentence reason):
  - **scale:** how many buyers, how much money moves;
  - **edge:** concrete advantage over today's option, or a capability that wasn't possible before;
  - **novelty:** new vs incremental;
  - **niche:** 5 means very narrow; the niche share counts niche ≥ 4 or scale ≤ 2.
- **Table:** `idea_reviews (id, idea_id FK unique per prompt version, scale, edge, novelty, niche, reasons jsonb, model, prompt_version, created_at)`.
- **Command:** `gen audit review [passId|--last]` reviews the generated ideas of a pass that lack a review for the current prompt version. It is idempotent (R20). Batches of 10 ideas per call go to the `review` model stage; the default model is from a different family than ideate.
- **Cost:** about $0.01–0.02 per idea, shown before running, under the soft budget pattern.
- **Scorecard:** `medianEdge`, `medianScale` and `nicheShare`.
- **Calibration:** `reviewerAgreement`, the share of owner-rated ideas where the reviewer's verdict agrees with the owner's rating. A verdict counts as liked when edge ≥ 4 and scale ≥ 3, and as disliked when edge ≤ 2 or scale ≤ 2. Shown when 10 or more ideas are rated.

**A3. Funnel and source audit.**
- **`computePassAudit(db, passId)`** returns:
  - signal voice mix;
  - signal source and top 10 domains with their share;
  - lens yield (ideas generated, screened in, advanced and cases per lens);
  - gate kills by check;
  - ideate drop reasons (summed from stage outputs);
  - demand-evidence share.
- **Flags (Builder's call thresholds):**
  - top domain > 15%;
  - vendor voice > 40%;
  - one lens > 35% of ideas;
  - one gate check > 50% of kills;
  - niche share > 30%.
- **Report:** `gen bench report` prints and writes an "Audit" section per pass. The Progress page shows it under each pass, as text only.

**A4. Holdout examples.**
- **Storage:** the setting `audit.holdout` holds up to 10 owner-written idea descriptions (title plus a few sentences).
- **Entry:** Settings, with a new "Your example ideas (never shown to the generator)" textarea list, or `gen audit holdout add|list|clear`.
- **Measure:** each pass reports, per example, the cosine similarity of the closest generated idea, using the same embedding model as the library, and the median across examples.
- **Isolation:** a guard test asserts no prompt template or prompt-building code reads `audit.holdout`.

**A5. Quality log.** `docs/idea-quality-log.md` holds one entry per change and pass: the change, the scorecard and audit deltas, the owner's notes, and what to try next. Claude writes it after each pass; it is documentation, not code.

### Part B: the ambition round

**B1. Opportunity harvest (`harvest-research.v7`).**
- **Two research angles per run:**
  - **pain**, as today;
  - **opportunity:** growing categories and adoption; what people and businesses already spend a lot on; job posts showing paid manual work that software could do; what's working at young companies; new capabilities.
- **Split:** with `opportunityShare` = 0.4, about 40% of research calls use the opportunity angle.
- **Signals:** opportunity findings become signals with a new `kind: 'pain' | 'opportunity'` column on `signals` (migration `0012`, default `pain`). Opportunity signals must still carry verified quotes and a voice.
- **WordPress and GitHub:** both collectors become opt-in through the setting `harvest.techForums` (default off). When on, they behave as today.

**B2. Ambition lenses.** Seed six new business-or-any lenses (insert on conflict do nothing):
- `ai-replaces-labour`: expensive, repeated human work across many companies or people, done by software at a fraction of the cost.
- `ten-x-incumbent`: something people already buy in volume, made 10× cheaper, faster or easier, for a segment the incumbent serves badly.
- `new-capability`: something that wasn't feasible two years ago because of recent model, data or hardware advances.
- `marketplace-network`: connect two sides where trust or matching is broken; value grows with each side.
- `data-flywheel`: a product whose usage produces data that makes it better and is hard to copy.
- `picks-and-shovels`: tools for the people riding a rising trend from `<changing>`.

Lens sampling (`selectLenses`) for open and sector runs guarantees at least 2 ambition lenses among the 6, alongside the existing at least 2 consumer lenses. `review-gap` and `platform-shockwave` get a sampling weight of 0.5 (a new nullable `lenses.weight`, default 1). Lens seeds use exactly their lenses, as today.

**B3. Ideate v12.**
- **Identity:** "an owner who wants a software business with a real edge that can grow; software does most of the work". "Small", "pilot fast" and the gendered pronoun are removed.
- **New required fields:**
  - `edge`: `{ kind: 'ai' | 'cost' | 'speed' | 'accuracy' | 'data' | 'network' | 'new_capability' | 'distribution', claim: string ≤ 300, versus: string ≤ 200, whyNow: string ≤ 300 }`. `versus` names today's option.
  - `scale`: `{ buyers: string ≤ 200, basis: string ≤ 300, source?: string }`. `source` is a library id or signal url; otherwise the basis starts "Assumption:".
- **Evidence:** cite at least 3 operator or neutral complaint signals from 3 domains, **or** at least 1 operator or neutral signal (pain or opportunity) plus at least 1 demand source. A demand source is a cited library `trend`, `market`, `rule_change` or `pricing` entry, or an opportunity signal from a different domain.
- **Kept:** `soloBuildable` stays as information only, and the control rule (owner ruling B) is unchanged.
- **Storage:** `ideas` gains `edge` jsonb and `scale` jsonb (nullable, migration `0012`). The old ideas render unchanged.

**B4. Gate v5.**
- **`generic`:** FAIL when incumbents already do the same thing and the idea's edge is missing, vague ("uses AI", "better UX") or not credible against the competitor research. PASS when the idea either serves an unserved function (as now) or states a concrete, checkable edge against named incumbents that the research does not contradict. The reasoning names the incumbent and the edge.
- **Evidence code rule:** an idea passes evidence with at least `minSignals` (3) independent operator or neutral units as today, **or** at least 1 such unit plus at least 1 demand source (as in B3, checked in code).
- **Other checks:** unchanged.

**B5. Screen v5.**
- **New criteria:**
  - `edge` (1–5): judged by the screen model with the B3 rubric; the model sees the idea's edge field.
  - `scale` (1–5): from the idea's scale field and any cited market entry.
- **Weights:** `speed` keeps its score but has weight 0.5 in the rank mean. `evidence` stays.
- **Barrier check:** the moat keywords add "proprietary model", "trained on our data", "accumulated", "benchmark of", "workflow data".

**B6. bench-v3.**
- **Seeds** (fixed within the version, so passes are comparable):
  1. open;
  2. open, a second run, for spread;
  3. sector: logistics and freight, plus construction and trades;
  4. sector: healthcare clinics, plus education and tutoring;
  5. lens seed: `ai-replaces-labour` + `ten-x-incumbent`;
  6. lens seed: `consumer-ai-chore` + `new-capability`.
- **Rules:** ideaCount 12, advanceCount 3. bench-v2 stays frozen, and `CURRENT_BENCHMARK` becomes `bench-v3`.
- **Missing sectors:** sector strings that aren't in `CA_US.sectors` are added to the market's sector list by the seed (insert or update the array, additive).
- **Cost note:** about $30–50 (6 runs).

## Constraints

All existing rulings bind:
- R13 and R20;
- verified quotes;
- untrusted text wrapped;
- bounded queries;
- web-safe imports and check-bundle;
- Server Action pattern;
- no live model or network calls in tests;
- merge gates and a secret scan;
- old prompts kept;
- migration `0012` additive only.

## Done when

- **Part A:**
  - The owner can rate ideas on the run page.
  - `gen audit review` has reviewed bench-v2 #4–#6 (the baseline).
  - The bench report and Progress page show the new metrics, the audit flags and the holdout comparison.
  - The isolation guard passes.
- **Part B:** bench-v3 #1 has been run, reviewed and reported against the bench-v2 baseline, and the quality log has its first two entries (baseline, ambition round).
