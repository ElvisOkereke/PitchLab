# Benchmark and first open run — 2026-10-17

Plan 1, Task 14. Gateway: Fuelix. Default models: ideate/case `claude-opus-5-5`, harvest/competitors/verify
`claude-sonnet-5-5`, extract/screen `claude-haiku-5-5`, gate `gpt-6-sol`, score `gemini-3.1-pro`, embed
`text-embedding-3-small`. All defaults are listed by the gateway's `/v1/models`. No `MODEL_OVERRIDES` were used.
The pipeline never fetched or submitted anything to gamersgetaway.ca (the URL checker refuses that host).

Smoke check (`scripts/smoke-llm.ts`): 4/4 OK before the runs.

Tools used to produce this log: `packages/core/scripts/run-report.ts` (DB summary) and
`packages/core/scripts/check-urls.ts` (GETs every link in an exported case).

## Defects found by the live run (all fixed, each with a failing test first)

| # | Symptom (stage) | Root cause | Fix (commit) |
|---|---|---|---|
| 1 | Run failed at `ideate`: `400 invalid_request_error: tool_choice: type "tool" and "any" are not supported for this model.` | `claude-opus-5-5` (and `claude-sonnet-5-5`, confirmed by probe) reject forced `tool_choice`. Structured output always forced the schema tool. The smoke test only exercised `structured` on `gpt-6-sol`. | Forced tool_choice stays the default. `NO_FORCED_TOOL_CHOICE` (config/models.ts) lists the two observed models, which use `tool_choice: auto` (one call) plus an instruction naming the tool, repeated on re-asks. Any other model that returns this specific rejection is retried once with `auto` and remembered for the rest of the process. A request carrying both `jsonSchema` and `webSearch` now throws. (`c95e1a4`, narrowed in `111d367` after controller review) |
| 2 | Run failed at `case`: `400 Model 'claude-opus-5-5' requires a cache_control breakpoint on prompts of 1024 tokens or more.` | A Fuelix gateway policy for opus-5-5. Requests had no `cache_control`. | The first user message carries `cache_control: ephemeral` (re-asks reuse the cached prefix). Cache-write and cache-read tokens now count as input tokens in `llm_calls`. Before this, a cached 120k-token call logged `input_tokens: 8`. (`c64e0f7`) |
| 3 | Run failed at `case` twice: SSE error `Error code: 403 - {'error': 'forbidden'}` (`anthropic.PermissionDeniedError`). | An intermittent gateway fault. Every **streaming** `/v1/messages` request (haiku, sonnet, opus, with or without tools) got 403 while the identical non-streaming request succeeded (checked with curl). It came and went across about 30 minutes. | When the stream fails with exactly this error, retry once with non-streaming `messages.create`. A 104 s, 10k-output-token opus + web-search call confirmed the gateway handles long non-streaming calls. (`61f7424`) |

After each fix: `npm test` all green (final 186/186), typecheck clean, then `npm run gen -- resume <runId>`.

## Run 1 — benchmark (`--seed idea --file "docs/Lead Gen Test.md"`)

Run `5c93e4dc-c90e-4cda-96c6-370b622c3601`: **succeeded** after 3 resumes. 1 case:
`output/cases/lead-delivery-checks-for-wordpress-care-plan-agencies.md` (git-ignored) —
"Lead-delivery checks for WordPress care-plan agencies".

- Gate: advisory, failed `generic` (competitors already test agency-managed forms; Formitor claims to flag leads
  that "didn't land"). The case addresses this head-on in *Why it wins* and makes *Next action* a hands-on test of
  Formitor, CheckView and FormTracker against three deliberately broken lead paths.
- AI scores (gemini-3.1-pro): pain 2 · roi 3 · evidence 3 · speed 2 · autonomy 4 · novelty 2 · reach 4 (avg 2.86).
- Claims: 10 total. **9 verified, 1 unsupported, 0 unreachable.**
- Cost: **$7.1007** notional. About $2.75 of that is a case-research call that was thrown away when the following
  write call hit defect 3 and the stage re-ran. 15 LLM calls, 4 failed attempts (defects 1–3). **0 × 429.**
- Duration (sum of attempts): 20.7 min.

### §12.1 case-portion criteria

| Criterion | Result | Evidence |
|---|---|---|
| Buyer is the agency (or a convincingly better one) | **PASS** | Buyer: "a small US or Canadian web or marketing agency (roughly 1–15 staff) that sells WordPress care or maintenance plans to 20–100 local-business clients". Gives the reasons for the agency over the plumber (repeated exposure, blame, existing care-plan budget line). |
| Levels table with ≥3 levels | **PASS** | 4 levels: Uptime → Browser automation / simulated submission → In-WordPress send verification (CheckView, FormStatus, WP Remote) → Lead-flow verification. This sharpens the reference by inserting the "sent ≠ received" level, and is honest that Formitor overlaps level 4. |
| Buyer-ROI and market numbers show formulas; every input has a source or a named assumption | **PASS, with one qualification** | 11 formula lines (e.g. `Annual price = $9 × 40 × 12 = $4,320`, `Annual revenue potential = 5000 × $4,320`). All 20 inputs carry either a source link + verbatim quote (2) or an `Assumption: …` (18). Totals are computed by code. Results: ROI 1.83×, payback 6.55 months, year-1 revenue $216,000. **Qualification:** one of the 2 "sourced" inputs, `problemCost[0].unitCost` = 75 (astriden.com, "Hourly rates run $75-$200/hour."), was judged `unsupported` by verify: its source does not support the value as used. |
| 100% of displayed sources resolve or are visibly flagged `unreachable`/`unsupported` | **PARTIAL — not met by construction** (signal and competitor links aren't verified; the inputs table doesn't carry claim flags). See open point 2. | Three displayed sources break the criterion: (1) signal URL rappnews.com returns 403 to the pipeline fetcher and is shown with no flag (it does load in a browser: 200, real article); (2) signal URL mickmel.com returns 403 behind a Cloudflare challenge, can't be confirmed, and is shown with no flag; (3) the unsupported astriden.com figure ($75/hour) appears in Numbers → Inputs without its `❌ unsupported` flag. It is flagged only in the Claims list. This also falls short of §12.3 ("unverified claims are visibly flagged"). What does hold: the 10 claim URLs all resolve, and the Claims list shows the one unsupported claim. Overall, 18 of 20 distinct URLs return 200 to the fetcher. |

Spec items outside the Plan 1 scope: the gamersgetaway.ca pilot plan and the Toronto-first prospect list belong to
Plan 3 (validation pack). Not attempted.

## Run 2 — open exploration (`--seed open --ideas 12 --advance 5`)

Run `376ce341-261f-4e1d-8720-f293331ad745`: **succeeded** first time (no defects). Duration 14.8 min.

- Harvest: 13 signals. Ideate: **16 ideas** from 8 lenses (`ceil(12/8) = 2` per lens, as designed).
- Dedupe: **1 duplicate**. Screen: **10 screened out**, **5 advanced to the gate** (expected ≥5: met).
- Gate: **1 passed, 4 killed**. Kill reasons (gpt-6-sol):
  - *Call-Path Verification for Home-Services Marketing Agencies*: `evidence` (only 2 independent sources).
  - *Phone-Line Lead-Flow Monitor for Home-Service Marketing Agencies*: `generic` (PNM already does scheduled test
    calls, IVR and routing checks) + `evidence` (2 sources).
  - *Broker Bond & Authority Watchlist for Freight Factoring Companies*: `generic` (Brokers Watch, CarrierOk) +
    `evidence` (1 source).
  - *Agent Canary: checks that AI automations return complete, usable answers*: `generic` (Respan, Keysight,
    AgentPing) + `evidence` (2 sources).
- **Cases produced: 1** (§12.2 asks for ≥5 to pass the gate: **not met**).
  - **Lead-Line Canary: test-call verification for home-service agencies**
    (`output/cases/lead-line-canary-test-call-verification-for-home-service-age.md`). All 6 gate checks passed.
    AI scores: pain 2 · roi 1 · evidence 2 · speed 2 · autonomy 4 · novelty 4 · reach 4 (avg 2.71). The code-computed
    ROI is 0.72× ($10,440 price vs $7,480 savings per agency), which the scorer called out. The case flags
    call-recording / robocall consent as a pre-pilot check.
  - Claims: 10 total. **9 verified, 1 unsupported, 0 unreachable.** URL check: 19/19 distinct URLs resolve; the
    unsupported claim is flagged.
- Cost: **$6.6418** notional. 45 LLM calls, 0 failed. **0 × 429.** The biggest cost items were competitor research
  (5 calls, $2.40) and the case (2 calls, $2.95).
- Screened-out titles, for the owner: Agent Canary (contract testing for AI-automation agencies), Text-Back
  Compliance & Delivery Auditor, Silent Lead-Leak Audit (HVAC/dental), Silent-Failure Monitor for AI Integrations,
  Missed-Call Revenue Recovery, AI-Connector Health Checks, LLM Spend Leak Audit, Silent-Truncation & Quota-Stall
  Sentinel, MCP Connector Watch for WordPress Agencies, Secret-Patient Reminder Audit for dental groups.

**For the owner (§12.2):** judge whether Lead-Line Canary is pitch-worthy (gut ≥4). It is the only open-run case.

## Totals

| Run | Status | Cases | Claims verified / unsupported / unreachable | costUsd | 429s |
|---|---|---|---|---|---|
| Benchmark | succeeded (3 resumes) | 1 | 9 / 1 / 0 | $7.1007 | 0 |
| Open | succeeded | 1 | 9 / 1 / 0 | $6.6418 | 0 |

No 429s or 5xx retries were seen in either run. Every failed attempt came from defects 1–3.

## Open points (need owner/controller decisions, not bug fixes)

1. **Ideas converge on the benchmark.** Most open-run ideas are variants of "silent failure + agency aggregator"
   (lead/call-path verification, silent-failure monitors). The prompts use the lead-flow case as the quality bar,
   and that appears to anchor ideation. The gate killed three near-duplicates for being generic or thinly sourced,
   so only 1 of 5 passed (§12.2 wants ≥5). Options: weaken the reference in the ideate prompt, add a lens/sector
   diversity rule, or lower dedupe from 0.88 so near-identical ideas don't all reach the gate.
2. **Verification covers claims only.** Harvested signal URLs and competitor links are shown but never checked or
   flagged, and the Inputs table doesn't repeat a claim's flag. For "100% of displayed sources resolve or are
   flagged" to hold by construction, verify would also need to check those URLs and the export would need to show
   their status. That is a schema/export change.
3. **Fuelix behaviour to keep in mind:** opus-5-5 needs a cache breakpoint on prompts ≥1024 tokens. opus/sonnet 5.5
   reject forced tool use. Streaming on `/v1/messages` 403s intermittently, which costs extra time on resumes.
