# Business Case Generator — Living Context

> Single source of truth for this long-running project. Read this first at the start of every session.
> Update it whenever a decision is made or something new is learned.

## Status
- **Generation rebuild (branch `generation`, built 2026-10-27):** ideas carry audience, business model and barrier
  scores; cases carry a value multiple; six consumer lenses; the scorecard measures consumer share, model variety and
  easy-start/hard-copy; `bench-v2` (bench-v1 plus a consumer-lens run) is the current benchmark. `demandEvidence` stays
  not measured (Phase 2 Slice B). Owner to-do: run a bench-v2 pass after merging. Design:
  `docs/superpowers/specs/2026-10-27-generation-rebuild-design.md`.
- **Research library (Phase 2, Slice A, branch `library`):** a persistent library of problems, pricing and startup entries
  that runs draw verified evidence from. Missions start from the Library page or `gen research`; background research is
  off by default (cap $5 per Toronto day, $1 missions). Sources: HN, GitHub, Stack Exchange, app reviews, Product Hunt,
  YC list, web pages. **Reddit is dropped** (site terms; owner decision).
  Design: `docs/superpowers/specs/2026-10-26-research-library-design.md`.
  **Research reach (branch `reach`):** YouTube comments (optional key, 30-day expiry), archive fallback, optional local
  Chromium for thin pages, fetch diagnostics on the Library page. Design: `docs/superpowers/specs/2026-10-28-research-reach-design.md`. Owner to-dos are in `docs/OWNER-TODO.md`.
- **Phase:** **Plan 1 complete; tuning-2 (branch `tuning-2`) run live 2026-10-17, results in `docs/runs/2026-10-17-run-3.md`.**
  Open run: 5 reached the gate, **0 passed** (§12.2 not met; run 2: 1); `generic` killed 4 of 5. Lead-capture gate
  entrants fell from 3/5 to 1/5, but repeat ideas (benchmark idea, a run-2 gate kill) still reach the gate: the
  case-similarity rule (0.82) never fired, real copies sit at 0.68–0.86. No new case, so the new-case checks
  (`needs_review`, pricing split, GitHub via API) are untested live. One export defect fixed (legacy competitor claims).
  2026-10-19: five owner-idea cases written (`docs/runs/2026-10-19-owner-ideas.md`), none pitch-worthy yet.
  **Tuning-3 built on branch `tuning-3`** (funnel + per-sector research + D1–D4; 368 tests green) and run live
  2026-10-19 (`docs/runs/2026-10-19-run-4.md`): 39 signals, 13 ideas, 5 at gate, **0 passed** (generic 4, autonomy 3);
  ideas fully off the old clusters, but the crowd penalty saturated (12/13 at cap) and web signals are mostly vendor
  blogs. **Tuning-4 built on branch `tuning-4`** (owner chose option (a); 368 → 399 tests green, migration 0003):
  ideate names incumbents + the functional gap and is told a new buyer/channel is not a differentiator, the gate
  judges that claimed gap, the crowd penalty is gone, and signals are tagged operator/neutral/vendor with only
  operator + neutral counting as evidence. Merged to main and run live 2026-10-19 (`docs/runs/2026-10-19-run-5.md`):
  migration 0003 applied cleanly (prior rows unchanged), 43 signals (operator 17, neutral 0, vendor 26), 8 ideas, 5 at
  gate, **0 passed** (autonomy 4, generic 2, control 2, regulation 1). Generic kills now about function, not buyer;
  autonomy is the binding check; operator-only evidence collapsed ideas onto two signal sets. Next: owner decision on
  run-5 Read 5–6 (feed all kill reasons + an autonomy rule into ideate; fix signal supply), then Plan 2 (Dashboard).
  **Plan 3 (validation pack) built on main and run live 2026-10-19 on the freight case**
  (`docs/runs/2026-10-19-validation-freight.md`): migrations 0004/0005 applied cleanly, exit 0, $3.14 over 3 runs; pack,
  interview kit and landing page are good; prospect yield 46% email, ~50% real broker fit. Branch
  `fix/validation-live` (not yet merged, 604 tests green) fixes the 3 live defects (CA read as California, price
  without "$", carriers@ ranked as a person) and adds: **outreach.v2** drafts (an "I'm building …" line and one yes/no
  question, both written from the case; no figures in the cold email or follow-up 1; follow-up 2 may use only the offer
  term and verified figures; ≤ 90/60 words); **`validate --redraft`** (regenerates drafts only for prospects still
  `new` or `drafted`; contacted prospects keep their stored drafts as the record of what was sent, and their stored
  footers are no longer rewritten; P3-R24/R25); **pack-docs.v2** (interview-kit channels for each market country, e.g.
  Canadian as well as US); Cloudflare-protected emails decoded; pack.md shows "you currently have N usable addresses"
  next to the emails_sent gate; the price unit must be a short plain phrase (P3-R23), otherwise it is dropped and logged.
  Owner next: **set `sender.name`, `sender.address`, `sender.contact` and `landing.privacyContact` (still unset)**, then
  `validate <slug> --skip-prospects --redraft` to get v2 drafts at low cost, contact 6–7 good-fit brokers (Horizon, Qeep
  first), edit drafts before sending.
  **Plan 2 (Dashboard) built on branch `plan-2`:** chunks A–C reviewed and green (Postgres in docker-compose, auth,
  board/leaderboard/command/case tabs/runs/settings, worker for queued runs, `db:copy`); guide in `docs/dashboard.md`.
  **Task 16 local acceptance done 2026-10-20 on a PGlite-over-socket stand-in for Postgres (Docker was not running)**
  (`docs/runs/2026-10-20-dashboard-acceptance.md`). db:copy matched every table (cases 9), and a second copy inserted 0.
  `npm run acceptance -w apps/web` passed 13/13 (routes behind login, cookie, board counts, 10 cases × 7 tabs, export,
  stage moves, scores, hostile posts, queueing, rate limit, bundle scan). A live worker run queued from the dashboard
  succeeded ($4.37, 1 case). No product defect was found. Still owed before merge, ideally: the same run on Docker
  Postgres with `TEST_DATABASE_URL` (the real-Postgres worker claim test), plus a real phone check.
  Owner actions: **start Docker Desktop** and repeat the acceptance (commands at the end of the results doc);
  **set sender identity** (`gen config set sender.*`, also editable in the dashboard's Settings); **choose a dashboard
  password** (`npm run hash-password -w apps/web`). Your local DB lacks migration 0006: back up `.data/pglite`, then
  `DATABASE_URL=pglite://.data/pglite npm run gen -- runs` before `db:copy` (`npm run db:migrate` resolves the
  relative path inside `packages/core` and would migrate a new empty folder instead).
  **Supabase (free) instead of Docker, branch `supabase` (owner decision 2026-10-20):** web + worker on the owner's PC,
  database at Supabase via the session pooler. Both pools now share `packages/core/src/db/pg-config.ts`: verified TLS
  for non-local hosts (`DATABASE_SSL` auto/verify/disable, `DATABASE_SSL_CA` for Supabase's certificate; no mode
  skips verification), URL `sslmode`-style parameters removed, `DATABASE_POOL_MAX` (web 5, worker/CLI 4), 15 s
  connect timeout, idle-error listener on the worker pool. Owner steps: `docs/dashboard.md`, "Free setup". Not yet
  verified against a live Supabase project.
  **Guided tour, in-app help and repo docs, branch `guided-tour`** (plan `docs/superpowers/plans/2026-10-20-guided-tour.md`):
  built-in example case (hide/reset in Settings), validation packs queued from the Validate tab and run by the worker
  (migration 0007), "?" help tips with `docs/glossary.md`, an 8-chapter tour ("Take the tour"), and the first public
  docs: `README.md`, `docs/user-guide.md`, `docs/architecture.md` (`docs/dashboard.md` stays the setup guide). Product
  name: PitchLab. Not merged yet.
  Follow-ups + deferred items: `docs/plan-1-followups.md`.
  Roadmap: Plan 1 Core pipeline (CLI) → Plan 2 Dashboard → Plan 3 Validation pack → Plan 4 Continuous + learning + deploy.
  **Idea-quality benchmark, branch `benchmark`** (spec `docs/superpowers/specs/2026-10-25-idea-quality-roadmap-and-benchmark-design.md`):
  13-metric scorecard computed from stored rows, frozen `benchmark_passes` snapshots, `gen bench baseline|run|report`,
  a worker finalise hook and a Progress page with Run benchmark and Recompute buttons (migration 0008: after pulling, run a `gen` command or start the worker once before `npm run web`). Not merged yet; no live pass run yet.
- **Repo:** https://github.com/ElvisOkereke/PitchLab (main)
- **Last updated:** 2026-10-26

## The Goal (in the user's words, summarised)
Build a repeatable **software-service business case generator**: something run consistently to research and produce
well-thought-out, cutting-edge or niche business cases the user can act on to generate cash.

Ideas must:
- NOT be generic / off-the-shelf
- Be clever services that sell on **usefulness alone**: they save companies **time or money**
- Be strong enough to give someone **confidence to go out and pitch**
- Be **somewhat autonomous to run** (not necessarily fully), because the plan is to run **many at once**
- Go to market **fast** and produce **consistent cashflow**

## About the User
- Software engineer, based in **Toronto, Ontario, Canada**
- Solo: **just them + AI**, no hires
- Comfortable doing sales themself (cold email, LinkedIn, calls)
- No strong industry network; willing to reach out to people in suggested sectors to farm info
- Motive: stack cash on the side → **acquire a larger business**
- Token access: **Fuelix**, provided through their SWE job (also what this conversation runs on). ⚠️ See Risks.

## Decisions Made (from round 1, 2026-10-17)
| Topic | Decision |
|---|---|
| Time budget | No limit |
| Spend per idea | Scales with confidence in the idea |
| Cashflow target | None yet; just cashflow positive |
| Deal size | Open to anything if the idea is good |
| Delivery model | Anything that works (service, productised, SaaS) |
| Off-limits | Anything needing regulation/licensing, or anything **outside their control that slows go-to-market** |
| Bar for a case | Must make sense on value delivered, backed by **real research, calculations, and evidence** that it's worth building |
| Run modes | Both **continuous** and **single runs** |
| Interface | **Web dashboard UI** |
| Validation scope | **Everything possible**: prospect lists, outreach drafts, landing page, MVP spec, etc. |

### Round 2 decisions (2026-10-17)
| Topic | Decision |
|---|---|
| Fuelix use | User says **no issues** with employer. Still keep the provider swappable (design principle, Claude's call) |
| First pipeline run | Run the **lead-flow idea** through the full pipeline as benchmark + possible first real case |
| Autonomy ceiling | No hours limit for now; user may scale back later |
| Compliance-driven demand | **OK**, as long as the user needs no license themselves |
| Dashboard hosting | **Hosted** (reachable from phone) |
| Markets | Start where it makes sense (Claude's call: Canada + US, English); **architect for other markets later** |
| Feedback loop | **Confirmed**: keep/kill decisions feed back to tune future runs |

### Round 3 decisions (2026-10-17)
| Topic | Decision |
|---|---|
| Stack | Claude's call (user is fluent in most popular stacks) |
| Hosting | **Vercel** preferred (free tier) |
| LLM access | Fuelix: **Anthropic-compatible API** at `https://api.fuelix.ai/`; token is in global `~/.claude/settings.json` env (`ANTHROPIC_AUTH_TOKEN`). **Never copy the token into the repo**; use env vars |
| Paid data | Fine with paying, but **weigh all options** (comparison in design doc) |
| Outreach | **User sends** emails themself; system drafts only (avoids CASL sending burden) |
| Landing pages | **Both**: generate files, and optionally auto-publish to a live URL |
| Continuous-mode limits | **Keep all options** (configurable: unlimited, daily run cap, daily spend cap) |
| Feedback | **Multi-criteria scoring** per case, so the generator evolves |

### Round 4 decisions (2026-10-17)
| Topic | Decision |
|---|---|
| Hosting | **Option A**: Railway (Next.js dashboard + Node worker with pg-boss + Postgres/pgvector), Cloudflare Pages for landing pages, Cloudflare Registrar |
| Fuelix volume | **No limits**; owner watches costs per API. Caps default off, still configurable; cost logging ships |
| Pilot site | **gamersgetaway.ca**: WordPress, lead capture via friend's **custom Claude-built plugins**. **No permission yet**: passive inspection only, never submit forms |

### Fuelix recon (2026-10-17)
- `GET /v1/models` returns **120 models**: Claude (opus-5-5, sonnet-5-5, haiku-5-5, …), GPT (gpt-6-sol, gpt-5.4, …),
  Gemini (3.x pro/flash), DeepSeek, Mistral, Llama/Qwen, **embeddings** (text-embedding-3-large/small),
  **image gen** (imagen-4, dall-e-3), whisper/tts.
- Implications (Claude's read): cheap models for bulk scanning, top models for deep cases; a **different model family
  as the adversarial judge** to reduce self-agreement bias; embeddings for **idea dedupe + taste learning**; image models
  for landing page visuals. Built-in Anthropic web search likely not available via gateway → need a search API.

- **Capability tests (2026-10-17), all passed:**
  - `POST /v1/messages` (Anthropic format): custom **tool use** works (claude-haiku-5-5)
  - Anthropic **server-side `web_search` tool works** through Fuelix (claude-sonnet-5-5). This may remove the need for a
    paid search API (paid APIs stay as fallback/supplement).
  - `POST /v1/chat/completions` (OpenAI format) works for **non-Claude models** (gemini-3.5-flash, gpt-5.4-mini).
    Reasoning models need generous `max_tokens`, or `choices` comes back empty.
  - `POST /v1/embeddings` works (text-embedding-3-small → 1536 dims)
- **Gateway quirks found on the live run (2026-10-17), all handled in `src/llm/anthropic.ts`:**
  - `claude-opus-5-5` / `claude-sonnet-5-5` reject forced `tool_choice` (`tool`/`any`) → `auto` + instruction for those
  - `claude-opus-5-5` prompts ≥1024 tokens need a `cache_control` breakpoint (gateway policy) → first user message is marked
  - Streaming `/v1/messages` intermittently returns SSE `403 forbidden` while non-streaming works → one non-streaming retry
  - No 429s seen at default concurrency (4)

### Dashboard UI decisions (visual companion, 2026-10-17)
- Home = **Pipeline board** (B)
- Case view = **Tabs** (A): Summary · Evidence · Numbers · Competitors · Pitch · Validate · Score
- Scoring criteria (1–5 + note), **all 8 kept**: Pain severity, Buyer ROI clarity, Evidence strength, Speed to market,
  Autonomy, Novelty/non-generic, Reachability, **Your gut** (user-only; AI scores the other 7)

### Hosting notes to verify in design (Claude's understanding, unverified)
- Vercel **Hobby is for non-commercial use**. The private dashboard is probably fine; live business landing pages may need
  Pro ($20/mo) or another host.
- Serverless function time limits plus Hobby cron (~daily) **don't suit long continuous research runs**. Options: durable
  step orchestration (Inngest / Trigger.dev / Vercel Workflow) or a cheap always-on worker. Decide in design.
- User (2026-10-17): **Vercel Pro is acceptable** expense-wise, but **still compare cheaper alternatives** in the design.
- **Dashboard home = B, Pipeline board** (stages New → Validating → Pilot → Live → Killed). Leaderboard and
  command-center views remain as secondary tabs (Claude's call). Chosen 2026-10-17.
- Dashboard mockups are in `.superpowers/brainstorm/` (visual companion). Add `.superpowers/` to `.gitignore` once a repo exists.

## Reference Idea: "Lead-flow verification" (`docs/Lead Gen Test.md`)
The user's own idea and the quality benchmark. They may pursue it, with a friend's **game truck business site** as a pilot.
- Problem: lead forms silently fail (plugin update, SMTP, CRM integration). The site is up, analytics shows a conversion, but the lead never arrives.
- Insight: uptime → browser automation → **lead-flow verification** (confirms the downstream result). Level 3 is the gap.
- Buyer insight: the **agency managing 20–100 sites** buys, not the end business. They have repeated exposure and a reputation to protect.

What makes it good (Claude's read, to use as generator criteria):
1. A **silent, costly failure** existing tools miss
2. A clear **"levels" argument** for why current solutions fall short
3. **Buyer ≠ obvious buyer**: sell to the aggregator who feels the pain repeatedly
4. **Automatable delivery**: one engine, many clients
5. **No regulation**, fast to pilot

## Risks / Flags
- **Fuelix is employer-provided.** Raised in round 2; user confirmed no issues. **Design implication kept:** LLM provider is config-driven and swappable.
- **CASL (Canada's anti-spam law)** applies to cold commercial email sent from or to Canada. If the system ever *sends* outreach rather than drafting it, it must handle consent rules, identification, and unsubscribe. → Raised in round 3.

## Open Questions
See `docs/QUESTIONS.md` (round 3 sent 2026-10-17).

## Working Assumptions (Claude's guesses, not confirmed)
- Pipeline shape: source pain signals → generate ideas through "lenses" like the benchmark → adversarial kill gate
  (generic? competitors? regulation? autonomy?) → deep case with sourced numbers and ROI math → validation pack →
  dashboard to review, rank, and track ideas through stages (idea → validating → pilot → live → killed).
- Default stack if user hands it over: TypeScript, Next.js dashboard, Postgres, separate background worker for
  long/continuous runs, hosted on a small VPS or Railway/Fly-style platform.

## Session Log
- **2026-10-17:** Kickoff. Created context files. Sent round-1 questions.
- **2026-10-17:** Round 1 answered. Read benchmark idea. Flagged Fuelix risk. Sent round 2.
- **2026-10-17:** Round 2 answered (see table). Pipeline read confirmed incl. feedback loop. Sent round 3 (how it gets built).
- **2026-10-17:** Round 3 answered. Probed Fuelix (Anthropic-compatible, 120 models). Next: dashboard mockups, then design doc.
- **2026-10-17:** Mockups: Board home + tabbed case view, 8 criteria. Fuelix tool use, web_search, OpenAI route, and embeddings all work.
  Research saved to `docs/research/hosting-and-data-2026-10-17.md`. Design doc drafted at
  `docs/superpowers/specs/2026-10-17-business-case-generator-design.md`. Builder check done. Asked owner 3 final
  questions: hosting option A vs B, Fuelix volume/quota, game-truck site details.
- **2026-10-17:** Round 4 answered (Option A, no Fuelix limits, gamersgetaway.ca, no permission). Owner approved the design.
  Wrote Plan 1 (14 tasks, TDD, CLI-first, ends with live benchmark run).
- **2026-10-17:** Plan 1 built (Tasks 1–13) and run live (Task 14). Fixed 3 gateway defects (above). Benchmark case
  "Lead-delivery checks for WordPress care-plan agencies": agency buyer, 4-level table, all numbers formula-backed with
  sources or named assumptions (one sourced input judged unsupported), 9/10 claims verified (1 flagged unsupported);
  evidence-integrity criterion only PARTIAL (2 unflagged signal URLs return 403 to the fetcher; the inputs table lacks
  claim flags); notional cost $7.10. Open run: 16 ideas →
  1 duplicate, 10 screened out, 5 at gate, 1 passed ("Lead-Line Canary", ROI 0.72×); $6.64. **Owner to review both cases.**
  Open points for owner: ideation anchors on the benchmark pattern (only 1/5 passed the gate); verify covers claims but
  not harvested-signal/competitor URLs. Details in `docs/runs/2026-10-17-benchmark.md`.
- **2026-10-17:** Final-review fix wave landed (evidence integrity, idempotent ideate, banned sources in code, ideate.v3 diversity). Merged to main and pushed to GitHub (PitchLab). Owner asked for detail on the 3 tuning questions (see docs/plan-1-followups.md).
- **2026-10-17:** Owner decisions on §12.2 tuning: (1) **remove** the lead-form benchmark example from idea generation
  (keep the five principles in abstract form; the lead-flow idea stays as the benchmark *test*); (2) **broaden** harvest:
  per-sector pain-phrase banks for the market's sectors + wider WordPress plugin list; (3) **hybrid** evidence counting:
  community platforms (HN, Stack Exchange, GitHub, WordPress.org) count distinct threads, max 2 per platform; other sites
  count once per registrable domain. Work on branch `tuning-1`, then live re-run.
- **2026-10-17:** Run 2 on `tuning-1` (`docs/runs/2026-10-17-run-2.md`). Open run: 14 ideas, 0 duplicates, 9 screened
  out, 5 at gate, 1 passed ("Lead leak audits for multi-location HVAC and dental", ROI 3.7× but built on 2 unsupported
  inputs); kills: generic 3, control 1, autonomy 1, evidence 0. Benchmark: "Lead-arrival checks for agency client
  sites", §12.1 4/4 (evidence integrity now holds by construction), ROI 0.24×. Fixed: verify judged empty
  JS-rendered pages as unsupported (`07e228f`); formula lines rounded 0.003 to 0 (`7a3cb19`). Cost $7.30 + $4.06,
  0 × 429. Owner decisions needed: what competitor-link checks should assert ("Not published" pricing always fails),
  GitHub issue verification, a diversity rule at screen.
- **2026-10-17:** Run 2 done (`docs/runs/2026-10-17-run-2.md`): evidence kills fixed, link flags complete, ideas more
  varied in mechanism but the screen still favours lead capture; no case pitch-worthy yet. Owner decisions for tuning-2:
  (1) competitor checks confirm as much as possible (product page; pricing when a figure is quoted) and **anything not
  confirmable goes to a "For you to check" list for the owner**, separate from real failures; (2) verify GitHub signals
  via GitHub's API; (3) ideas declare mechanism + buyer type, max 2 per mechanism reach the gate, and ideas too close to
  an idea that already has a case are screened out; (4) cases show only signals the writer actually used; HTML entities
  decoded. Branch `tuning-2`.
- **2026-10-17:** Run 3 on `tuning-2` (`docs/runs/2026-10-17-run-3.md`). Open run: 10 ideas, 0 duplicates, 5 screened
  out (1 by the mechanism cap, 0 near-twin, 0 close to a case), 5 at gate, **0 passed** (generic 4, autonomy 2,
  control 1); no case; $3.39, 0 × 429, 0 GitHub rate-limit hits. Gate entrants 1/5 lead capture (run 2: 3/5).
  Fixed: export ignored pre-tuning-2 `"name: pricing"` competitor claims, so old cases listed every competitor as
  "not checked yet" (`78885c1`). Owner decision needed: how to stop repeat ideas reaching the gate (similarity to past
  gate kills, lower threshold) and whether to feed `generic` kills back into ideate.
- **2026-10-17:** tuning-2 merged + pushed. A CRLF line-ending issue (Windows autocrlf) broke one test on main briefly; fixed (prompt loader normalises CRLF, `.gitattributes` enforces LF) and pushed green (310 tests). Run 3: 0/5 passed the gate (all `generic`); next options presented to owner.
- **2026-10-19:** Owner approved option A (run the five screened-out novel ideas as owner ideas) then B+C. Five cases generated
  ($21.56; `docs/runs/2026-10-19-owner-ideas.md`): none pitch-worthy yet, all five failed the `autonomy` check (need human
  labour). Best = **Shipper detention proof packets for freight brokers** (ROI 1.07×, the only idea where no competitor
  already sells it; needs 5–10 broker interviews to test the 20 hrs/month loss assumption). Others: permit-share reports for
  HVAC agencies (thin moat), checkout-outage loss reports (no one pays it back), contingency ad-invoice recovery (−285% margin,
  human work), rent-notice engine (ROI 0.59×, already sold, legal risk). Defects D1–D5 logged. Build round `tuning-3`
  (`docs/superpowers/plans/2026-10-19-tuning-3.md`): funnel (skip past kills, already-sold context, novelty/crowdedness in
  screen), per-sector research, plus D1–D4 fixes.
- **2026-10-19:** Tuning-3 built on `tuning-3` (TDD, 310 → 368 tests, typecheck green; no live run, no migration).
  Screen: skips candidates at cosine ≥ 0.75 to any `gated_out` idea; `screen.v2` also lists up to 8 known competitors,
  and ranking is `(7 criteria + novelty) / 8 − min(1, 0.25 × competitors)`. Ideate (`ideate.v6`): untrusted
  `<already-sold>` (past `generic` kills with the gate's reason) and `<already-covered>` (ideas with cases), 15 each.
  Harvest (`harvest-research.v4`): one research call per sector (open: the 6 picked; sector: up to 8;
  `researchSearchesPerSector`, default 3), owner/trade sources preferred; tech forums only when a software-adjacent
  sector is chosen; sector names are treated as untrusted (capped, wrapped in `<sector>`). Fixes: D1 a percentage next
  to fee vocabulary ("20% fee", "15 percent of recovered credits") counts as a published price, a bare one ("20%",
  "99.9% uptime", "30% discount") does not; D2/D3 unconfirmed competitor claims become `needs_review` ("check it
  yourself"), not ❌; D4 "For you to check" merges items with the same url + reason + label ("(N claims)"). D5 (gate counts evidence before verify) and other leftovers are in `docs/plan-1-followups.md`.
- **2026-10-19:** Run 4 on `tuning-3` (`docs/runs/2026-10-19-run-4.md`). Open run `7d0959e7`: 6 per-sector research
  calls (18 searches) + 8 tech-forum queries → 39 signals (run 3: 20), ~27/31 web signals vendor content marketing;
  13 ideas, 0 duplicates, 0 skips (max 0.552 to a past kill, 0.654 to a case), 8 below the cut, 5 at gate, **0 passed**
  (generic 4, autonomy 3). Already-sold 10 / already-covered 9 reached ideate.v6: 0 lead-capture ideas, max 0.694 to
  any past idea. Crowd penalty hit the cap for 12/13 ideas and changed no pick; novelty weight swapped 2 picks, incl.
  the only `generic` pass (Repair-Request Clock, killed on autonomy). No case; no defect; $4.91, 0 × 429. Owner
  decision: 3 of 4 generic kills reject "same product, new buyer" as positioning, contradicting ideate principle 3.
- **2026-10-19:** Owner decisions after run 4 (Read 1, 2, 3, 5, 6): **option (a)** (a new buyer or channel for an existing
  product is not a differentiator; ideation must name the incumbents and the functional gap, and the gate judges that
  gap), **drop the crowd penalty** (keep novelty ×2), **operator-voice evidence**. Built on `tuning-4`
  (`docs/superpowers/plans/2026-10-19-tuning-4.md`; TDD, 368 → 399 tests, typecheck green; no live run). Migration 0003
  (additive): `signals.voice`, `ideas.functional_gap`, `ideas.known_incumbents`. Prompts: `ideate.v7` (knownIncumbents ≤ 8,
  functionalGap ≤ 600; each signal shows its voice; only operator/neutral signals count toward minSignals), `gate.v2`
  (`generic` fails when an incumbent already provides the claimed function or the gap is only buyer/channel/packaging;
  the claim lines are unverified and must be checked against the research), `screen.v3` (7 scores only, total
  `(7 criteria + novelty) / 8`), `extract-signals.v3` (voice per signal), `harvest-research.v5` (owners, communities and
  neutral bodies first). **"Operator-voice only" is implemented as operator + neutral:** trade associations, regulators,
  statistics offices, journalists and analysts count as independent evidence; counting operators alone would starve a rule
  that needs several distinct sites. A security review then made voice **fail closed**: untagged (NULL, pre-tuning-4)
  signals do not count either (gate reasoning: "excluded N vendor, M untagged"), and a re-harvest backfills a NULL voice
  (never overwrites one). Consequence: re-gating old ideas fails `evidence` until their signals are re-harvested (all 121
  signals in the local DB are untagged). Owner ideas store no incumbents or gap.
- **2026-10-19:** Run 5 on `main` after tuning-4 (`docs/runs/2026-10-19-run-5.md`). Migration 0003 applied on start
  (backup `.data/pglite-backup-20261019-143949`; signals 121 / ideas 60 / cases 9 / claims 220 unchanged; 3 legacy
  signals got a voice backfilled). Open run `71862e9d`: 43 signals, voice operator 17 / neutral 0 / vendor 26 (web 5/0/26,
  wordpress.org 10/0/0, github 2/0/0); first owner-forum threads (lawnsite, electriciantalk). 8 ideas (2 asked per lens, 1
  each), 0 duplicates, 0 skips, 5 at gate, **0 passed**: autonomy 4, generic 2, control 2, regulation 1. Option (a) worked:
  all gaps are functional and both generic kills name an incumbent doing the claimed function (NCS, draw inspectors).
  Evidence rule excluded nothing at the gate (ideate cited operator signals only), but 5 of 8 ideas share the same 5
  signals and 4 of 5 entrants reach 3 units only through a GitHub problem-catalog issue mis-tagged `operator`. Screen:
  plain ranking gives the same 5; 0 re-asks. No case, no defect; $4.42, 0 × 429. Recommended next: feed all gate kill
  reasons (not only generic) and an autonomy rule into ideate; exclude problem catalogs from operator voice; sector-aware
  WordPress queries.
- **2026-10-19:** Plan 3 Task 9, first live validation run, freight case (`docs/runs/2026-10-19-validation-freight.md`).
  Backup `.data/pglite-backup-20261019-222601`; migrations 0004/0005 applied; signals 161 / ideas 68 / cases 9 / claims 220
  unchanged. Run 1 (main) $1.04: pack, 10 prospects, 4 emails, 12 drafts, landing. Run 2 (idempotency) $0.58: pack and
  landing kept, no duplicates, exit 0. Run 3 (fix branch, --refresh) $1.52. Final: 28 prospects, 13 emails, all
  self_published role inboxes (CASL: self_published 13 / unknown 15 / third_party 0), 39 drafts. Spot-check 14 sites: all
  real, ~7 good-fit brokers, 5 poor (asset carriers, 500-staff 3PLs). Drafts honest, only verified figures, `[SET SENDER …]`
  markers shown, no links; too generic and ask too much to send unedited. MVP spec 9–22 days, credible; pilot plan
  permission-first, tripwire fallback did not fire. Defects fixed TDD on `fix/validation-live` (584 tests green):
  research prompt said "CA, US" (read as California, 0 Canadian prospects), price lacked "$" ("1 per load processed"
  in a draft and the landing page), `carriers@` ranked above `info@`. Open: Cloudflare-obfuscated emails, re-ask reasons
  unlogged (43% of outreach calls), research re-runs every validate, 50-email gate vs ~11 usable addresses.
- **2026-10-19 (later):** second round on `fix/validation-live` (rulings P3-R23–R25), TDD, 584 → 604 tests green:
  outreach.v2 (case-derived intro line and yes/no question, freight wording only in labelled examples, one figures rule),
  `--redraft` limited to `new`/`drafted` prospects, stored footers of contacted prospects left untouched, Cloudflare
  `data-cfemail` decoding, usable-address count next to the emails_sent gate, pack-docs.v2 with per-country channels,
  one market-country helper, price-unit charset rule with a log line. No longer open: Cloudflare emails; the 50-email
  gate is now shown against the usable-address count (the threshold itself is still set before prospects exist). Still
  open: re-ask reasons unlogged, research re-runs every validate, JSON-LD emails, prospect yield below `--prospects`.
- **2026-10-20:** Plan 2 (Dashboard) built on `plan-2`, chunks A–C reviewed and green. Next.js app in `apps/web` (single
  owner, scrypt password + signed 7-day cookie, in-memory login rate limit), local Postgres via `docker-compose.yml`
  (127.0.0.1:5433), `npm run db:copy` (PGlite to Postgres, target must be empty), `npm run worker` executes runs queued
  from the dashboard (max 3 queued). Docs: `docs/dashboard.md`; `.env.example` lists every variable; dashboard
  follow-ups added to `docs/plan-1-followups.md`. Remaining: Task 16 (local acceptance with real Postgres), then merge.
  Open owner actions: start Docker Desktop, set sender identity, choose a password.
- **2026-10-20 (later):** Plan 2 Task 16, local acceptance (`docs/runs/2026-10-20-dashboard-acceptance.md`). Docker was
  not running, so a throwaway PGlite served by `@electric-sql/pglite-socket` stood in for Postgres. Everything temporary
  was deleted, and the real `.data/pglite` was not touched (fingerprint unchanged). The real DB is behind by migration
  0006 (the copy was migrated first). db:copy: every table ok, second run 0 inserted, no CRLF hash mismatch. Added
  `apps/web/scripts/acceptance.mjs` (a no-JS form driver with 13 checks that undoes its writes) and `check-bundle.mjs`;
  the package scripts had pointed at missing files. Result: 13/13 PASS on 9 cases and again on 10 cases. Worker
  `--once` on a dashboard-queued owner idea: queued → running → succeeded in 6 min 20 s, $4.37, case
  `ontario-ltb-form-change-alerts-for-small-landlords` (it exists only in the deleted throwaway DB; its Markdown export
  is in `output/cases/`). Guide fixes: use `npm run db:migrate` for a behind local DB; npm echoes `--to` URLs; new
  acceptance section. Observation: leaderboard `.by-toggle` links are 32px tall (rule: 44px). Not verified: Docker
  Postgres, advisory locks and SKIP LOCKED (`TEST_DATABASE_URL` test skipped), a real phone. A socket-multiplexer slot
  leak (fallback only) caused one spurious failed run.
- **2026-10-20 (Supabase):** owner chose a free Supabase database with web + worker on the PC (no Docker). Plan
  `docs/superpowers/plans/2026-10-20-supabase-local.md`, branch `supabase`, TDD. New web-safe
  `packages/core/src/db/pg-config.ts` (`@bcg/core/db/pg-config`) used by `createDb` and the web `getDb`: TLS from
  `DATABASE_SSL` only (URL `sslmode`, `ssl`, `sslrootcert`, `sslcert`, `sslkey`, `sslpassword`, `uselibpqcompat`,
  `sslnegotiation` removed, because pg 8.23 lets them override the `ssl` option), `ssl: false` set explicitly so `PGSSLMODE` cannot
  decide either, CA from `DATABASE_SSL_CA`, pool max 1–20, keep-alive and timeouts; the worker pool gained an
  idle-error listener. A test fails if `rejectUnauthorized: false` appears in `packages/core/src` or `apps/web`. Web
  env validates the three new variables. Guide: `docs/dashboard.md` "Free setup". Found while writing it:
  `npm run db:migrate` resolves `pglite://.data/pglite` inside `packages/core` (a new empty folder there, not the real DB), so the guide
  now uses `npm run gen -- runs` with the shell `DATABASE_URL` to migrate the local DB; `db:copy` migrates Supabase.
  Not verified live: the Supabase connection and its certificate chain.
  Review fix round 1 (SB-R1): `auto` is plain only if the URL host AND every `host` query value are local (pg uses
  the last `host`), `sslnegotiation` stripped too, `keepAliveInitialDelayMillis: 10000`, and the guard test also scans
  `packages/core/scripts` and fails on `checkServerIdentity` and any `NODE_TLS_REJECT_UNAUTHORIZED` assignment.
- **2026-10-21 (guided tour, Task 9):** repo documentation on `guided-tour`. New `README.md` (what PitchLab is, a
  Mermaid flow, requirements, quick start, CLI in brief, costs, safety stance, doc links), `docs/user-guide.md` (the 8
  tour chapters in prose, with what/why/what good looks like per step, "How to judge a case" and "When to kill") and
  `docs/architecture.md` (layout, pipeline diagram and stage table, validation steps, worker loop, tables by purpose,
  router and notional cost logging, security rules with reasons, merge gates, known limits). `docs/dashboard.md` now
  links the README and covers the Generate validation pack button, the example case and the tour; the pilot site's
  name was removed from it. New test `apps/web/test/docs-links.test.ts`: every relative link in the README and the
  four user-facing docs must resolve. Facts checked against code, not memory. Noted for a public release: no licence
  file yet, and the LLM setup assumes one gateway serving both the Anthropic and the OpenAI formats with one key.
- **2026-10-26 (benchmark, Task 5):** Progress page on branch `benchmark`. `apps/web/app/(app)/progress/page.tsx` reads
  `listBenchmarkPasses`, `passProgress` and `passCases`; `ProgressView` (server component) shows the scorecard (newest
  baseline plus up to 5 newest passes, ok/bad badges, muted for not measured or no data, an "incomplete" badge), the
  running-pass line with `AutoRefresh` every 10 s, the small-sample note and the "Score these cases" links. The small
  `RunBenchmarkForm` client component calls `runBenchmarkAction`, which takes no input, calls `queueBenchmarkPass` and
  maps `busy` and `pass_running` to the core refusal copy. New nav tab, `benchmark` glossary term, one tour step
  (`decide-progress`, anchor `progress-scorecard`; no tour anchor on the nav tab). Docs: README, user guide "Track
  idea quality", architecture "Benchmark" and `benchmark_passes`.
- **2026-10-27 (generation rebuild, Task 6):** scorecard metrics `consumerShare`, `modelVariety` and `easyStartHardCopy`
  are live (phase markers removed; old data reads `no_data`); `customerReturn` prefers `valueMultiple` and leaves out
  pays-nothing cases. `BENCHMARKS['bench-v2']` added and made current (bench-v1 frozen, bench-v2 frozen test). Glossary
  gained business model, value multiple and barriers. Docs updated: README, user guide, architecture, glossary,
  OWNER-TODO.
