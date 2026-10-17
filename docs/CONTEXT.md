# Business Case Generator — Living Context

> Single source of truth for this long-running project. Read this first at the start of every session.
> Update it whenever a decision is made or something new is learned.

## Status
- **Phase:** **Plan 1 complete (branch `plan-1-core-pipeline`, 213 tests green); next: Plan 2 (Dashboard).** Live benchmark + first
  open run done 2026-10-17, results in `docs/runs/2026-10-17-benchmark.md` (benchmark: 3 of 4 §12.1 case criteria passed at run time; open run
  produced 1 case). The final-review fix wave then closed the evidence-integrity gap (signal/competitor links now verified + flagged, input flags in
  export) and added idea-diversity changes (ideate.v3, diversity-aware screen) — both **unvalidated live until the next run**.
  Follow-ups + deferred items: `docs/plan-1-followups.md`.
  Roadmap: Plan 1 Core pipeline (CLI) → Plan 2 Dashboard → Plan 3 Validation pack → Plan 4 Continuous + learning + deploy.
- **Repo:** https://github.com/ElvisOkereke/PitchLab (main)
- **Last updated:** 2026-10-17

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
