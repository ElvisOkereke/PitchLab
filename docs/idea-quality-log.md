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

## 2026-11-05: bench-v3 #1 (the ambition round)

- **Change:**
  - ideate v12 (edge, scale, demand route), gate v5, screen v5;
  - opportunity harvest (extra calls);
  - six ambition lenses with weighted sampling;
  - tech forums off;
  - bench-v3 seeds: 2 open, logistics and construction, healthcare and education, two ambition lenses, AI chore plus new capability.

  $66.04 for 6 runs; review $0.49.
- **Scorecard against the baseline (bench-v2 #4–#6):**
  - median edge 4.0 (was 3.5–4.0);
  - median scale 3.0 (was 3.0);
  - niche share 53% (was 46–59%);
  - demand evidence 47% (was 21–32%);
  - customer return 10 of 12 at 3x or more, median 4.58x (was median 1.89–2.93x);
  - margin 5 of 12 (was 5 of 6 and 9 of 12);
  - repetition 0.65 (was 0.62–0.63);
  - 12 cases ($5.50 a case);
  - easy to start and hard to copy 6 of 12.
- **Audit:**
  - **Cleared:** WordPress. The top domain is now freightwaves.com at 3.2% (wordpress.org was 13–15%). GitHub is down to 2 signals.
  - **Still raised:** vendor voice 58.9% (was 50–60%). Opportunity research finds vendor pages too.
  - **New:** `generic` caused 4 of 6 gate kills (67%).
  - **Still raised:** niche share 53%.
  - **Lens yield:** cases from ai-replaces-labour 2, new-capability 2, ten-x-incumbent 2, public-data-decision 2, and one each from silent-failure, consumer-ai-chore, consumer-leapfrog and consumer-save-auto.
- **Reading it:**
  - **Improved:**
    - the evidence sources (no more WordPress);
    - the money case (customer return);
    - how often ideas rest on a trend, rule or market.
  - **Not moved, by the reviewer:** scale and niche. Many ideas still target one vertical's admin, for example "for independent practices" and "for small fleets". The healthcare seed pulled 20+ medical-billing ideas.
  - **Unreliable:** the reviewer's edge score (see the baseline note).
  - The owner's ratings are needed before the next lever is chosen, so the loop optimises for the owner, not the reviewer.
- **Owner notes:** none yet.
- **Next (candidates, pending owner ratings):**
  - aim opportunity research at neutral sources (statistics offices, news, job boards) to cut vendor share;
  - ask ideation for the widest buyer the edge serves (scale), not the narrowest one with evidence;
  - calibrate the reviewer's edge rubric against owner ratings (`idea-review.v2`).

## 2026-11-07: owner board decisions (first owner verdicts)

- **What the owner did:** sorted cases on the Board, not with idea ratings. 44 killed, 10 moved to Validating, 1 to
  Pilot ("Hygiene Chair Check"). Idea ratings: none yet.
- **Kept per pass:**
  - bench-v3 #1: 5 of 12;
  - bench-v2 #6: 4 of 12;
  - bench-v2 #4: 2 of 6;
  - bench-v2 #1–#3, owner ideas and older runs: 0 kept.

  The owner said "the most recent ideas are much better", which matches.
- **Kept by lens:** ambition and consumer lenses keep about 1 in 2 to 1 in 4. silent-failure, money-leak, review-gap,
  aggregator, compliance-demand, manual-to-productised and owner ideas: 0 kept.
- **Reviewer against the owner:** agreement was 12 of 33 cases (36%). The reviewer runs the wrong way on scale and niche:
  - kept cases average scale 2.6 and niche 4.3;
  - killed cases average scale 3.6 and niche 3.1;
  - edge does not separate them (3.8 against 3.7).

  The owner killed broad consumer "check your bills" ideas (perk overlap, delivery markup, hospital bill audits,
  allowed-amount check) that the reviewer scored scale 5. The owner kept focused tools for a concrete buyer with a
  workflow and an AI or automation edge (Vendor Loop, Zap-to-Code, Units Left, Show-Up Score, Hygiene Chair Check).
- **Next:**
  - make the scorecard read Board decisions as owner verdicts ("owner keeps");
  - recalibrate the reviewer against them (`idea-review.v2`) before trusting its scale and niche scores;
  - ask the owner what the kept cases share, in their words.

## 2026-11-07: Backtest: scale and value rule vs the owner's Board decisions

- **Status:** placeholder. The controller fills this in after `gen audit scale --decided` and `gen audit backtest`.
- **To record:**
  - agreement between the rule (revenue ceiling at least $1M and upside at least 3) and the owner's kept and killed cases;
  - the confusion table (kept or killed, against above or below the line);
  - the cases where the rule and the owner disagree, and what they share;
  - cases with no estimate, and the cost of the estimator run;
  - owner keeps and reviewer agreement (idea-review.v2) on the same cases.
- **Next:** decide whether to keep the $1M line, then run bench-v3 #2.
