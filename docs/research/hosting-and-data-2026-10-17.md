# Research: Hosting, Orchestration & Data Sources (2026-10-17)

Raw findings from two research agents. Prices were mostly checked via third-party mirrors of official pages, and
anything marked [unverified] was not confirmed first-party. Re-check before spending money.

## Hosting & orchestration

### Vercel
- Hobby: functions max 300s; cron ≤1/day (±59 min); ToS: "Hobby teams are restricted to non-commercial personal use only. All commercial usage of the platform requires either a Pro or Enterprise plan." Examples include "Advertising the sale of a product or service."
- Pro: $20/mo (1 seat, $20 usage credit, 1M req / 1TB CDN); functions 300s default, 800s max, 1800s extended (beta); cron per-minute, 100 jobs/project; unlimited domains.
- Vercel Daemons (public beta): always-on containers, $0.0212/GB-hr ≈ $15.50/mo for 1 GiB.
- Vercel Postgres is discontinued (migrated to Neon, Dec 2024); use the Marketplace.
- Sources: https://vercel.com/docs/functions/limitations · https://vercel.com/docs/cron-jobs/usage-and-pricing · https://vercel.com/docs/limits/fair-use-guidelines · https://vercel.com/docs/plans/pro-plan · https://vercel.com/docs/workflows/pricing · https://vercel.com/kb/guide/vercel-daemons

### Durable workflow engines (continuous ≈ 2,900 runs × 100 steps/mo)
| Engine | Free | Paid | Est. continuous |
|---|---|---|---|
| Vercel Workflow | 50K events/mo (Hobby) | $0.02/1K events + compute | ~$17 + compute |
| Inngest | 50K executions, 5 concurrent, hard stop | Pro $99/mo | $99 |
| Trigger.dev | $5 credit, 20 concurrent | Hobby $10 / Pro $50 + compute | ~$90–175 |
| Upstash Workflow | 1K steps/day | $1/100K steps | ~$3 |
| Cloudflare Workflows | 3K steps/day | $5/mo Workers Paid (500K steps) | ~$5 (runtime rewrite) |

### Always-on workers
Fly.io $2–4 · Railway Hobby $5 min (incl. $5 usage) · DigitalOcean $4–6 · Hetzner CX23 ~$6.50 (stock unverified) · Render worker $7 · Cloudflare Containers ~$7–12.

### Postgres
- Neon free: 100 CU-h/project/mo, 1GB, scale-to-zero. 24/7 awake ≈ 182 CU-h → ~$19/mo on Launch.
- Supabase free: 500MB, pauses after 1 week inactive; Pro $25.
- Railway: usage-based on Hobby (~$2–4 small).

### Landing pages & domains
- Vercel Pro: unlimited domains, hostname routing in one Next.js app.
- Cloudflare Pages free: 100 custom domains/project, 100 projects, 500 builds/mo, unlimited static requests; commercial use not forbidden per docs/staff (no explicit ToS clause found).
- Netlify free: commercial OK per blog; ~20 prod deploys/mo on 300 credits.
- Cloudflare Registrar: .com ≈ $10.46/yr, .ca ≈ $9.19/yr [unverified, third-party trackers].

## Data sources
- **Closed/avoid:** Reddit (commercial needs contract; new requests close 31 Oct 2026; public API ends Mar 2027), Bing Search API (retired Aug 2025), Google Custom Search (closed to new, ends 1 Jan 2027), G2/Trustpilot/Upwork/Indeed/LinkedIn (ToS ban scraping).
- **Search:** Brave $5/1k (~1k free; ToS bans storing results), Tavily ~$8/1k (1k free), Exa $7/1k ($20 + $10/mo free), Serper $1/1k (2.5k free), SerpApi $15–25/1k, Perplexity Search $5/1k.
- **Fetch:** Firecrawl 1k free, $19/5k pages · Jina Reader (free tier non-commercial) · ScrapingBee ~$49/250k credits · Browserbase $20/100 hrs · own Playwright.
- **Free signal sources:** HN Algolia, Stack Exchange (10k/day, CC BY-SA), GitHub issues (5k/hr), Apple App Store RSS, WordPress.org plugin forum RSS.
- **Prospects:** Google Places (New) Text Search ~$32–35/1k requests, ≤20 places each, monthly free allowance · Outscraper 500 free, $3/1k + $3/1k contacts · Apollo 75 free credits, $49–65/mo · Hunter 50 free, $49/2k, API on free · Snov paid-only API · People Data Labs $100/1k · BuiltWith $295+/mo · Wappalyzer $250+/mo · Corporations Canada open data/API (free) · StatCan ODBus (~450k businesses, 2022).
- **Email verification:** MillionVerifier ~$3.90/1k · NeverBounce $5–8/1k · ZeroBounce ~$19.50/1k small pack · Hunter ~$12/1k.

## CASL (not legal advice)
- Applies to CEMs sent from a computer in Canada (including to US recipients). Individual penalties up to $1M/violation. https://crtc.gc.ca/eng/com500/faq500.htm
- Implied consent via conspicuous publication: the person published it themselves, no "no unsolicited email" statement, and the message is relevant to their role. Burden of proof is on the sender. Third-party directories don't count (CompuFinder). https://crtc.gc.ca/eng/com500/guide.htm
- Each message: sender name, mailing address (valid 60 days), one other contact method, free unsubscribe working 60 days, honoured within 10 business days.
- CAN-SPAM: opt-out; honest headers/subject, physical address, opt-out working 30 days, honoured in 10 business days; up to $53,088/email. https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business
