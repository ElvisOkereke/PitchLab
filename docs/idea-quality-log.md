# Idea quality log

One entry per change and per benchmark pass. Claude writes an entry after each pass. It is documentation, not code.

## Entry format

- **Date and title:** what changed or which pass this is (for example "bench-v3 #1").
- **Change:** what was altered, with the prompt or setting versions.
- **Scorecard deltas:** the rows that moved against the previous pass, with the numbers.
- **Audit deltas:** flags raised or cleared, lens and domain mix, niche share, holdout similarity.
- **Owner notes:** your ratings, tags and comments on the ideas.
- **Next:** what to try next, and why.

## Baseline: bench-v2 #4–#6, reviewed with idea-review.v1

- **Change:** none. This is the starting point the next passes are compared with. Reviewed 2026-11-05 (142 ideas,
  $1.14 on gemini-3.1-pro).
- **Scorecard (#4 / #5 / #6):**
  - median edge 4.0 / 4.0 / 3.5;
  - median scale 3.0 / 3.0 / 3.0;
  - niche share 59% / 46% / 48%;
  - repetition 0.63 / 0.63 / 0.62;
  - demand evidence 0% / 32% / 21%;
  - cases 6 / 3 / 12.
- **Audit (#6):** three flags raised:
  - wordpress.org supplied 15.1% of the evidence (limit 15%);
  - sellers (vendor voice) wrote 50.7% of it (limit 40%);
  - the reviewer called 48% of ideas niche or small (limit 30%).

  #4–#5 show the same pattern: wordpress.org 13.6–14.5%, vendor voice 50–60%, untagged voices on older signals.
- **Owner notes:** the owner judged these ideas "not scalable, too niche, no perceived intelligence edge" (2026-11-04).
  No ratings yet.
- **Reading the reviewer:** its niche and scale scores agree with the owner. Its **edge** scores (median 3.5–4.0) do
  not: the owner saw no edge in these ideas. The reviewer is probably too generous on edge, so treat median edge as
  unreliable until the owner has rated about 10 ideas and the agreement row is measurable; if agreement is low,
  tighten the edge rubric in an `idea-review.v2`.
- **Next:** bench-v3 #1 with the ambition round (ideate v12, gate v5, screen v5, opportunity harvest, ambition lenses,
  tech forums off).
- **Notes on reading it:**
  - The demand-evidence metric counts only ideas citing a library **trend, rule change or market** entry. Pricing
    entries and opportunity signals, which ideate v12 also accepts as demand sources, are not counted, so it
    understates demand evidence for bench-v3 ideas.
  - bench-v2 ideas have no **Edge** or **Scale** lines (ideate v12 added them), so the reviewer sees less about each
    one. That may favour bench-v3 on reviewer edge (and scale) for reasons of format, not only quality.

## 2026-11-04: harvest angle split (controller ruling)

- **Change:** every sector research call in open and sector seeds stays a **pain** call, as before this round.
  Opportunity calls are **added** on top: round(0.4 × sector calls), at least 1 when there are 2 or more sector calls,
  aimed at the first sectors in order, so a re-run makes the same calls (R20). The open seed's consumer-segment call
  stays a pain call; idea and lens seeds make one pain call, as before. Examples: 2 sectors give 2 pain calls and 1
  opportunity call; an open seed (6 sectors and the consumer call) gives 7 pain calls and 2 opportunity calls.
- **Why:** the first version split the existing calls, which took pain evidence away from 40% of the sectors. The
  evidence rule still needs complaints, so pain coverage stays whole and opportunity is extra.
- **Cost:** about 2 or 3 more research calls per open or sector run.
