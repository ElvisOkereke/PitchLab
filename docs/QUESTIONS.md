# Discovery Questions

Answers get folded into `CONTEXT.md` under "Decisions Made" once given.

## Round 1 (2026-10-17)

### You & your constraints
1. Hours per week you can realistically put in, both total and per running business once it's live?
2. Budget you're willing to spend before a business pays for itself (per idea, and in total)?
3. Where are you based, and which markets do you want to sell into (geo, language, currency)?
4. "Unlimited tokens": Claude API, a Claude Max/Pro subscription, company access, or something else?
5. Will you hire help (VAs, contractors, a sales person), or should every business be runnable by you plus AI?

### Money targets
6. Monthly cashflow target and timeframe, and roughly what size of business you want to acquire?
7. Preferred deal shape: small tickets/many customers ($100–500/mo), mid ($1–5k/mo), or big contracts ($10k+)?

### Selling
8. How do you feel about doing sales yourself (cold email, LinkedIn, calls, in-person)? What's your hard no?
9. Industries, roles, or networks where you have insider knowledge or warm contacts?

### What counts as a good idea
10. Name one or two ideas (yours or seen elsewhere) that hit the bar, and one that's "too generic."
11. Delivery model: done-for-you service, productised service (fixed scope and price), SaaS, or open to anything?
12. Anything off-limits: regulated industries (health/finance/legal), grey-area stuff, things you find boring?

### The generator itself
13. What must a business case contain for you to act on it the next day?
14. How often should it run, and how many cases per run?
15. How should it run: a command in Claude Code, a scheduled job, a web app/dashboard, or other?
16. Should it go past the written case into validation (prospect lists, outreach drafts, landing page, MVP spec)?

**Answers:** Folded into CONTEXT.md → "Decisions Made" (2026-10-17).

## Round 2 (2026-10-17)
1. Fuelix is from your employer: have you checked your contract or policy on side businesses and using it? Would you get a personal API key, at least for anything customers touch?
2. Should the generator run your lead-flow idea through the full pipeline first, as a benchmark and possibly your first real case?
3. Once a business is live, how many hours a week of your time is acceptable before it no longer counts as "autonomous"?
4. Is "compliance-driven demand" OK? That means the customer faces a rule, but you need no license to serve them (e.g. accessibility audits).
5. Should the dashboard run only on your machine, or be hosted so you can check it from your phone?
6. Prospect geography: Canada + US, English only?

**Answers:** Folded into CONTEXT.md → "Round 2 decisions" (2026-10-17).

## Round 3: How it gets built (2026-10-17)
1. Any stack preferences, or my call? (Default: TypeScript + Next.js + Postgres + background worker.)
2. Hosting: any platform you already use, and a rough monthly ceiling?
3. Fuelix: can you call it from a server with an API key? Is it OpenAI-compatible? Which models and rate limits?
4. Paid data: OK to spend on a web-search API and prospect data, or free sources only at first?
5. Outreach: drafts only (you send), or should the system send? Sending means a separate domain, warm-up, and CASL compliance.
6. Landing pages: auto-publish to live URLs to measure real interest, or just generate the files?
7. Continuous mode: a daily spend/run cap, or let it rip?
8. Feedback: quick keep/kill + one-line reason, or score each case on several criteria?

**Answers:** Folded into CONTEXT.md → "Round 3 decisions" (2026-10-17).

## Round 4: From the builder check (2026-10-17)
1. Hosting: Option A (Railway + Cloudflare Pages, ~$10–15/mo) or Option C (dashboard on Vercel Pro, worker on Railway, ~$25–35)? Either way, a plain Node worker with a Postgres queue. Or Option B (all Vercel)?
2. Fuelix volume: is there a known quota/monthly ceiling? If not, OK to start continuous mode with conservative caps and raise them?
3. Game truck site: URL, platform/form plugin, where leads land (inbox/CRM), and permission to send test leads through the live form? (Can be supplied later as run inputs.)

**Answers:** Folded into CONTEXT.md → "Round 4 decisions" (2026-10-17).
