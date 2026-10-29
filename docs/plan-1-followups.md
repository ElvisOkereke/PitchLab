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
- [x] **Generating the validation pack from the UI** (left out of Plan 2: "use `gen validate`"). Done 2026-10-20 on
  branch `guided-tour`: the Validate tab's "Generate validation pack" button queues a `validation_jobs` row and
  `gen worker` runs it after any queued runs. Still open: no leases (a job left `running` by a stopped worker only
  stops blocking a new one after 2 hours), and `--source places`, `--include-weak` and `--pilot-site` remain CLI-only.

## Plan 4 (Continuous + deploy)
- [x] **TLS for remote Postgres** (`sslmode` or the `ssl` option) on Railway. Done 2026-10-20 (branch `supabase`):
  both pools use `packages/core/src/db/pg-config.ts`. `DATABASE_SSL` auto/verify/disable (auto = verified TLS for
  non-local hosts), `DATABASE_SSL_CA` for a private CA, URL TLS parameters removed, `DATABASE_POOL_MAX`, timeouts,
  and an idle-error listener on the worker pool. No mode skips certificate verification.
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

## Validation live-run follow-ups (2026-10-19, `docs/runs/2026-10-19-validation-freight.md`)
- Still open from Plan 3: live landing publish and the form endpoint need the hosted app; Places needs
  GOOGLE_PLACES_API_KEY; no email verification service is integrated.
- Done (fix/validation-live round 2): Cloudflare `data-cfemail` / `/cdn-cgi/l/email-protection#` addresses are decoded.
  Still open: JSON-LD `email` fields (Radius had `info@` only inside a script/JSON-LD block, which is stripped).
- `llm_calls` does not log WHY a re-ask happened: 10 of 23 outreach calls (43%) and 1 pack call were structured-output
  re-asks, and nothing records the validation issues. Store the issue text (capped) per re-ask so prompt changes can
  target the real cause.
- The prospect search reruns on every `validate` ($0.45–0.58 research plus extract) unless `--skip-prospects` is passed,
  even when the case already has more prospects than asked for. Consider skipping it when enough prospects exist, or
  make `--skip-prospects` the documented re-export path.
- Prospect yield is below `--prospects` (7–15 per call for 25 asked); size fit is loose (500-staff 3PLs, asset carriers).
  Ask research for broker authority/size evidence or run several narrower searches.
- Done: `validate --redraft` regenerates drafts of prospects that already have them (draft rows only; status, events
  and suppressions untouched), only for prospects still `new` or `drafted` (P3-R24); contacted prospects keep their
  draft rows as the record of what was sent.
- Checklist thresholds are set by the pack call before any prospect exists ("50 emails" is about 4× what web research
  yielded). pack.md now shows "you currently have N usable addresses" next to the emails_sent gate, but the threshold
  itself is still not sized to the prospect sources.
- Same "CA, US" code rendering exists in harvest/ideate/deep-case prompts (`market.countries.join`); check whether it
  skews research there too.

- Timing-ceiling tests (hostile 500KB/1MB inputs, e.g. nested-div parse, scrub linear-time) can flake under parallel suite load; a one-off core suite failure was seen once during dashboard chunk B. Consider a looser ceiling or running timing tests in a separate project.

## Dashboard follow-ups (Plan 2, `docs/dashboard.md`)
- The login rate limiter is in memory and per instance (resets on restart). Plan 4: a shared store or a proxy-level limit.
- `next build` needs the web env present at build time (dummy values work); consider lazy env reads.
- Forms lose keyboard focus after a submit (the form remounts).
- The timing-ceiling tests may flake under load (see above).
- HSTS is tested through `securityHeaders(true)`, not through the full Next config.
- The proxy matcher test imports a Next internal; it may break on a Next upgrade.
- The case page shows the same "something went wrong" message for any error thrown by a tab.
- `gen resume`'s status check is not atomic: two resumes at once can both pass it (see also the orchestrator item in Plan 4).
- No dedicated "database not reachable" banner: only Settings shows Database "not reachable"; other pages fall to an error page.
- Edits made while a save is still pending are overwritten when its result arrives (the form takes the echoed values and remounts). (D2-R7 N2)
- The queue-run form keeps the idea text and seed after a successful queue, so a second tap queues the same run again (the 3-queued cap bounds it). (D2-R7 N3)
- The backtick guard in `apps/web/test/guards.test.ts` only sees JSX text runs without `{…}` expressions; a backtick in a text run that also contains an expression is missed.

## Phase 3 follow-ups (generation rebuild, 2026-10-27)
- Validation packs draft cold outreach even for consumer cases (CASL: no implied consent for individuals). Add consumer outreach rules or block packs for consumer cases.
- Sector runs collect business-only evidence while the mix forces 30% consumer ideas; add a consumer research call for sector runs or exempt them from the forced share.
- Open and consumer runs extract every item with the combined audience prompt; consider per-call audience tagging.
- Thin candidates are still screened by the model before the pre-gate evidence filter rejects them; filter first to save spend.

## Tuning 5 follow-ups (idea yield, 2026-10-28)
- Raw model outputs are not stored, so ideate drop reasons are field path plus issue code only; reading what the model actually wrote needs a rerun with logging.
- `MOAT_KEYWORDS` (the toCopy check) is a sanity check, not a quality judgement: a toCopyWhy that names a moat word passes even if the moat is weak.

## Slice B follow-ups (2026-10-29)

- archive.org rate-limits (429) early in most missions, so the archive fallback is off for the rest of each mission. Consider a longer interval or a per-day budget.
- federalregister.gov robots.txt disallows the web pages; the API is the only route (fine), but web queries aimed at it waste a fetch.
- Gate control check: 11 of 15 bench-v2 #5 entrants failed control because any third-party official API counts as a fatal dependency. Owner decision pending.
