# Plan 3: Validation Pack Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development (recommended) or executing-plans. TDD per task (failing test first, capture RED). No live LLM calls in tests.

**Goal:** `npm run gen -- validate <case-slug>` turns a case into things the owner can act on this week: an MVP spec, a pilot plan, an interview kit, a validation checklist, a prospect list (with where each email was found), personalised outreach drafts the owner sends themself, and a landing page. It also tracks outreach outcomes so the checklist updates from real results.

**Spec:** `docs/superpowers/specs/2026-10-17-business-case-generator-design.md` §6.3 (validation pack), §8 (data model), §11.4–11.6 (prospect data, CASL). Owner-confirmed: the system only drafts; the **owner sends** email (non-goal: sending). Landing pages: files now, live publishing later (needs the hosted app).

**Architecture:** new pipeline module `packages/core/src/validation/` (pure functions taking `StageDeps`-style deps), new tables via one additive migration, new CLI commands. Every step is idempotent (R20). Reuses the model router, guarded fetcher, banned-source filter, `wrapUntrusted`/`capField`, and Markdown escaping helpers.

## Global constraints

- All earlier rulings bind:
  - R9: no transforms in structured schemas.
  - R13: escape all LLM/web text at render (Markdown, HTML, CSV).
  - R15/R18/R19: untrusted text via `wrapUntrusted`/`capField`.
  - R20: idempotent per item, writes in transactions.
  - Pages are only ever fetched with the guarded GET-only `fetchPage`.
  - Banned sources via `isBannedSource`.
  - Never fetch or submit anything to gamersgetaway.ca; a `--pilot-site` value is only text in the pilot plan.
- **The system never sends email.** No SMTP, no mail APIs.
- **CASL** (spec §11.6): every outreach draft carries sender name, mailing address, one other contact method, and an unsubscribe line. Each email address stores its source URL, how it was found, and the capture date, plus a basis: `self_published` (found on the prospect's own site), `third_party`, or `unknown`. Only `self_published` addresses are put in the outreach export unless `--include-weak` is passed. Suppressed or unsubscribed addresses are never exported.
- **Spreadsheet safety:** every CSV cell that starts with `=`, `+`, `-`, `@`, tab or CR is prefixed with `'`; cells are quoted and escaped.
- Migrations are additive. Never modify the real `.data/pglite`; verify migrations on a temporary copy.
- Prompt files are new versioned files in `packages/core/prompts/`. LF endings.
- Commits end with the committing agent's Co-Authored-By trailer. The subagent report goes in the reply.

## Review Focus

1. **Hostile prospect pages:** HTML, scripts or prompt instructions in a prospect's site text must never reach Markdown/HTML/CSV output unescaped or steer the outreach prompt (wrap, cap, escape).
2. **Email extraction false positives:** `name@2x.png`, `user@example.com`, tracking pixels, obfuscated addresses, addresses on a different domain from the site. Expect: only plausible addresses kept, with their source URL.
3. **Re-running `validate`:** no duplicate prospects, drafts, pages or events; owner-entered tracking data (sent/replied marks, suppressions) is never overwritten.
4. **Missing sender settings:** drafts still generate, but export loudly warns and leaves visible `[SET SENDER …]` markers rather than silently omitting identification.
5. **Prospect source failure or empty result:** the command reports what it got (docs, landing page) and exits non-zero only for real failures, not for "found 0 prospects".

---

## File Structure

```
packages/core/src/validation/
  schema.ts            # Zod schemas: MvpSpec, PilotPlan, InterviewKit, Checklist, DraftEmails, LandingCopy
  settings.ts          # getSetting/setSetting, getSender(db) → Sender | missing keys
  pack-docs.ts         # generatePackDocs(deps, caseId)
  prospects.ts         # ProspectSource interface, webResearchSource, placesSource, csv import, upsertProspects
  emails.ts            # extractEmails(html, siteUrl), discoverEmails(deps, prospect)
  outreach.ts          # generateDrafts(deps, caseId), mark/suppress helpers, status counts
  landing.ts           # generateLanding(deps, caseId), renderLandingHtml(copy)
  checklist.ts         # computeChecklistStatus(db, caseId)
  export.ts            # exportValidation(db, caseId, outDir) → files
  run.ts               # runValidation(deps, caseId, opts)
packages/core/prompts/ pack-docs.v1.md prospect-research.v1.md prospect-extract.v1.md outreach.v1.md landing.v1.md
```

---

### Task 1: Schema, migration 0004, settings

- Tables (all with `createdAt`; ids uuid unless noted):
  - `validation_packs` (caseId unique FK, sections jsonb, model, promptVersion, updatedAt)
  - `prospects` (caseId FK, name, website, domain, location, country null, sizeNote null, fitReason, contactName null, contactRole null, email null, emailSourceUrl null, emailCapturedAt null, caslBasis enum `self_published|third_party|unknown` default `unknown`, source enum `web_research|places|csv|manual`, status enum `new|drafted|sent|replied|positive|meeting|not_interested|unsubscribed` default `new`; unique `(caseId, domain)`)
  - `outreach_drafts` (prospectId FK, kind enum `cold|followup1|followup2`, subject, body, model, promptVersion; unique `(prospectId, kind)`)
  - `outreach_events` (prospectId FK, type enum `sent|replied|positive|meeting|not_interested|unsubscribe|note`, note null, at timestamptz default now)
  - `suppressions` (email text pk (lowercased), reason, createdAt)
  - `landing_pages` (caseId unique FK, slug, html text, copy jsonb, publishedUrl null, updatedAt)
  - `landing_events` (landingPageId FK, type enum `visit|submit`, email null, company null, note null) — populated later by the hosted form endpoint
  - `settings` (key text pk, value jsonb)
- `settings.ts` exports `SENDER_KEYS = ['sender.name','sender.company','sender.address','sender.contact','sender.email']`, `getSetting(db,key)`, `setSetting(db,key,value)`, `getSender(db): Promise<{ sender: Sender | null; missing: string[] }>`. Required for a complete identity: name, address, contact (phone or website). Company and email optional.
- **Tests:** migration applies on `testDb`; unique `(caseId, domain)`; settings round trip; `getSender` reports missing keys.

### Task 2: Model stages and pack documents

- `ModelStage` gains `pack`, `prospect`, `outreach`, `landing`; defaults: `pack` claude-opus-5-5, `prospect` claude-sonnet-5-5 (web search), `outreach` claude-sonnet-5-5, `landing` claude-sonnet-5-5. `validateModelConfig` requires `prospect` to be a claude model (web search) and keeps all existing rules; update prices/tests.
- `schema.ts`:
  - `MvpSpecSchema`: `summary`, `features[{name, why, manualAtFirst: boolean}]` (3–8), `architectureSketch`, `buildEstimate {lowDays, highDays, assumptions}`, `fakeOrManualFirst[]`, `risks[]`, `packaging`.
  - `PilotPlanSchema`: `idealPilotCustomer`, `firstStep`, `steps[]` (3–8), `measures[{metric, successThreshold}]` (≥2), `timelineWeeks`, `permissionsAndRisks[]`.
  - `InterviewKitSchema`: `targetRoles[]`, `whereToFind[]`, `opening`, `questions[{question, whyAsk, listenFor}]` (≥8), `redFlags[]`.
  - `ChecklistSchema`: `gates[{id, description, metricKey, threshold}]` where `metricKey` ∈ `emails_sent|positive_replies|meetings|interviews_done|landing_conversion_pct`, with sensible defaults the model may adjust (e.g. 3 positive replies from 50 emails; 5% landing conversion).
- `pack-docs.ts`: `generatePackDocs(deps, caseId, opts: { pilotSite?: string })` makes ONE `router.structured('pack', …)` call with the case's sections (JSON via `wrapUntrusted`, capped ~30k chars) and writes `validation_packs`. Upsert by caseId. The prompt must require: first pilot step is "get the site owner's written permission and learn where leads land" whenever a `pilotSite` is given; no step may submit forms or send test leads to third-party sites without written permission; MVP spec starts from the smallest sellable version, with what to fake first.
- **Tests:** schemas reject too few questions / unknown metricKey; `generatePackDocs` stores once and re-run updates the same row; a `pilotSite` makes the prompt contain the permission rule; case text is wrapped and neutralised.

### Task 3: Prospect discovery

- `ProspectCandidate = { name, website, location, country?, sizeNote?, fitReason, sourceUrls[] }`; `interface ProspectSource { id: 'web_research'|'places'|'csv'; find(ctx): Promise<ProspectCandidate[]> }`.
- `webResearchSource` (default, no extra keys): `router.research('prospect', …)` for the case's `buyerType`/buyer text, market countries, `maxSearches` 6, asking for up to N real businesses (default 25) with website and why they fit; then one cheap `router.structured('extract', …)` call to the candidate schema (`prospect-extract.v1`). Validate in code: http(s) URL, not banned, not an IP, registrable domain via tldts; drop duplicates by domain; drop aggregators (linkedin, facebook, yelp, indeed… via the banned list plus a small `DIRECTORY_DOMAINS` list).
- `placesSource`: only when `GOOGLE_PLACES_API_KEY` is set (add to `Env` as optional). Text Search (New) with a field mask for name, website, address; cost logged with `logDataCall`. Injected `fetchImpl` for tests. Skipped with a log line when no key.
- `csv` import: `parseProspectCsv(text)` (RFC-4180 style, header row; columns `name,website` required; optional `email,email_source_url,contact_name,contact_role,location`); `source = 'csv'`; an email with `email_source_url` on the prospect's own domain gets `self_published`, otherwise `unknown`.
- `upsertProspects(db, caseId, candidates)`: insert on conflict `(caseId, domain)` do nothing for existing rows (never overwrite status, email or owner notes); returns inserted and existing counts.
- **Tests:** research output parsed and validated (bad URL, IP, banned and directory domains dropped; dedupe by domain); Places skipped without a key, parsed with one; CSV happy path, missing columns, quoted commas, formula-looking names preserved in DB; upsert twice leaves one row per domain and keeps a changed status.

### Task 4: Email discovery with CASL basis

- `extractEmails(html: string, siteUrl: string): { email, foundOn }[]`: from `mailto:` hrefs and visible text; lowercase; reject image/file-extension pseudo-addresses (`@2x.png`, `.jpg`, `.js`…), `example.*`/`test` domains, `noreply`/`no-reply`/`donotreply`; keep only addresses whose domain is the site's registrable domain, or a free-mail domain (gmail, outlook, hotmail, yahoo, icloud) shown on the site; decode simple obfuscation (`name [at] domain [dot] com`). Rank role inboxes below named people only for ordering; both allowed.
- `discoverEmails(deps, prospect)`: guarded GET of the homepage plus up to 2 of `/contact`, `/contact-us`, `/about` (stop when an address is found; 3 fetches max per prospect; 1 s politeness delay is not required). Needs the raw HTML: extend `fetchPage` to return a capped `html` field (≤ 500 KB) without changing existing behaviour, or add a sibling `fetchHtml` that shares the guard. Store the first good address: `email`, `emailSourceUrl` (the page it was on), `emailCapturedAt = now`, `caslBasis = 'self_published'`. Skip suppressed addresses. Never overwrite an owner-entered email.
- **Tests (injected fetch):** extraction positives (mailto, visible, `[at]`), negatives (png, example.com, noreply, other-domain), source URL and basis stored; at most 3 fetches; a suppressed address is not stored; an existing owner email is kept; hostile HTML (`<script>`, instructions in text) yields only the plain address.

### Task 5: Outreach drafts and tracking

- `outreach.v1.md` + schema `{ cold: {subject, body}, followup1: {...}, followup2: {...} }`. Inputs (all wrapped): the case's `pitch.emails` (angle and tone), the prospect's name/location/`fitReason` (capped), and a short plain-text snippet of the prospect's homepage title/description when available. Rules in the prompt: a specific, honest first line tied to the prospect; one concrete claim from the case (with its figure only if sourced); a low-friction ask (15-minute call or a reply); no invented facts about the prospect; plain text.
- `generateDrafts(deps, caseId)`: for each prospect with an email whose basis is `self_published` (or all with email when `includeWeak`), one `router.structured('outreach', …)` call; then code appends the identification footer to every body from `getSender`: name (and company), mailing address, contact, and the unsubscribe line `If you'd rather not hear from me, reply "unsubscribe" and I will remove you right away.` When sender settings are missing, the footer contains the literal markers `[SET SENDER NAME]`, `[SET SENDER ADDRESS]`, `[SET SENDER CONTACT]`. Upsert drafts by `(prospectId, kind)` in one transaction per prospect and set prospect status `drafted` only when it was `new`.
- Tracking helpers: `markOutreach(db, prospectRef, type, note?)` (`prospectRef` = id or email) writes an `outreach_events` row and moves status forward (`sent` → `replied` → `positive` → `meeting`; `not_interested`; `unsubscribe` → status `unsubscribed` + a `suppressions` row, lowercased email). Status never moves backward except to `unsubscribed`/`not_interested`. `outreachCounts(db, caseId)` returns counts by event type and distinct prospects.
- **Tests:** footer present on all three emails with settings; markers present without; drafts upserted once on re-run and keep edited status; weak-basis prospects excluded by default and included with the flag; unsubscribe suppresses and later exports skip it; status never regresses; hostile fitReason is neutralised in the prompt.

### Task 6: Landing page

- `landing.v1.md` + `LandingCopySchema`: `headline`, `subhead`, `whoItsFor`, `problem`, `howItWorks[3 × {title, text}]`, `offer`, `faq[3–5 × {q, a}]`, `ctaLabel`, `metaDescription`. Inputs: case summary, price, pitch objections (wrapped).
- `renderLandingHtml(copy, opts: { formEndpoint?: string, privacyContact: string })`: a deterministic template in code. **All copy is HTML-escaped; no model-supplied markup, links or scripts.** Self-contained: inline CSS (system fonts, light/dark via `prefers-color-scheme`, mobile-first, ≥16 px text), semantic HTML, one interest form (email required, company, "what would you pay per month?" optional, a required consent checkbox "I agree to be contacted about this service", and a short privacy note naming `privacyContact`). A small inline script posts the form as JSON to `formEndpoint` when set, otherwise shows "This form is not connected yet" — no external requests, no analytics. `<title>`, meta description, `lang="en"`.
- `generateLanding(deps, caseId)`: one call, render, upsert `landing_pages` by caseId (keep `publishedUrl`); the file is written by export.
- **Tests:** a headline containing `<script>alert(1)</script>` and `"onmouseover=` is escaped; no `<script>` other than the fixed inline one; form has the consent checkbox and endpoint attribute; re-run updates the same row and keeps `publishedUrl`; the HTML contains no `http://`/`https://` URLs other than ones from `formEndpoint`/`privacyContact` when those are URLs.

### Task 7: Checklist status and export

- `computeChecklistStatus(db, caseId)`: reads the stored checklist gates and computes the current value of each `metricKey` from tracked data: `emails_sent` = distinct prospects with a `sent` event; `positive_replies` = distinct prospects with `positive`; `meetings` likewise; `landing_conversion_pct` = submits ÷ visits (null when no visits); `interviews_done` = count of `note` events whose note starts with `interview:`. Result per gate: `{ id, description, value, threshold, state: 'pass'|'pending' }`.
- `exportValidation(db, caseId, outDir)` writes under `output/validation/<slug>/`:
  - `pack.md`: MVP spec, pilot plan, interview kit and checklist with current status (escape per R13).
  - `prospects.csv`: name, website, location, email, email source URL, captured date, CASL basis, status, fit reason.
  - `outreach.csv`: only prospects with a self-published (or `--include-weak`) email, not suppressed; columns prospect, email, subject and body for cold/followup1/followup2. CSV-injection-safe.
  - `outreach-drafts.md`: all drafts, escaped.
  - `landing/index.html`.
  - A top-of-file warning block in `pack.md` and `outreach-drafts.md` when sender settings are missing.
- **Tests:** checklist metrics from fixture events; CSV injection (a prospect named `=HYPERLINK(...)` is prefixed with `'`); suppressed and weak-basis prospects excluded from `outreach.csv` by default; warning block present without sender settings; hostile text escaped in `pack.md`.

### Task 8: CLI and orchestration

- `runValidation(deps, caseId, opts: { prospects?: number; skipProspects?: boolean; source?: 'web_research'|'places'; includeWeak?: boolean; pilotSite?: string })`: steps in order, each independently idempotent: pack docs → prospects → emails → drafts → landing → export. A failing step logs and stops with a non-zero exit code, but earlier steps' results stay saved. 0 prospects found is a warning, not a failure.
- Commands (`src/cli.ts`; `<case>` = slug):
  - `gen validate <case> [--prospects N] [--skip-prospects] [--source …] [--include-weak] [--pilot-site <url>]`
  - `gen prospects import <case> --file <csv>`
  - `gen outreach mark <prospect|email> <sent|replied|positive|meeting|not_interested|unsubscribe> [--note <text>]`
  - `gen outreach status <case>`
  - `gen config set <key> <value>` and `gen config get [key]` (settings table; only keys starting `sender.` or `landing.` are accepted; values are never echoed beyond what the user typed)
  - `gen export` keeps its current behaviour; `gen validate` calls the validation export.
- All paths resolve against `INIT_CWD ?? cwd` as the existing CLI does.
- **Tests:** CLI option parsing for the new commands (unit-level, without live calls); `runValidation` with a fake router and injected fetch runs all steps in order, is idempotent on re-run (same row counts), keeps owner-set statuses, and returns exit status ok with 0 prospects.

### Task 9: Live run on the freight case and docs

- With fake sender settings NOT set (so the warning path shows), run live: `npm run gen -- validate shipper-detention-proof-packets-for-freight-brokers --prospects 25`. Then inspect `output/validation/…`. Judge honestly:
  - Are the prospects real businesses that fit the buyer? How many have a self-published email?
  - Are the drafts specific and honest? Do the footers show the warning markers?
  - Is the MVP spec buildable by one engineer in the stated days?
  - Does the interview kit match "call 5–10 brokers about rejected shipper detention claims"?
- Write `docs/runs/2026-10-19-validation-freight.md` with these findings and cost.
- Update `docs/CONTEXT.md` and `docs/plan-1-followups.md` (what remains: live landing publish needs the hosted app; Places needs a key; email verification service not integrated).

### Self-review notes

- Spec §6.3 items: prospect list (T3–T4), outreach drafts + tracking (T5), landing page files (T6), MVP spec / pilot plan / interview kit / checklist (T2, T7), CSV export (T7). Live publish and landing analytics wait for the hosted app (Plan 2/4).
- Email verification (MillionVerifier) is deliberately out of scope for this plan.
