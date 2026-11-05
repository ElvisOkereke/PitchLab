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

- **Change:** none. This is the starting point the next passes are compared with.
- **Scorecard deltas:** to be filled.
- **Audit deltas:** to be filled.
- **Owner notes:** to be filled.
- **Next:** to be filled.
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
