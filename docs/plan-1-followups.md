# Plan 1: Follow-ups and Deferred Items

Taken from the Plan 1 build ledger (subagent-driven development, 2026-10-17) and its final whole-branch review triage. Each item says where it belongs.

## Do first (before the next open run)
1. **Re-run live** to check the final fix wave. Run `npm run gen -- run --seed open --ideas 12 --advance 5` and the benchmark idea seed. Check three things:
   - ideate.v3 and the diversity-aware screen yield ≥5 gate entrants and more than 1 pass (§12.2);
   - signal and competitor links now show verification flags;
   - verify cost per case is acceptable (up to 30 extra link checks).
2. **Guard the empty claims insert** in `deep-case.ts`. If every claim is filtered out (banned or unparseable sources and no signals), `tx.insert(claims).values([])` throws. The fix is a one-line `if (rows.length)`.
3. **Link cap.** Slice the displayed `evidence.signals` and `competitors.list` to the 15-item verification cap, so no link is ever shown unverified. Today, links beyond the cap render as "not checked".

## Tuning-3 (2026-10-19, branch `tuning-3`)
- [x] **Source skew:** open and sector seeds now make one research call per sector (3 searches each, trade and owner
  sources preferred), and the tech-forum sources (HN, Stack Exchange, GitHub, WordPress.org) run only when a
  software-adjacent sector is chosen.
- [x] **Diverse gate entrants follow-ups (run 3):** screen skips candidates at cosine ≥ 0.75 to any gated-out idea;
  ideate sees past `generic` kills ("already sold") and ideas with cases ("already covered"); screen ranks by a
  novelty-weighted mean minus 0.25 per known competitor (max 1).

Open after tuning-3:
- `lens` seeds still use a single research call (not per sector).
- ~~The screen's crowdedness list (`knownCompetitors`) is model knowledge, not searched.~~ Removed in tuning-4.
- **D5:** the gate counts evidence before verification, so a harvested quote that isn't on its page still counted
  toward the `evidence` rule. Consider re-checking evidence after verify.
- GitHub-API verification has not yet been exercised on a real case (no GitHub URLs in run 3 or the owner-idea runs).

## Tuning-4 (2026-10-19, branch `tuning-4`): run-4 recommendations
- [x] **Generator and gate disagree on buyer choice (run 4, Read 5):** owner chose option (a). `ideate.v7` says a new
  buyer, channel, distribution wedge or packaging is not a differentiator and asks for `knownIncumbents` and
  `functionalGap`; `gate.v2` judges that claimed gap.
- [x] **Crowd penalty added nothing (Read 2):** removed; screen ranks by `(7 criteria + novelty) / 8` (`screen.v3`).
- [x] **Signals mostly from vendor blogs (Read 3):** extraction tags `voice` (operator / neutral / vendor); only operator
  and neutral count toward the gate's evidence rule (untagged legacy signals don't either, after the security round);
  harvest research prefers owner communities and neutral bodies (`harvest-research.v5`).

Open after tuning-4:
- **D5 still open:** the gate still counts a signal's source before verification checks the quote is on its page.
- `functionalGap` and `knownIncumbents` are model claims, not verified evidence. They are labelled as unverified in every
  prompt, but nothing checks them; only the gate's competitor research tests the gap.
- Voice is the extraction model's judgement from the page itself; a vendor page written in an owner's voice can still be
  tagged `operator`. Spot-check voices in run 5.
- Untagged legacy signals no longer count: re-gating or re-running old ideas fails `evidence` until their signals are
  re-harvested (re-harvest backfills a NULL voice).
- [x] ideate.v7 wording aligned with the gate in tuning-4 review.

## Waiting on owner feedback (§12.2 tuning)
- Should lead-form examples be dropped from the benchmark quality bar in the ideate prompt?
- Should `DEFAULT_WP_SLUGS` and `PAIN_PHRASES` be broadened beyond lead-form and SMTP pain? Today they push signals toward the benchmark.
- Should community platforms (HN, Stack Exchange, GitHub, WordPress forums) count as independent evidence per thread rather than per domain? Today the gate counts by domain, under ruling R21.

## Plan 2 (Dashboard)
- `cases.updatedAt` has no `$onUpdate`, so stage moves must set it explicitly.
- The dashboard must escape all case text and never render raw HTML (R13). Markdown autolinks and formatting injection are export-only concerns.
- App Store source: add an app-id list in Settings. Harvest skips the App Store until then (R12).
- Validate base URLs in Settings.

## Plan 3 (Validation pack)
- CASL footer checks are substring-only. Tighten them when outreach drafting is built.

## Plan 4 (Continuous + deploy)
- **TLS for remote Postgres** (`sslmode` or the `ssl` option) on Railway.
- **Spend caps need accurate cost data:**
  - Cache write and read tokens are priced at the plain input rate.
  - In-adapter fallbacks (the stream-403 retry and the forced-tool rejection) are not logged in `llm_calls`.
  - `cache_control` is added to every Anthropic call.
- **Router reliability:**
  - Logging sits inside the attempt `try`, so a failed log write can mask the real error.
  - Truncation (`stop_reason` max_tokens, `pause_turn`) is silent.
  - Embed requests have no batch limit.
  - The embed model family is not validated.
- **Orchestrator:**
  - A DB error raised outside the `try` can leave a run stuck in `running`.
  - Nothing stops two processes resuming the same run concurrently.
- **Build:**
  - Move vitest, typescript and @types/node to devDependencies, and pin `engines` to Node ≥22.12.
  - The worker must use tsx or a bundler (R5).
  - Add FK and ANN indexes.
  - Migrate driver detection still relies on casts.
- **Lens-seed queries** are long sentences that return little from the free sources.

## Can wait (polish and coverage)
- **Signal sources:**
  - A null array element can throw.
  - Entity decoding has gaps.
  - Stack Exchange results are biased toward the first site.
  - Items with empty text are not filtered.
- **Fetcher:**
  - Charset is assumed to be UTF-8.
  - Fallback text includes script and style contents.
  - An extraction error is mislabelled `network`.
- **Duplicated code:**
  - The "load ideas by id" block is repeated across dedupe, screen, gate and deep-case.
  - `clean` in harvest duplicates `capField`.
- **CLI:**
  - No automated CLI tests.
  - Flags that don't apply to the chosen seed are silently ignored.
  - Progress lines repeat the stage prefix.
  - A backslash in a link URL breaks the Markdown export.
- **Diagnostic scripts:**
  - `run-report.ts` resolves its DB path from the current directory.
  - `check-urls.ts` breaks on URL edge cases.
- **Test gaps:** threshold boundaries, ratio boundaries, the ideate and gate re-run paths, and env-loading edge cases.

## Security posture (done in Plan 1, for reference)
- **Page fetching:**
  - Only GET requests.
  - SSRF guard: allows only global-unicast addresses and pins the connection to the checked address, closing DNS rebinding.
  - Redirects are re-checked on every hop.
  - Banned-source domains are enforced in code and fail closed.
- **Untrusted text:**
  - All of it is wrapped and neutralised: every angle bracket and invisible character.
  - Field lengths are capped.
- **Pipeline:**
  - Evidence independence is counted by registrable domain.
  - Every stage is idempotent on re-run (R20).
- **Output:** Markdown export escapes all case text, and secrets come only from env.
- Gate thread keys: canonicalise per platform (HN item id, SO/SE question id, GitHub issue path) and drop tracking params; optionally make THREADS_PER_PLATFORM configurable.

## Tuning-3 review follow-ups (minor)
- Percentage-price matcher (`FEE_BEFORE`) is loose. Allow only whitespace or a colon between the fee word and the number, and drop "rate", "share", "cut" and "takes". Add negatives: "churn rate 5%", "market share 20%", "cut costs by 30%".
- Sector matching for the tech-forum switch is exact and case-sensitive, so "Web design agencies" would skip the forums. Sector seeds with more than 8 sectors research only the first 8.
- "(N claims)" in "For you to check" also merges unchecked items that have no claim row, so the wording is slightly off for those.
- When one sector's research call fails, the other concurrent calls keep running and are still paid for.

## Run-5 follow-ups (generator tuning, parked while validation and dashboard are built)
- Autonomy is now the main gate killer (4 of 5 entrants). Feed ideation every gate-kill reason (not only generic) and add a rule matching the autonomy check: do not propose services that need human judgement or manual labour per customer.
- Voice tagging: keep problem catalogs (scored lists of problems) out of operator voice; tags are noisy for agency blogs. One mis-tagged GitHub signal let 4 of 5 entrants reach the 3-source minimum.
- WordPress forum queries should follow the chosen sectors instead of a fixed plugin list. Legal, marketing and IT services produced no ideas in run 5.
- 5 of 8 ideas cited the same 5 signals: raise signals per sector or require each idea to cite a different subset.
- Spot-check found wrong incumbent facts (NCS, Paidnice): the gate relies on the competitor research, so treat idea-stage incumbent lists as hints only.

- Pilot-plan permission tripwire (validation/schema.ts) is a best-effort keyword check on advisory text; known edge cases (dash/clause scoping, unusual phrasing) are accepted limitations. The pack-docs fallback adds permission reminders and an audit note.

## Plan 3 limitations (recorded at chunk B review)
- The draft link guard allows non-ASCII hostnames (e.g. Cyrillic domains); only punycode and ASCII labels are matched.
- The stored landing_pages.html keeps the settings at generation time; a future live publish must re-render from the stored copy fields, not publish the stored html.
- Bare URLs inside pack.md model text can autolink in GitHub-flavoured Markdown viewers (drafts are guarded, pack text is not).
- Email verification service is not integrated; Places needs GOOGLE_PLACES_API_KEY; live landing publish and the form endpoint need the hosted app.
