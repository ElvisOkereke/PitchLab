# Worth, Difficulty and Idea Engine v2

Status: owner approved the direction on 2026-11-10 ("everything looks good, go with your recommendation", three times: the research findings, the idea engine v2 outline, and the evidence → dossiers → playbooks library shape). Owner decisions are quoted. Everything else is a **Builder's call** (Claude).

This round comes after bench-v3 #2 (queued 2026-11-10 as the sources-only baseline) and before the library intelligence round (pain themes, playbooks, opportunity seeds).

## Why

### Owner verdict (2026-11-08)

> "Most of the ideas I killed were because they can be very simply done manually or just asking any frontier AI system to do it, given it has the right data. I want to build things that solve more challenging problems and require a bit of engineering/industry expertise."

> "Better comp analysis would help us find ideas like this … maybe have more validation steps before the ideas get sent to me."

### Research (2026-11-10, sources in the owner thread)

- **Selection matters more than generation.** LLM idea pools beat human ones on purchase intent, and the best few ideas carry the value (Girotra, Meincke, Terwiesch, Ulrich). PitchLab generates only 12 full ideas a run and advances 3.
- **LLM ideas collapse into duplicates at scale.** This holds within one model (Si, Yang, Hashimoto, ICLR 2025) and across models (Artificial Hivemind, NeurIPS 2025). What helps:
  - a long list first, then pushing each idea to be different and bold (Meincke, Mollick, Terwiesch: closest to human diversity);
  - mixing strategies (PitchLab's lenses already do this);
  - "make it different from the last" steering (Boussioux et al.).
- **LLMs judge poorly with absolute scores, and better in pairs.** Each pair is judged twice with the order swapped, and the results go into an Elo or Bradley-Terry ranking. Google's AI co-scientist (Nature, 2026) uses generate, then tournament, then evolve; experts agreed with its Elo, and evolution raised quality.
  - PitchLab's reviewer agreed with the owner's Board on scale 36% of the time.
- **Novelty needs a comparison with prior work.** SciMON revises ideas against the nearest prior work until they differ. For businesses, prior work means comps.
- **Good startup ideas sit in the "schlep"** (Graham): messy, tedious problems that convenient ideas skip. That is the owner's non-triviality rule.

### Library (measured 2026-11-10)

- 78% of the 194 `startup` entries have business model "unknown", and 6% say why the company worked or failed. Most come from one-line Show HN titles and the YC list.
- Every entry has about 1.0 source.
- No entry says why its source is strong or weak.

Comps cannot be judged from this.

## Owner decisions (2026-11-10)

1. **Idea engine v2:**
   - wide cheap sketches;
   - a diversity archive;
   - a head-to-head tournament judge, calibrated on the owner's Board;
   - evolution of the top ideas against comps;
   - folded into this round.
2. **Company dossiers and source assessment** belong in this round, because comps need them.
3. **Benchmark:** bench-v3 #2 first (done: queued), then this round, then bench-v3 #3.
4. **Library shape:** evidence (short, quote-verified), then dossiers, then playbooks. Lessons live in playbooks (next round), not in single entries.

## Goals

- **Owner keep rate on the Board** rises against bench-v3 #2. This is the primary measure.
- **The tournament judge** agrees with the owner on at least **70%** of held-out kept-versus-killed pairs, with position consistency (same verdict both orders) of at least 80%.
- **Diversity:** sketch pools hold at least 60% unique sketches (cosine under 0.85 to every earlier sketch and idea) and fill at least 8 diversity cells per run.
- **Triviality:** a new gate check kills ideas a person, or one frontier-model prompt with the data in hand, could do. Kill reasons are logged and reviewable.
- **Comps:**
  - At least 80% of new cases cite 2 or more comps, each with a dossier: who pays, pricing unit, outcome, and why.
  - At least 60% of `startup` entries have a known business model after the backfill.
- **Source assessment** on every library entry (directness, bias, strength, why), shown to ideation and on the Library page.
- **Cost:** sketches, tournament and evolution add at most **$8 per run**. The dossier and assessment backfill costs at most **$25** once.

## Non-goals

- Pain themes, playbooks, opportunity seeds and hybrid retrieval (next round).
- The public showcase.
- Changing case writing, verify or score.

## Anti-goals

- Judging with the same model family that generated the ideas (self-preference). The judge uses another family.
- Letting the judge see the owner's held-out test pairs.
- Dossier text not backed by a fetched page (quotes verified as now).
- Evolution that drops an idea's evidence: an evolved sketch keeps its cited signals, or it is discarded.

## Design

### 1. Pipeline shape

```
harvest → sketch → archive → tournament → evolve → tournament (final) → ideate (expand) → dedupe → screen → gate → case → verify → score
```

Stages `sketch`, `archive`, `tournament` and `evolve` are new (one `STAGES` entry each, resumable like the others). From `ideate` on, the stages are the existing ones, so cases, the Board and the benchmark keep working unchanged.

A run config flag `engine: 'v1' | 'v2'` (default `'v2'` once merged) keeps the old path for comparison and for owner-idea runs. Owner-idea seeds always use v1: there is one idea, nothing to sketch.

### 2. Sketch (new stage, prompt `sketch.v1`, model stage `sketch`, default `claude-sonnet-5-5`)

- **Per lens, one call:** a long list of 20 sketch titles, then a pass that marks which titles are near-duplicates or timid, then 12 to 15 final sketches, each changed to be different and bolder (Meincke chain-of-thought pattern). This gives about 90 sketches per run across 6 lenses.
- **Sketch schema** (zod, web-safe):

  ```
  { title, buyer, problem, howItEarns, businessModel, edge (one sentence, named incumbent or "none known"),
    whyNotTrivial (one sentence: the engineering, data or industry work a person or one prompt cannot do),
    earnOrSave ('earn' | 'save' | 'both'), signalIds[] (≥1, from the harvest), libraryItemIds[] }
  ```

  At most 600 characters of text per sketch.
- **Context:**
  - the harvest signals and the library context, as now;
  - plus **avoid list**: up to 60 titles of the nearest earlier ideas and sketches (any run) and every title already sketched earlier in this run, with the line "Do not repeat or rephrase these".
- **Rules carried over from ideate v14:** the evidence rule, earn-first, the narrow-consumer warning, the control ruling, the don't-copy rule for finds.
- **Rule from the owner's verdict:** a sketch whose `whyNotTrivial` amounts to "a person could do this in a spreadsheet" or "ask ChatGPT" is dropped by the model itself.

### 3. Archive (new stage, code only)

- Embed every sketch, then:
  - **drop** sketches with cosine ≥ 0.85 to any earlier sketch or idea (any run);
  - **drop** sketches with cosine ≥ 0.75 to a gate-killed idea or an owner-killed case;
  - **drop** sketches with cosine ≥ 0.85 to another sketch in this run (keep the first).
- **Diversity cells** (quality-diversity archive): `buyerKind` (business, prosumer, consumer) × `edgeKind` (data, workflow, regulation, network, AI capability, distribution, none) × `businessModel`.
  - `edgeKind` comes from a small enum the sketch prompt fills.
  - `buyerKind` is mapped in code from `buyer` and the lens audience.
- **Stored:** a `sketches` table (migration `0016`): run id, lens id, schema fields, embedding, cell, status (`kept` | `duplicate` | `near_killed`), `elo`, `parentSketchId` (for evolved sketches).
- **Logged and stored on the run:** unique share and cells filled (feeds the diversity goal and the benchmark report).

### 4. Tournament (new stage, prompt `judge.v1`, model stage `judge`, default `gpt-6-sol`, another family than ideate)

- **Format:** Swiss pairing over the kept sketches. 5 rounds, pairing similar Elo; the first round is paired across different cells.
- **Each match is judged twice**, A/B then B/A. Split verdicts count as a draw. Elo starts at 1200 with K = 24.
- **The judge prompt asks which business the owner should rather build,** on these criteria in this order:
  1. confidence that buyers really need it and will pay;
  2. **not trivial** (needs engineering, data or industry expertise; a person or one prompt with the data cannot do it);
  3. earns money for the buyer rather than saves it;
  4. a concrete edge against named incumbents;
  5. evidence strength (the cited signals with their source assessment, §7).

  The judge answers with a winner, a confidence (1–3) and one sentence per criterion.
- **Few-shot from the owner's Board:** up to 6 kept-versus-killed example pairs from the **training split** (§5), shown as "the owner kept X over Y because …". The reason is generated once per pair from the owner's tags and notes, and stored.
- **Budget:** at most 300 judge calls per run. Rounds stop early when the budget is reached.
- **Cost estimate:** about 1.2k tokens in and 150 out per call, about $2–4 a run.
- **Output:** each sketch's `elo`. The **top 12 by Elo** go on, with **at most 2 per diversity cell** and **at most 2 per business model** (the existing screen rule moved earlier).

### 5. Judge calibration (`gen audit judge`)

- **Pairs:** every decided pair of cases on the Board (one kept, one killed), plus owner idea ratings (thumbs up versus thumbs down) where both ideas have text.
- **Split:**
  - deterministic by pair hash: 60% train (few-shot pool), 40% test;
  - the split is stored, so a pair never moves;
  - new decisions are split on arrival.
- **Report:**
  - pairwise accuracy on test;
  - position consistency;
  - accuracy by confidence;
  - comparison with the reviewer's absolute scores (reviewer score difference used as a pairwise prediction);
  - cost.

  The report is written to `output/audit/judge-<date>.md` and appended to the quality log.
- **Goal:** test accuracy at least 70% and position consistency at least 80%. If it is missed, the tournament still runs (it beats no ranking), and the report says so.

### 6. Evolve (new stage, prompt `evolve.v1`, model stage `ideate`)

- For each of the top 6 sketches:
  - retrieve its **nearest 5 comps** (startup entries with dossiers, by embedding, plus any pricing entries of those companies);
  - the model writes **one evolved variant** that sharpens the wedge against those comps (SciMON-style "differ from prior work"), or combines it with one other top-12 sketch, or simplifies it to its hardest core (co-scientist evolution operators).
- **The variant** keeps the parent's `signalIds` (it may add more, from the same harvest) and records `parentSketchId` and `operator` (`sharpen` | `combine` | `simplify`).
- **Final tournament:** the 12 parents plus 6 variants play 3 more Swiss rounds (at most 120 calls). The top 12 by Elo, under the same cell and model caps, go to `ideate`.

### 7. Source assessment (library)

- **Fields** (`knowledge_items.assessment` jsonb, migration `0016`):

  ```
  { directness: 'first_hand' | 'customer_review' | 'vendor' | 'press' | 'aggregate' | 'official' | 'unknown',
    bias: string | null,     // e.g. "vendor selling the fix"
    strength: 1-5,           // computed in code
    why: string }            // one sentence, model-written
  ```
- **Strength** is computed in code from:
  - voice (operator or customer +1, vendor −1);
  - quote verified (+1);
  - corroboration: other entries within cosine 0.9 from other registrable domains (+1 at 2 or more, +2 at 5 or more);
  - recency (older than 2 years −1);
  - source type (official data or a funded-company record +1).

  It is clamped to 1–5 and recomputed on every maintenance pass. Corroboration counts are stored as `assessment.corroboration`.
- **Model part:** `library-extract.v4` adds `directness`, `bias` and `why` for new entries. A backfill job (`gen library assess`, cheap model, batches of 20) fills existing entries, for about $2–4.
- **Use:**
  - ideation and judge contexts show "strength 4/5, first-hand" next to each entry or signal;
  - the Library page shows the badge and the why;
  - the evidence rule is unchanged in this round. Strength becomes a judge input, not a kill rule.

### 8. Company dossiers (library, worker job `dossiers`)

- **Startup facts gain optional fields** (additive; zod and `library/kinds.ts`):

  ```
  whoPays, pricingUnit, priceRange, revenueDrivers[], acquisition[], moat, useCases[],
  whyItWorked?, whyItDied?, comps[] (names), funding?: { stage, amount, date },
  traction?: { customers?, reviewCount?, hiring?, rank? }, dossierAt
  ```
- **Job flow:**
  - **Pages:** the homepage, the pricing page (found from homepage links or `/pricing`), and one search for "<name> funding OR acquired OR shut down". Pages are read through `collectPage`, which escalates as now.
  - **Prompt:** `dossier.v1`, model stage `library_extract`. Every field is backed by a verified quote from a fetched page; unbacked fields stay empty.
  - **Dead companies:** one more search for a post-mortem ("<name> why we shut down").
- **Priority:**
  1. startups cited by cases or kept ideas;
  2. startups nearest to this run's top sketches (queued by evolve);
  3. business model "unknown";
  4. the rest.
- **Budget:**
  - setting `dossiers.dailyUsd` (default $2), and the job yields to queued runs, like feeds;
  - backfill of the 194 existing startups at about $0.05 each, about $10;
  - new startups from feeds and missions are queued automatically.
- **The never-fetch and banned rules, the SSRF guard and the privacy scrub apply.** People's names (founders) are not stored; company names are.

### 9. Gate v7 (`gate.v7`)

- **New check `trivial` (model):** kill when a person with a spreadsheet, or one prompt to a frontier model given the data the idea needs, would deliver most of the value. The verdict names the specific hard part (or its absence).
  - Generated ideas only; owner ideas are advisory, like `scale`.
- **New code verdict `comps` (advisory, never kills):** lists the idea's comps with dossiers, and flags "no comps found" or "only dead comps" so the case and the Board show it.
- **Existing checks unchanged.**

### 10. Ideate v15 (expand)

`ideate.v15` = v14, but each call **expands one or more given sketches** (title, buyer, problem, edge, whyNotTrivial, signals) into the full idea schema, rather than inventing ideas. Its rules are the same as v14. The idea stores `sketchId`. v14 is kept for engine v1.

### 11. Screen

Screen v6 is unchanged, except that the business-model cap and the near-twin check have already run at the tournament. The tournament Elo is stored on the idea, shown on the run page, and added to the screen total as a band (top quartile +2, second +1). That way the judge and the screen agree on order unless the screen's code bands strongly disagree.

### 12. Benchmark and audit

- **The benchmark report gains:**
  - unique sketch share and cells filled;
  - judge test accuracy (from the latest calibration);
  - trivial-kill rate;
  - comps coverage (cases with 2 or more dossier comps);
  - stage cost for sketch, tournament and evolve.
- **The run page shows:**
  - the tournament: the top 12 with Elo, the parent and variant links, and dropped duplicates;
  - each sketch's diversity cell.
- **bench-v3 #3** runs after the merge, with the same seeds as #1 and #2.

### 13. Docs

Update:
- README (how ideas are made now);
- `docs/architecture.md` (stages, judge, dossiers, assessment);
- `docs/user-guide.md` (run page tournament, Library badges, dossiers);
- the glossary ("Sketch", "Tournament", "Elo", "Diversity cell", "Dossier", "Source strength", "Trivial");
- `docs/CONTEXT.md`;
- `docs/OWNER-TODO.md`;
- `docs/idea-quality-log.md` (calibration result).

## Constraints

All existing rulings bind:
- SSRF guard and pinning, banned and never-fetch hosts;
- untrusted text wrapped;
- privacy scrub, verified quotes, bounded queries;
- R13 and R20;
- web-safe imports and check-bundle;
- old prompts kept;
- migration additive;
- no live network or model calls in tests (mock the router, `collectPage` and embeddings);
- merge gates run one after another with `set -o pipefail`, and the core suite with `--maxWorkers=2`;
- the secret scan.

New:
- **The judge never sees test-split pairs.** A test asserts that the few-shot pool and the test split are disjoint.
- **Every model call in the new stages** goes through the router with `runId` and a prompt version, so cost tracking and replay (the showcase round) work.
- **Tournament pairing is deterministic** for a seed (seeded random), so a resumed run replays the same pairs.

## Done when

- **Tests cover:**
  - sketch schema and normalisation;
  - the avoid list;
  - archive thresholds and cells;
  - Swiss pairing, swapped double judging, draws, Elo updates, budget stop and determinism;
  - the train/test split (stable, disjoint);
  - calibration metrics;
  - evolve keeping signals and lineage;
  - the final caps;
  - assessment strength computation and corroboration;
  - the dossier job (priority, budget, quote verification, no personal names);
  - the gate v7 `trivial` and `comps` verdicts;
  - ideate v15 expand;
  - the screen Elo band;
  - the v1 engine path still passing;
  - the benchmark report fields;
  - the run page and Library page rendering.
- **`gen audit judge` has run** on the owner's Board with its report in the quality log.
- **The dossier and assessment backfills have run,** within their budgets.
- **bench-v3 #3 has run** and the owner has sorted its Board.
