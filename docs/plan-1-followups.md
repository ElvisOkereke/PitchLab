# Plan 1: Follow-ups and Deferred Items

Taken from the Plan 1 build ledger (subagent-driven development, 2026-10-17) and its final whole-branch review triage. Each item says where it belongs.

## Do first (before the next open run)
1. **Re-run live** to check the final fix wave. Run `npm run gen -- run --seed open --ideas 12 --advance 5` and the benchmark idea seed. Check three things:
   - ideate.v3 and the diversity-aware screen yield ≥5 gate entrants and more than 1 pass (§12.2);
   - signal and competitor links now show verification flags;
   - verify cost per case is acceptable (up to 30 extra link checks).
2. **Guard the empty claims insert** in `deep-case.ts`. If every claim is filtered out (banned or unparseable sources and no signals), `tx.insert(claims).values([])` throws. The fix is a one-line `if (rows.length)`.
3. **Link cap.** Slice the displayed `evidence.signals` and `competitors.list` to the 15-item verification cap, so no link is ever shown unverified. Today, links beyond the cap render as "not checked".

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
