# Plan 1: Core Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A command-line business-case generator that runs the full pipeline (harvest → ideate → dedupe → screen → gate → deep case → verify → score), stores everything in Postgres, exports cases as Markdown, and passes the lead-flow benchmark run.

**Architecture:** An npm-workspaces TypeScript monorepo. All pipeline logic lives in `packages/core` so the dashboard (Plan 2) and worker (Plan 4) can import it. LLM calls go through a model router with two adapters: Anthropic-format and OpenAI-format, both pointed at Fuelix. Each pipeline stage is a function that takes injected dependencies and persists its output, so a run can resume from its last completed stage. Tests use in-memory PGlite (embedded Postgres with pgvector). Production uses a real Postgres via `DATABASE_URL`.

**Tech Stack:** Node 22, TypeScript (strict, ESM), npm workspaces, Vitest, Drizzle ORM + drizzle-kit, PGlite (`@electric-sql/pglite` + `/vector`) for local/test, `pg` for production, `@anthropic-ai/sdk`, `openai`, `zod` v4, `linkedom` + `@mozilla/readability`, `fast-xml-parser`, `commander`, `p-limit`.

**Spec:** `docs/superpowers/specs/2026-10-17-business-case-generator-design.md` (read it, especially §5, §9, §11, §12). Living context: `docs/CONTEXT.md`.

**Roadmap (separate plans, written after this one ships):** Plan 2 Dashboard (auth, board, case tabs, runs, scoring UI) · Plan 3 Validation pack (prospects, outreach + CASL, landing pages, MVP spec, pilot plan, interview kit) · Plan 4 Continuous mode + learning (pg-boss worker, limits, taste profile, calibration, allocation) + Railway/Cloudflare deploy. The full benchmark acceptance (§12.1: validation pack + pilot plan) completes in Plan 3. Plan 1 covers the case itself.

## Global Constraints

- Secrets only from environment variables. `.env` is git-ignored, and `.env.example` lists names with no values. Never log key values.
- Fuelix: Anthropic adapter `baseURL = LLM_ANTHROPIC_BASE_URL` (default `https://api.fuelix.ai`), auth via **Bearer** (`authToken`). OpenAI adapter `baseURL = LLM_OPENAI_BASE_URL` (default `https://api.fuelix.ai/v1`). One key: `LLM_API_KEY`.
- Calls on the OpenAI route use `max_tokens ≥ 4000` (reasoning models return empty `choices` otherwise).
- **Arithmetic is done by code** (`calc/`). LLM output never supplies a computed total.
- **The pipeline only ever issues HTTP GET to third-party sites.** It never submits forms or POSTs to non-API hosts.
- **The gate and final scoring must use a different model family than ideation.** Config validation fails at startup otherwise.
- Every `llm_calls`, `cases`, `scores`, and `gate_verdicts` row records `model` and `prompt_version`.
- Owner-seeded ideas (`seedType: 'idea'`): the gate is **advisory** (the case is always produced, with `gateFlags` listing failed checks). Generated ideas: a failed gate is a hard kill.
- Never use the following sources: Reddit, Bing, Google Custom Search, G2, Capterra, Trustpilot, Upwork, Indeed, LinkedIn.
- Default market `ca-us`: countries `['CA','US']`, language `en`, currency `USD` [Claude's call: most North American B2B software is priced in USD]. Market is a DB row, never hard-coded in stage logic.
- The repo path contains spaces (`Y:\CODING PROJECTS\...`). Quote paths in scripts.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Malformed or partial LLM JSON:** the router re-asks with the validation error (max 2 retries), then throws `StructuredOutputError`. The run fails at that stage and stays resumable. *(Test in Task 3.)*
2. **Gateway 429/5xx/timeout mid-run:** backoff honours `retry-after`. On resume, completed stages are not re-run and rows are not double-inserted. *(Tests in Task 3 and Task 13.)*
3. **Cited URL unreachable, paywalled, or JS-only:** the claim is marked `unreachable`, not `unsupported`. The pipeline continues. *(Test in Task 12.)*
4. **Degenerate numbers:** price ≤ delivery cost means breakeven is `null` with reason `"price does not cover delivery cost"`. Zero buyers means market = 0, not NaN. An input with neither source nor assumption is rejected by the schema. *(Tests in Task 6.)*
5. **Repeats across runs:** an idea ≥ the similarity threshold to any past idea (including killed ones) is marked `duplicate` and not researched. The same signal URL+quote harvested twice gives one row. *(Tests in Task 7 and Task 9.)*

---

## File Structure

```
package.json                     # npm workspaces root, scripts proxy to core
tsconfig.base.json
.gitignore  .env.example
packages/core/
  package.json  tsconfig.json  vitest.config.ts  drizzle.config.ts
  drizzle/                       # generated SQL migrations
  prompts/                       # versioned prompt files: <name>.v<N>.md
  src/
    config/env.ts                # loadEnv(): typed env
    config/models.ts             # ModelStage → model id, family(), validateModelConfig()
    config/prices.ts             # notional $/Mtok table, costOf()
    db/schema.ts                 # all Drizzle tables
    db/client.ts                 # createDb(url) → Db (pglite:// or postgres://)
    db/migrate.ts                # runMigrations(db)
    db/seed.ts                   # seedDefaults(db): market ca-us + 8 lenses
    llm/types.ts                 # ProviderAdapter, AdapterRequest/Response, Source, CallCtx
    llm/anthropic.ts             # createAnthropicAdapter()
    llm/openai.ts                # createOpenAIAdapter()
    llm/retry.ts                 # withRetry(), isRetryable()
    llm/router.ts                # createRouter() → ModelRouter
    llm/prompts.ts               # loadPrompt(name) → {version, render(vars)}
    tools/fetch-page.ts          # fetchPage(url) GET-only → {status, finalUrl, text, title}
    tools/data-calls.ts          # logDataCall()
    tools/sources/types.ts       # SignalSource, RawItem
    tools/sources/{hn,stackexchange,github,wordpress,appstore}.ts
    tools/sources/index.ts       # buildSources(env)
    calc/schema.ts               # Sourced, NumberInputs (zod)
    calc/numbers.ts              # computeNumbers(inputs) → NumberResults
    case/schema.ts               # CaseSections (zod), Criterion
    case/export-markdown.ts      # caseToMarkdown()
    pipeline/types.ts            # RunConfig, StageDeps, STAGES
    pipeline/{harvest,ideate,dedupe,screen,gate,deep-case,verify,score}.ts
    pipeline/run.ts              # createRun(), executeRun() (resumable)
    cli.ts                       # `gen` CLI
  test/helpers/{db.ts,fake-router.ts,fixtures/}
  test/**/*.test.ts              # mirrors src/
```

---

### Task 1: Repo scaffold and typed env

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `.gitignore`, `.env.example`, `packages/core/{package.json,tsconfig.json,vitest.config.ts}`, `packages/core/src/config/env.ts`
- Test: `packages/core/test/config/env.test.ts`

**Interfaces:**
- Produces: `loadEnv(source?: Record<string,string|undefined>): Env` where `Env = { LLM_API_KEY: string; LLM_ANTHROPIC_BASE_URL: string; LLM_OPENAI_BASE_URL: string; DATABASE_URL: string; LLM_MAX_CONCURRENCY: number; MODEL_OVERRIDES: Partial<Record<ModelStage,string>>; GITHUB_TOKEN?: string; STACKEXCHANGE_KEY?: string }`. Throws `Error` naming each missing or invalid var. It never includes values in the message.

- [ ] **Step 1:** `git init`. Create `.gitignore` with `node_modules/`, `.env`, `.data/`, `output/`, `.superpowers/`, `dist/`. Create root `package.json` (`"private": true, "type": "module", "workspaces": ["packages/*","apps/*"]`, scripts `test`, `gen`, `db:migrate` proxying to `-w packages/core`), and `tsconfig.base.json` (strict, `module`/`moduleResolution` `NodeNext`, target ES2023).
- [ ] **Step 2:** In `packages/core`, install `zod vitest typescript tsx @types/node`. Add scripts: `"test": "vitest run"`, `"gen": "tsx src/cli.ts"`, `"db:migrate": "tsx src/db/migrate.ts"`.
- [ ] **Step 3: Write the failing test**

```ts
import { loadEnv } from '../../src/config/env';
it('applies defaults', () => {
  const env = loadEnv({ LLM_API_KEY: 'k' });
  expect(env.LLM_ANTHROPIC_BASE_URL).toBe('https://api.fuelix.ai');
  expect(env.LLM_OPENAI_BASE_URL).toBe('https://api.fuelix.ai/v1');
  expect(env.DATABASE_URL).toBe('pglite://.data/pglite');
  expect(env.LLM_MAX_CONCURRENCY).toBe(4);
  expect(env.MODEL_OVERRIDES).toEqual({});
});
it('names missing vars without leaking values', () => {
  expect(() => loadEnv({ LLM_MAX_CONCURRENCY: 'abc' })).toThrow(/LLM_API_KEY/);
});
it('parses MODEL_OVERRIDES JSON', () => {
  expect(loadEnv({ LLM_API_KEY: 'k', MODEL_OVERRIDES: '{"gate":"gemini-3.1-pro"}' }).MODEL_OVERRIDES).toEqual({ gate: 'gemini-3.1-pro' });
});
```

- [ ] **Step 4:** Run `npm test -w packages/core`. Expected: FAIL (module not found).
- [ ] **Step 5:** Implement `loadEnv` with a zod schema (`source` defaults to `process.env`). Load `.env` in `cli.ts` only (Node 22 `process.loadEnvFile`), not here.
- [ ] **Step 6:** Run the tests. Expected: PASS. Create `.env.example` with every var name, empty values.
- [ ] **Step 7:** Commit `chore: scaffold monorepo and typed env`.

---

### Task 2: Database schema, client, migrations, seed

**Files:**
- Create: `packages/core/src/db/{schema.ts,client.ts,migrate.ts,seed.ts}`, `packages/core/drizzle.config.ts`, `packages/core/drizzle/*` (generated), `packages/core/test/helpers/db.ts`
- Test: `packages/core/test/db/db.test.ts`

**Interfaces:**
- Produces:
  - `createDb(url: string): Promise<Db>`. `pglite://<path>` or `pglite://memory` → PGlite with the `vector` extension. `postgres://…` → `pg` Pool. `Db` is the Drizzle database type, shared by both.
  - `runMigrations(db: Db): Promise<void>` (runs `CREATE EXTENSION IF NOT EXISTS vector` first).
  - `seedDefaults(db: Db): Promise<void>` (idempotent upsert).
  - Test helper `testDb(): Promise<Db>`: in-memory, migrated, seeded.
- Tables (exported from `schema.ts`, camelCase TS / snake_case SQL). All ids are `uuid` default random unless noted. All tables have `createdAt`.
  - `markets` (id text pk, name, countries text[], language, currency, sectors text[])
  - `lenses` (id text pk, name, pattern, promptHint, active bool default true, version int default 1)
  - `runs` (config jsonb `RunConfig`, status enum `queued|running|succeeded|failed`, currentStage text null, error text null, costUsd numeric default 0, startedAt, finishedAt)
  - `runStages` (runId fk, stage text, status enum `running|done|failed`, output jsonb, startedAt, finishedAt; pk (runId, stage))
  - `signals` (runId fk null, marketId fk, source text, url, title, quote, sector null, painType null, publishedAt null, embedding vector(1536) null; unique (url, md5(quote)) via a `quoteHash` text column)
  - `ideas` (runId fk, lensId fk null, origin enum `generated|owner`, title, oneLiner, buyer, problem, solution, signalIds uuid[], embedding vector(1536) null, screenScores jsonb null, screenTotal real null, status enum `candidate|duplicate|screened_out|gated_out|advanced`, duplicateOf uuid null)
  - `gateVerdicts` (ideaId fk, check enum `generic|regulation|control|autonomy|reachability|evidence`, pass bool, reasoning, sources jsonb, model, promptVersion)
  - `cases` (ideaId fk unique, slug unique, title, stage enum `new|validating|pilot|live|killed` default `new`, sections jsonb `CaseSections`, killReason null, gateAdvisory bool, model, promptVersion, updatedAt)
  - `claims` (caseId fk, section text, text, sourceUrl, quote null, verified enum `unverified|verified|unsupported|unreachable` default `unverified`, confidence real null, checkedAt null)
  - `scores` (caseId fk, criterion enum `pain|roi|evidence|speed|autonomy|novelty|reach|gut`, value int (1–5 check), note, by enum `ai|owner`, model null, promptVersion null)
  - `llmCalls` (runId null, stage, provider, model, inputTokens, outputTokens, searchRequests, costUsd numeric, latencyMs, promptVersion, ok bool, error null)
  - `dataCalls` (runId null, provider, endpoint, costUsd numeric default 0, ok bool)
- Seed: market `ca-us` (name "Canada + US", countries `['CA','US']`, language `en`, currency `USD`, sectors: web design agencies, digital marketing agencies, managed IT providers, HVAC, plumbing, electrical, roofing, landscaping, dental clinics, physiotherapy clinics, veterinary clinics, law firm operations, accounting/bookkeeping firms, property management, event rentals, auto repair, restaurants/multi-location food, ecommerce brands (Shopify), franchise groups, logistics/freight brokers). Lenses: the 8 in spec §5.2. Ids: `silent-failure`, `aggregator`, `manual-to-productised`, `money-leak`, `platform-shockwave`, `compliance-demand`, `public-data-decision`, `review-gap`. Copy name and pattern from the spec. `promptHint` is one sentence telling the ideation model how to apply the lens.

- [ ] **Step 1:** Install `drizzle-orm pg @electric-sql/pglite`, dev `drizzle-kit @types/pg`.
- [ ] **Step 2: Write the failing test**

```ts
it('migrates, seeds idempotently, and supports vector similarity', async () => {
  const db = await testDb();
  await seedDefaults(db);                              // second call: no duplicates
  expect(await db.select().from(lenses)).toHaveLength(8);
  expect((await db.select().from(markets))[0].currency).toBe('USD');
  const [run] = await db.insert(runs).values({ config: {} as any, status: 'queued' }).returning();
  const v = Array(1536).fill(0); v[0] = 1;
  await db.insert(ideas).values({ runId: run.id, origin: 'generated', title: 't', oneLiner: 'o', buyer: 'b', problem: 'p', solution: 's', signalIds: [], embedding: v, status: 'candidate' });
  const rows = await db.select({ sim: sql<number>`1 - (${cosineDistance(ideas.embedding, v)})` }).from(ideas);
  expect(rows[0].sim).toBeCloseTo(1);
});
it('rejects duplicate signal url+quote', async () => {
  const db = await testDb();
  const s = { marketId: 'ca-us', source: 'hn', url: 'https://x', title: 't', quote: 'q', quoteHash: 'h' };
  await db.insert(signals).values(s);
  await expect(db.insert(signals).values(s)).rejects.toThrow();
});
```

- [ ] **Step 3:** Run the test. Expected: FAIL.
- [ ] **Step 4:** Implement `schema.ts` and `client.ts`. Run `npx drizzle-kit generate` to produce the migration. Implement `migrate.ts` (Drizzle migrator for the matching driver, and a CLI entry when run directly), `seed.ts`, and `test/helpers/db.ts`.
- [ ] **Step 5:** Run the test. Expected: PASS.
- [ ] **Step 6:** Commit `feat(db): schema, migrations, seed defaults`.

---

### Task 3: Model router (adapters, structured output, retries, cost logging)

**Files:**
- Create: `packages/core/src/llm/{types.ts,anthropic.ts,openai.ts,retry.ts,router.ts}`, `packages/core/src/config/{models.ts,prices.ts}`, `packages/core/test/helpers/fake-router.ts`
- Test: `packages/core/test/llm/{router.test.ts,retry.test.ts,anthropic.test.ts,models.test.ts}`

**Interfaces:**
- Consumes: `Db`, `llmCalls` (Task 2); `Env` (Task 1).
- Produces:
  - `type ModelStage = 'extract'|'harvest'|'ideate'|'screen'|'gate'|'competitors'|'case'|'verify'|'score'|'embed'`
  - `DEFAULT_MODELS: Record<ModelStage,string>` = extract `claude-haiku-5-5`, harvest `claude-sonnet-5-5`, ideate `claude-opus-5-5`, screen `claude-haiku-5-5`, gate `gpt-6-sol`, competitors `claude-sonnet-5-5`, case `claude-opus-5-5`, verify `claude-sonnet-5-5`, score `gemini-3.1-pro`, embed `text-embedding-3-small`.
  - `family(model): 'claude'|'gpt'|'gemini'|'other'` (by prefix; `text-embedding-*` → `gpt`). `adapterFor(model)`: `claude` → anthropic, else openai.
  - `validateModelConfig(m)`: throws if `family(m.gate)===family(m.ideate)` or `family(m.score)===family(m.ideate)`, or if `harvest|competitors|case` is not `claude` (they use web search).
  - `costOf(model, usage): number` from a notional table in USD per 1M tokens (in/out): opus-5-5 5/25, sonnet-5-5 3/15, haiku-5-5 1/5, gpt-6-sol 2.5/15, gemini-3.1-pro 2/12, text-embedding-3-small 0.02/0, plus $10 per 1k web searches. Unknown model → 0 and one `console.warn`. File header comment: "Notional prices: Fuelix is employer-paid; edit freely."
  - `interface ProviderAdapter { complete(r: AdapterRequest): Promise<AdapterResponse>; embed(model: string, texts: string[]): Promise<{ vectors: number[][]; inputTokens: number }> }`
  - `AdapterRequest = { model: string; system?: string; messages: { role: 'user'|'assistant'; content: string }[]; maxTokens: number; jsonSchema?: { name: string; schema: object }; webSearch?: { maxUses: number } }`
  - `AdapterResponse = { text: string; json?: unknown; sources: Source[]; usage: { inputTokens: number; outputTokens: number; searchRequests: number } }`, `Source = { url: string; title?: string; citedText?: string }`
  - `CallCtx = { runId: string|null; promptVersion: string }`
  - `createRouter(opts: { adapters: { anthropic: ProviderAdapter; openai: ProviderAdapter }; db: Db; models: Record<ModelStage,string>; maxConcurrency: number }): ModelRouter` with:
    - `text(stage, { system?, prompt, maxTokens? }, ctx): Promise<string>`
    - `structured<T>(stage, { system?, prompt, schema: z.ZodType<T>, schemaName, maxTokens? }, ctx): Promise<T>`
    - `research(stage, { system?, prompt, maxSearches, maxTokens? }, ctx): Promise<{ text: string; sources: Source[] }>`
    - `embed(texts: string[], ctx): Promise<number[][]>`
  - `class StructuredOutputError extends Error { issues: string }`
  - `buildRouter(env: Env, db: Db): ModelRouter`: wires real adapters and `{...DEFAULT_MODELS, ...env.MODEL_OVERRIDES}`, then runs `validateModelConfig`.
  - Test helper `fakeRouter(script: { structured?: Partial<Record<ModelStage, unknown[]>>; research?: Partial<Record<ModelStage, {text:string;sources:Source[]}[]>>; text?: Partial<Record<ModelStage,string[]>>; embed?: (t: string[]) => number[][] })`: returns a `ModelRouter` that shifts queued responses per stage, throws when a queue is empty, and records `calls: { stage, kind, prompt }[]`. Structured responses go through `schema.safeParse`; a failure throws `StructuredOutputError`, just as the real router does after its re-asks.

Behaviour:
- **Anthropic adapter:** `new Anthropic({ baseURL, authToken: key, timeout: 15*60_000, maxRetries: 0 })`. Always use `client.messages.stream(params).finalMessage()`.
  - `jsonSchema` → one tool `{ name, description, input_schema }` + `tool_choice: { type: 'tool', name }`. `json` = that `tool_use` block's input.
  - `webSearch` → tool `{ type: 'web_search_20250305', name: 'web_search', max_uses }`. `sources` come from `web_search_tool_result` blocks (url, title) plus text-block `citations` (url, cited_text), deduped by url. `searchRequests` = `usage.server_tool_use?.web_search_requests ?? 0`.
- **OpenAI adapter:** `new OpenAI({ baseURL, apiKey: key, timeout: 15*60_000, maxRetries: 0 })`, `max_tokens = Math.max(r.maxTokens, 4000)`.
  - `jsonSchema` → `response_format: { type: 'json_object' }`, with `"Respond only with JSON matching this JSON Schema:\n" + JSON.stringify(schema)` appended to the system prompt. `json = JSON.parse(text)`.
  - `webSearch` → throw `Error('web search requires a claude model')`.
- **`withRetry(fn, { attempts: 5, baseMs: 1000 })`:** retries when `isRetryable(err)` (status 429/500/502/503/504/529, `ECONNRESET`, `ETIMEDOUT`, `APIConnectionError`). Delay = `retry-after` header seconds if present, else `baseMs·2^i` ± 20% jitter.
- **Router:**
  - Every adapter call goes through `p-limit(maxConcurrency)` and `withRetry`.
  - Every attempt inserts one `llmCalls` row: `ok=false` + error message on failure, `costUsd = costOf(...)`. The cost is added to `runs.costUsd` when `runId` is set.
  - `structured` converts the schema with `z.toJSONSchema(schema)`. On a JSON parse or zod failure it re-asks with the previous assistant output plus `"Your output was invalid: <issues>. Return corrected JSON only."`. Max 2 re-asks, then `StructuredOutputError`.
  - Default `maxTokens` = 8000. `research` default `maxTokens` = 16000.

- [ ] **Step 1:** Install `@anthropic-ai/sdk openai p-limit`.
- [ ] **Step 2: Write the failing tests**

```ts
// models.test.ts
it('rejects same-family gate and ideation', () => {
  expect(() => validateModelConfig({ ...DEFAULT_MODELS, gate: 'claude-sonnet-5-5' })).toThrow(/gate/);
});
it('rejects a non-claude research stage', () => {
  expect(() => validateModelConfig({ ...DEFAULT_MODELS, case: 'gpt-6-sol' })).toThrow(/case/);
});
// retry.test.ts
it('honours retry-after and gives up after 5 attempts', async () => {
  vi.useFakeTimers();
  const err = Object.assign(new Error('rate'), { status: 429, headers: { 'retry-after': '2' } });
  const fn = vi.fn().mockRejectedValue(err);
  const p = withRetry(fn, { attempts: 5, baseMs: 1000 }); p.catch(() => {});
  await vi.advanceTimersByTimeAsync(2000 * 5);
  await expect(p).rejects.toThrow('rate'); expect(fn).toHaveBeenCalledTimes(5);
});
it('does not retry a 400', async () => {
  const fn = vi.fn().mockRejectedValue(Object.assign(new Error('bad'), { status: 400 }));
  await expect(withRetry(fn, { attempts: 5, baseMs: 1 })).rejects.toThrow(); expect(fn).toHaveBeenCalledTimes(1);
});
// router.test.ts (scripted fake ProviderAdapter defined in the test file)
it('re-asks once on invalid JSON, logs both calls with cost', async () => {
  const db = await testDb(); const a = scriptedAdapter([{ json: { n: 'x' } }, { json: { n: 3 } }]);
  const r = createRouter({ adapters: { anthropic: a, openai: a }, db, models: DEFAULT_MODELS, maxConcurrency: 2 });
  expect(await r.structured('screen', { prompt: 'p', schema: z.object({ n: z.number() }), schemaName: 'x' }, { runId: null, promptVersion: 'screen.v1' })).toEqual({ n: 3 });
  expect(a.requests[1].messages.at(-1)!.content).toMatch(/invalid/);
  const calls = await db.select().from(llmCalls);
  expect(calls).toHaveLength(2); expect(calls[0].promptVersion).toBe('screen.v1');
});
it('throws StructuredOutputError after 2 re-asks', async () => {
  const db = await testDb(); const a = scriptedAdapter([{ json: {} }, { json: {} }, { json: {} }]);
  const r = createRouter({ adapters: { anthropic: a, openai: a }, db, models: DEFAULT_MODELS, maxConcurrency: 1 });
  await expect(r.structured('screen', { prompt: 'p', schema: z.object({ n: z.number() }), schemaName: 'x' }, { runId: null, promptVersion: 'v' })).rejects.toBeInstanceOf(StructuredOutputError);
});
it('routes gate to the openai adapter and research to anthropic', async () => { /* assert which scripted adapter received the request */ });
// anthropic.test.ts: map a recorded finalMessage fixture (test/helpers/fixtures/anthropic-websearch.json, containing
// server_tool_use, web_search_tool_result, and text blocks with citations) → AdapterResponse.sources deduped, searchRequests = 1
```

- [ ] **Step 3:** Run the tests. Expected: FAIL.
- [ ] **Step 4:** Implement the files listed. Write the Anthropic fixture by hand from the response block shape (types `server_tool_use`, `web_search_tool_result` with `content[].url/title`, and `text` with `citations[].url/cited_text`). Factor the adapter's response mapping into an exported `mapAnthropicMessage(msg)` so the fixture test calls it directly.
- [ ] **Step 5:** Run the tests. Expected: PASS.
- [ ] **Step 6: Live smoke check** (not part of `npm test`): add a `packages/core/scripts/smoke-llm.ts` that calls `text('extract')`, `structured('gate')`, `research('harvest', maxSearches 1)`, and `embed` once each via `buildRouter`. Run it with `npx tsx scripts/smoke-llm.ts`. Expected: four OK lines, and an embedding length of 1536.
- [ ] **Step 7:** Commit `feat(llm): model router with Fuelix adapters, retries, cost logging`.

---

### Task 4: GET-only page fetcher

**Files:**
- Create: `packages/core/src/tools/fetch-page.ts`, `packages/core/src/tools/data-calls.ts`
- Test: `packages/core/test/tools/fetch-page.test.ts`

**Interfaces:**
- Produces:
  - `fetchPage(url: string, opts?: { timeoutMs?: number; maxBytes?: number; fetchImpl?: typeof fetch }): Promise<PageResult>` with defaults 15000 ms and 2_000_000 bytes. `PageResult = { ok: boolean; status: number; finalUrl: string; title: string; text: string; reason?: 'http_error'|'timeout'|'too_large'|'not_html'|'network'|'blocked_scheme' }`. It never throws.
  - `logDataCall(db, { runId, provider, endpoint, costUsd?, ok }): Promise<void>`.
- Rules: method is always `GET`; only the `http:`/`https:` schemes are allowed. User-Agent `BusinessCaseGen/0.1 (research; contact: owner)`. Redirects followed (max 5). Body read as a stream, aborting past `maxBytes`. HTML → `linkedom` + `Readability` → `text`. Fall back to `body.textContent` if Readability returns null. `text/plain` passes through. Anything else → `not_html`.

- [ ] **Step 1:** Install `linkedom @mozilla/readability`.
- [ ] **Step 2: Write the failing tests** (inject `fetchImpl`)

```ts
it('extracts readable text and title', async () => {
  const r = await fetchPage('https://a.test', { fetchImpl: htmlFetch('<title>T</title><article><p>Leads vanished after the update.</p></article>') });
  expect(r.ok).toBe(true); expect(r.title).toBe('T'); expect(r.text).toContain('Leads vanished');
});
it('reports http errors, timeouts, non-html, oversize and bad schemes without throwing', async () => {
  expect((await fetchPage('https://a.test', { fetchImpl: statusFetch(403) })).reason).toBe('http_error');
  expect((await fetchPage('https://a.test', { timeoutMs: 10, fetchImpl: hangingFetch() })).reason).toBe('timeout');
  expect((await fetchPage('https://a.test', { fetchImpl: typedFetch('application/pdf') })).reason).toBe('not_html');
  expect((await fetchPage('https://a.test', { maxBytes: 10, fetchImpl: htmlFetch('x'.repeat(100)) })).reason).toBe('too_large');
  expect((await fetchPage('file:///etc/passwd')).reason).toBe('blocked_scheme');
});
it('only ever sends GET', async () => { const f = htmlFetch('<p>x</p>'); await fetchPage('https://a.test', { fetchImpl: f }); expect(f.mock.calls[0][1].method).toBe('GET'); });
```

- [ ] **Step 3:** Run. Expected: FAIL. **Step 4:** Implement. **Step 5:** Run. Expected: PASS.
- [ ] **Step 6:** Commit `feat(tools): GET-only page fetcher`.

---

### Task 5: Free signal sources

**Files:**
- Create: `packages/core/src/tools/sources/{types.ts,hn.ts,stackexchange.ts,github.ts,wordpress.ts,appstore.ts,index.ts}`, fixtures in `packages/core/test/helpers/fixtures/sources/`
- Test: `packages/core/test/tools/sources.test.ts`

**Interfaces:**
- Produces (sources do not touch the DB; `harvest` logs their calls):
  - `RawItem = { source: string; url: string; title: string; text: string; publishedAt: Date|null }`
  - `interface SignalSource { id: string; search(query: string, opts: { limit: number; fetchImpl?: typeof fetch }): Promise<RawItem[]> }`. On HTTP failure it returns `[]` and calls `console.warn`; it never throws.
  - `buildSources(env: Env): SignalSource[]`
- Endpoints:
  - **hn:** `https://hn.algolia.com/api/v1/search?query=<q>&tags=(story,comment)&hitsPerPage=<limit>`. url = `https://news.ycombinator.com/item?id=<objectID>`, text = `comment_text ?? story_text ?? title`, with HTML stripped.
  - **stackexchange:** `https://api.stackexchange.com/2.3/search/excerpts?order=desc&sort=relevance&q=<q>&site=<site>&pagesize=<limit>` (+`&key=` if set), for sites `webmasters`, `wordpress`, `softwarerecs`. text = `excerpt`.
  - **github:** `https://api.github.com/search/issues?q=<q>+is:issue&per_page=<limit>` (Bearer `GITHUB_TOKEN` if set). text = first 2000 chars of `body`.
  - **wordpress:** query = a plugin slug. `https://wordpress.org/support/plugin/<slug>/feed/`, parsed with `fast-xml-parser`. Default slugs: `contact-form-7`, `wpforms-lite`, `ninja-forms`, `gravityforms`, `wp-mail-smtp`, `fluentform`, `formidable`.
  - **appstore:** query = numeric app id. `https://itunes.apple.com/<cc>/rss/customerreviews/id=<id>/sortby=mostrecent/json` for `cc` in market countries (lowercase). Keep reviews rated ≤3.

- [ ] **Step 1:** Install `fast-xml-parser`. Save one small real-shaped JSON/XML fixture per source (hand-trimmed to 2–3 items).
- [ ] **Step 2: Write the failing tests**: for each source, with `fetchImpl` returning its fixture, assert item count, url format, and non-empty text. Also: appstore drops 4–5★ reviews, wordpress parses `<item>`, and a 500 response → `[]`.
- [ ] **Step 3:** Run. Expected: FAIL. **Step 4:** Implement. **Step 5:** Run. Expected: PASS.
- [ ] **Step 6:** Commit `feat(sources): HN, StackExchange, GitHub, WordPress, App Store signal sources`.

---

### Task 6: Calculation engine

**Files:**
- Create: `packages/core/src/calc/{schema.ts,numbers.ts}`
- Test: `packages/core/test/calc/numbers.test.ts`

**Interfaces:**
- Produces:
  - `Sourced = { value: number; source?: { url: string; quote: string }; assumption?: string }`. The zod refinement requires `source` or `assumption`, and `value ≥ 0`.
  - `NumberInputs`:
    ```ts
    {
      price: { amount: Sourced; per: string; unitsPerBuyer: Sourced; periodsPerYear: number };  // e.g. $8 per site, 40 sites, 12
      problemCost: { label: string; quantity: Sourced; unitCost: Sourced; perYear: Sourced }[]; // annual cost lines for ONE buyer
      expectedReduction: Sourced;                // fraction 0–1 of problem cost removed
      reachableBuyers: Sourced;                  // in the market
      captureRate: Sourced;                      // fraction 0–1 realistically won in year 1
      deliveryCostPerBuyerMonthly: { label: string; cost: Sourced }[];
      fixedCostsMonthly: { label: string; cost: Sourced }[];
      scenarios: number[];                       // default [10, 50, 200]
    }
    ```
  - `computeNumbers(i: NumberInputs): NumberResults`:
    ```ts
    {
      buyer: { annualPrice; annualProblemCost; annualSavings; roiMultiple: number|null; paybackMonths: number|null };
      market: { annualRevenuePotential; year1Revenue };
      unit: { monthlyPricePerBuyer; monthlyDeliveryCost; grossMarginPct: number|null };
      scenarios: { buyers; mrr; arr; monthlyGrossProfit; monthlyNet }[];
      breakevenBuyers: number|null; breakevenReason?: string;
      formulas: string[];                       // human-readable, e.g. "Annual price = $8 × 40 × 12 = $3,840"
    }
    ```
  - Definitions:
    - annualPrice = amount × unitsPerBuyer × periodsPerYear
    - annualProblemCost = Σ quantity × unitCost × perYear
    - annualSavings = annualProblemCost × expectedReduction
    - roiMultiple = annualSavings / annualPrice (null if annualPrice = 0)
    - paybackMonths = annualPrice / (annualSavings/12) (null if savings = 0)
    - monthlyPricePerBuyer = annualPrice/12
    - grossMarginPct = (monthlyPrice − delivery)/monthlyPrice × 100 (null if price 0)
    - annualRevenuePotential = reachableBuyers × annualPrice; year1Revenue = × captureRate
    - scenario: mrr = buyers × monthlyPrice, arr = mrr × 12, monthlyGrossProfit = buyers × (monthlyPrice − delivery), monthlyNet = gross − Σfixed
    - breakevenBuyers = ceil(Σfixed / (monthlyPrice − delivery)). If the denominator ≤ 0 → `null` with `breakevenReason: "price does not cover delivery cost"`
    - Money rounds to cents in results; formulas format USD with thousands separators

- [ ] **Step 1: Write the failing tests**

```ts
const s = (value: number) => ({ value, assumption: 'test' });
const leadFlow: NumberInputs = {
  price: { amount: s(8), per: 'site', unitsPerBuyer: s(40), periodsPerYear: 12 },
  problemCost: [{ label: 'lost leads from broken forms', quantity: s(6), unitCost: s(400), perYear: s(40) }],
  expectedReduction: s(0.5), reachableBuyers: s(3000), captureRate: s(0.01),
  deliveryCostPerBuyerMonthly: [{ label: 'infra+LLM', cost: s(40) }], fixedCostsMonthly: [{ label: 'hosting', cost: s(30) }], scenarios: [10, 50, 200],
};
it('computes the lead-flow example', () => {
  const r = computeNumbers(leadFlow);
  expect(r.buyer.annualPrice).toBe(3840); expect(r.buyer.annualProblemCost).toBe(96000);
  expect(r.buyer.annualSavings).toBe(48000); expect(r.buyer.roiMultiple).toBeCloseTo(12.5);
  expect(r.buyer.paybackMonths).toBeCloseTo(0.96);
  expect(r.unit.monthlyPricePerBuyer).toBe(320); expect(r.unit.grossMarginPct).toBeCloseTo(87.5);
  expect(r.market.year1Revenue).toBe(115200);
  expect(r.scenarios[0]).toEqual({ buyers: 10, mrr: 3200, arr: 38400, monthlyGrossProfit: 2800, monthlyNet: 2770 });
  expect(r.breakevenBuyers).toBe(1);
  expect(r.formulas.some(f => f.includes('$3,840'))).toBe(true);
});
it('breakeven is null when price does not cover delivery', () => {
  const r = computeNumbers({ ...leadFlow, deliveryCostPerBuyerMonthly: [{ label: 'x', cost: s(400) }] });
  expect(r.breakevenBuyers).toBeNull(); expect(r.breakevenReason).toBe('price does not cover delivery cost');
});
it('zero buyers and zero price give zeros/nulls, never NaN', () => {
  const r = computeNumbers({ ...leadFlow, reachableBuyers: s(0), price: { ...leadFlow.price, amount: s(0) } });
  expect(r.market.annualRevenuePotential).toBe(0); expect(r.buyer.roiMultiple).toBeNull();
  expect(JSON.stringify(r)).not.toContain('NaN');
});
it('schema rejects an input with neither source nor assumption', () => {
  expect(NumberInputsSchema.safeParse({ ...leadFlow, captureRate: { value: 0.01 } }).success).toBe(false);
});
```

- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(calc): deterministic business-case numbers`.

---

### Task 7: Prompt loader, pipeline types, harvest stage

**Files:**
- Create: `packages/core/src/llm/prompts.ts`, `packages/core/src/pipeline/{types.ts,harvest.ts}`, `packages/core/prompts/{harvest-research.v1.md,extract-signals.v1.md}`
- Test: `packages/core/test/llm/prompts.test.ts`, `packages/core/test/pipeline/harvest.test.ts`

**Interfaces:**
- Consumes: `ModelRouter` (Task 3), `SignalSource` (Task 5), `Db` tables (Task 2).
- Produces:
  - `loadPrompt(name: string): { version: string; render(vars: Record<string,string>): string }`. It loads the highest `prompts/<name>.v<N>.md`; `version` = `"<name>.v<N>"`. `{{var}}` substitution. Throws on unknown or unfilled vars.
  - `RunConfig = { seedType: 'open'|'sector'|'lens'|'idea'; sectors?: string[]; lensIds?: string[]; ideaText?: string; marketId: string; ideaCount: number; advanceCount: number; maxSearchesPerCall: number; minSignals: number; dedupeThreshold: number }`. `defaultRunConfig(partial)` fills `marketId 'ca-us', ideaCount 12, advanceCount 3, maxSearchesPerCall 5, minSignals 3, dedupeThreshold 0.88`.
  - `STAGES = ['harvest','ideate','dedupe','screen','gate','case','verify','score'] as const; type Stage`.
  - `StageDeps = { db: Db; router: ModelRouter; sources: SignalSource[]; fetchPage: typeof fetchPage; log: (msg: string) => void }`.
  - `harvest(deps, run: { id: string; config: RunConfig }): Promise<{ signalIds: string[] }>`.
- Behaviour:
  - Build queries from the seed:
    - `open`: 6 random market sectors × the pain phrase bank (`"stopped working"`, `"lost leads"`, `"manual every week"`, `"spreadsheet nightmare"`, `"keeps breaking"`, `"wasting hours"`, `"no way to know if"`, `"silently failing"`)
    - `sector`: the given sectors × the phrases
    - `lens`: the lens `promptHint` × 4 random sectors
    - `idea`: **no source searches**. Only the research call in (b), targeted at the idea text (the problem, who suffers it, evidence it happens), with `maxSearches = 2 × maxSearchesPerCall`
  - (a) For each source, `search` up to 2 queries, `limit 10`. Log each search with `logDataCall` (provider = source id, cost 0, `ok` = returned without warning).
  - (b) One `router.research('harvest', …, maxSearches = config.maxSearchesPerCall)` with `harvest-research` asking for recent public evidence of the pain (market countries in the prompt). Its sources become RawItems with `citedText` as text.
  - (c) Batch RawItems (≤25 per call) into `router.structured('extract', …)` with schema `{ signals: { url, title, quote, sector|null, painType|null, isPain: boolean }[] }`. **`quote` must be a verbatim substring of the item text** (enforced in code: drop otherwise). Keep `isPain` only.
  - Insert with `quoteHash = md5(normalized quote)`, `onConflictDoNothing`. Return the ids of rows inserted, plus existing rows matched by (url, quoteHash) for this run's items.

- [ ] **Step 1: Write the failing tests**

```ts
// prompts.test.ts
it('loads latest version and renders vars', () => {
  const p = loadPrompt('extract-signals'); expect(p.version).toBe('extract-signals.v1');
  expect(() => p.render({})).toThrow(/items/);
});
// harvest.test.ts
it('stores verbatim pain quotes once, across two harvests', async () => {
  const db = await testDb();
  const src: SignalSource = { id: 'hn', search: async () => [{ source: 'hn', url: 'https://news.ycombinator.com/item?id=1', title: 'Forms', text: 'Our contact form silently stopped sending email for 3 weeks.', publishedAt: null }] };
  const extract = { signals: [
    { url: 'https://news.ycombinator.com/item?id=1', title: 'Forms', quote: 'contact form silently stopped sending email', sector: 'web agencies', painType: 'silent failure', isPain: true },
    { url: 'https://news.ycombinator.com/item?id=1', title: 'Forms', quote: 'NOT IN TEXT', sector: null, painType: null, isPain: true },
  ] };
  const router = fakeRouter({ research: { harvest: [{ text: '', sources: [] }, { text: '', sources: [] }] }, structured: { extract: [extract, extract] } });
  const run = await insertRun(db, defaultRunConfig({ seedType: 'sector', sectors: ['web agencies'] }));
  const deps = { db, router, sources: [src], fetchPage, log: () => {} };
  const a = await harvest(deps, run); const b = await harvest(deps, run);
  expect(a.signalIds).toHaveLength(1); expect(b.signalIds).toEqual(a.signalIds);
  expect(await db.select().from(signals)).toHaveLength(1);
});
```

(`insertRun` lives in `test/helpers/db.ts`.)

- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement, including both prompt files. The prompts state the market, ask for businesses (not consumers) losing time or money, and forbid inventing quotes. **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(pipeline): prompt loader and harvest stage`.

---

### Task 8: Ideation stage

**Files:**
- Create: `packages/core/src/pipeline/ideate.ts`, `packages/core/prompts/{ideate.v1.md,owner-idea.v1.md}`
- Test: `packages/core/test/pipeline/ideate.test.ts`

**Interfaces:**
- Consumes: `harvest` output `{ signalIds }`, `lenses` and `markets` rows.
- Produces: `ideate(deps, run, input: { signalIds: string[] }): Promise<{ ideaIds: string[] }>`.
- Behaviour:
  - **Generated** (`open|sector|lens`): choose lenses (`lensIds` if given, else all active). Make one `router.structured('ideate', …)` call per lens. Each call gets that lens's pattern + hint, ≤40 signals (url + quote), market, the **benchmark quality bar** (the 5 strengths from spec §1, inlined in `ideate.v1.md`), and the anti-goals list (spec §2). It returns `{ ideas: { title, oneLiner, buyer, problem, solution, signalUrls: string[] }[] }`, with `ceil(ideaCount / lensCount)` ideas per lens. Map `signalUrls` to `signalIds` (drop unknown urls). Insert as `origin 'generated'`, `status 'candidate'`, with `lensId`.
  - **Owner** (`idea`): one `router.structured('ideate', …)` with `owner-idea.v1` extracts `{ title, oneLiner, buyer, problem, solution }` from `config.ideaText` **without changing the idea**. Insert one row `origin 'owner'`, `lensId null`, `signalIds` = all harvested.

- [ ] **Step 1: Write the failing tests**: (1) two lenses, `ideaCount 4` → 2 structured calls, 4 ideas stored with the right `lensId`, unknown signal urls dropped; (2) owner seed → exactly 1 idea, `origin 'owner'`, and the ideate prompt contains the idea text verbatim (`router.calls[0].prompt`).
- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(pipeline): lens-based ideation and owner-idea intake`.

---

### Task 9: Dedupe and quick screen

**Files:**
- Create: `packages/core/src/pipeline/{dedupe.ts,screen.ts}`, `packages/core/src/case/schema.ts` (criteria + AI score schema only; sections added in Task 11), `packages/core/prompts/screen.v1.md`
- Modify: `packages/core/test/helpers/db.ts`: add `insertIdea(db, runId, overrides)`, `getIdea(db, id)`, `unit(i): number[]` (1536-d one-hot)
- Test: `packages/core/test/pipeline/{dedupe.test.ts,screen.test.ts}`

**Interfaces:**
- Produces:
  - `CRITERIA = ['pain','roi','evidence','speed','autonomy','novelty','reach'] as const` (AI-scored; `gut` is owner-only). `AiScoresSchema = z.object(Object.fromEntries(CRITERIA.map(c => [c, z.object({ value: z.number().int().min(1).max(5), note: z.string() })])))`.
  - `dedupe(deps, run, { ideaIds }): Promise<{ ideaIds: string[] }>`: embeds `title + oneLiner + problem` (one `router.embed` call). For each idea, the max cosine similarity vs **all ideas from other runs (any status)** and vs earlier ideas in this run. If ≥ `dedupeThreshold`, set `status 'duplicate'` + `duplicateOf`. **Owner ideas are never marked duplicate**, only logged. Returns the non-duplicate ids.
  - `screen(deps, run, { ideaIds }): Promise<{ ideaIds: string[] }>`: generated ideas get one `router.structured('screen', …)` each → `AiScoresSchema`. `screenTotal` = mean of values. Top `advanceCount` by total → `status 'advanced'`, the rest `'screened_out'`. Owner ideas skip scoring and are always `advanced`.

- [ ] **Step 1: Write the failing tests**

```ts
it('marks a near-copy of a past killed idea as duplicate', async () => {
  const db = await testDb(); const v = unit(0);                   // unit(i): 1536-d one-hot
  const past = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
  await insertIdea(db, past.id, { embedding: v, status: 'gated_out' });
  const run = await insertRun(db, defaultRunConfig({ seedType: 'open' }));
  const fresh = await insertIdea(db, run.id, {}); const dup = await insertIdea(db, run.id, {});
  const router = fakeRouter({ embed: () => [unit(1), v] });
  const out = await dedupe({ db, router } as StageDeps, run, { ideaIds: [fresh.id, dup.id] });
  expect(out.ideaIds).toEqual([fresh.id]);
  expect((await getIdea(db, dup.id)).status).toBe('duplicate');
});
it('never drops an owner idea as duplicate', async () => { /* same setup with origin 'owner' → returned */ });
it('advances the top N by mean score', async () => { /* 3 ideas, advanceCount 2 → statuses advanced, advanced, screened_out */ });
```

- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement (similarity via `cosineDistance` SQL). **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(pipeline): embedding dedupe and quick screen`.

---

### Task 10: Kill gate

**Files:**
- Create: `packages/core/src/pipeline/gate.ts`, `packages/core/prompts/{competitors.v1.md,gate.v1.md}`
- Test: `packages/core/test/pipeline/gate.test.ts`

**Interfaces:**
- Produces: `gate(deps, run, { ideaIds }): Promise<{ passed: string[]; advisory: { ideaId: string; failedChecks: string[] }[] }>`.
- Behaviour, per idea:
  1. **Competitor evidence:** `router.research('competitors', …)` with `competitors.v1` (a neutral prompt: "find existing products/services that do X for Y, with pricing"). Keep text + sources.
  2. **Evidence check (deterministic):** count distinct hostnames among the idea's signals' urls. Pass iff ≥ `minSignals`. Reasoning = `"N independent sources: host1, host2…"`.
  3. **Judge:** `router.structured('gate', …)` (the different family) with `gate.v1` gets the idea, its signal quotes, and the competitor research text + source urls. It returns `{ verdicts: { check: 'generic'|'regulation'|'control'|'autonomy'|'reachability'; pass: boolean; reasoning: string; sourceUrls: string[] }[] }`, and must contain all 5. Missing checks → treated as a schema failure (refine).
  4. Insert 6 `gateVerdicts` rows (model and promptVersion from the router stage config and prompt).
  5. All pass → `passed`. Any fail: generated idea → `status 'gated_out'`. Owner idea → stays `advanced`, added to `advisory` with the failed check names, and also included in `passed`.
- The router must expose the resolved model for a stage. Add `modelFor(stage: ModelStage): string` to `ModelRouter` in this task (and to `fakeRouter`, returning `DEFAULT_MODELS[stage]`).

- [ ] **Step 1: Write the failing tests**: (1) a generated idea with 2 distinct hosts and `minSignals 3` → evidence fails, `status 'gated_out'`, 6 verdict rows, `model` = `gpt-6-sol`; (2) the same idea as an owner idea → in `passed` and in `advisory` with `['evidence']`, status unchanged; (3) a judge response missing `autonomy` → the router fake throws `StructuredOutputError` (schema refine) and the error propagates.
- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(pipeline): adversarial kill gate with advisory mode for owner ideas`.

---

### Task 11: Deep case

**Files:**
- Modify: `packages/core/src/case/schema.ts` (add sections)
- Create: `packages/core/src/pipeline/deep-case.ts`, `packages/core/prompts/{case-research.v1.md,case-write.v1.md}`
- Test: `packages/core/test/pipeline/deep-case.test.ts`

**Interfaces:**
- Consumes: `NumberInputsSchema`, `computeNumbers` (Task 6); gate output.
- Produces:
  - `CaseSectionsSchema`:
    ```ts
    {
      summary: { oneLiner; buyer; problem; solution; price: { amount: number; per: string; rationale: string }; whyNow; whyItWins; nextAction; gateFlags: string[] };
      evidence: { signals: { quote; url; sourceName }[]; claims: { text; sourceUrl; quote }[] };          // ≥3 claims
      numbers: { inputs: NumberInputs; results: NumberResults };                                           // results filled by code
      competitors: { list: { name; url; pricing; gap }[]; levels: { level; whatItChecks; limitation }[] }; // ≥2 levels
      pitch: { elevator; emails: { subject; body }[]; followUps: { subject; body }[]; callScript; objections: { objection; response }[]; pricingCopy };  // 3 emails, 2 follow-ups
    }
    ```
    The LLM-facing schema `CaseDraftSchema` = the same with `numbers: { inputs: NumberInputs }` only (no results). `summary.gateFlags` is set by code, not the LLM.
  - `deepCase(deps, run, { passed, advisory }): Promise<{ caseIds: string[] }>` (input is exactly the `gate` output)
- Behaviour, per idea:
  1. `router.research('case', …)` with `case-research.v1`: buyer economics, market counts in the market's countries, competitor pricing, why-now. Pass the gate's competitor sources and the idea's signals as starting points. Ask for numbers **with source urls and verbatim quotes**.
  2. `router.structured('case', …, schema CaseDraftSchema, maxTokens 16000)` with `case-write.v1`, given the research text + sources. The prompt requires: every `Sourced` has a source (url+quote from the research) or an explicit assumption; no totals; and a levels table in the style of the benchmark.
  3. Code: `results = computeNumbers(draft.numbers.inputs)`. `gateFlags` = advisory failed checks. Slug = kebab-case title (max 60 chars), with a `-2`, `-3` suffix on collision.
  4. Insert `cases` (stage `new`, `gateAdvisory` = has flags, model = `modelFor('case')`, promptVersion = `case-write.v1`). Insert one `claims` row per `evidence.claims[]`, plus one per sourced number input (`section 'numbers'`, text = `"<label>: <value>"`, sourceUrl/quote from `source`).

- [ ] **Step 1: Write the failing tests**: with a fake router returning a valid `CaseDraft` fixture (`test/helpers/fixtures/case-draft.json`, the lead-flow example using the Task 6 numbers), assert:
  - `sections.numbers.results.buyer.annualPrice === 3840`
  - the slug is `lead-flow-verification-for-web-agencies`
  - a second identical case gets slug `…-2`
  - the claims count = evidence claims + sourced inputs
  - an advisory idea gets `gateFlags: ['evidence']` and `gateAdvisory: true`
  - a draft that includes a `results` key is stripped/ignored (code-computed results win)
- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(pipeline): deep case research and writing with code-computed numbers`.

---

### Task 12: Evidence verification and final AI scoring

**Files:**
- Create: `packages/core/src/pipeline/{verify.ts,score.ts}`, `packages/core/prompts/{verify-claim.v1.md,score.v1.md}`
- Test: `packages/core/test/pipeline/{verify.test.ts,score.test.ts}`

**Interfaces:**
- Produces:
  - `verify(deps, run, { caseIds }): Promise<{ caseIds: string[] }>`. For each claim with a `sourceUrl`, `fetchPage` (cached per URL within the call):
    - `!ok` → `unreachable`
    - normalized quote (lowercase, collapse whitespace, strip punctuation) is a substring of normalized page text → `verified`, confidence 1
    - otherwise → `router.structured('verify', …)` with `verify-claim.v1`, given the claim, quote, and the best 4000-char window of page text (the window with the most quote-word overlap). It returns `{ supported: boolean; confidence: number }` → `verified` or `unsupported`
    - Set `checkedAt` on every claim.
  - `score(deps, run, { caseIds }): Promise<{ caseIds: string[] }>`: one `router.structured('score', …)` per case with `score.v1` → `AiScoresSchema`, given the sections + verification stats (`verified/total`, unreachable count). **Evidence cap (code):** verified ratio < 0.5 → evidence value `min(v, 2)`; < 0.8 → `min(v, 3)`, and the note gets a `"(capped: X/Y claims verified)"` suffix appended. Insert 7 `scores` rows `by 'ai'` with model/promptVersion.

- [ ] **Step 1: Write the failing tests**

```ts
it('classifies verified / unsupported / unreachable', async () => {
  // claims: A quote present verbatim (with different case/punctuation) → verified, no LLM call;
  // B quote absent, fake verify returns supported:false → unsupported; C fetchPage ok:false → unreachable (no LLM call)
  expect(router.calls.filter(c => c.stage === 'verify')).toHaveLength(1);
});
it('fetches each URL once', async () => { /* two claims, same url → fetchPage called once */ });
it('caps evidence score when under half the claims verify', async () => {
  // 1/3 verified, fake score returns evidence 5 → stored evidence value 2, note ends with "(capped: 1/3 claims verified)"
});
```

- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `feat(pipeline): evidence verification and final AI scoring`.

---

### Task 13: Resumable orchestrator, CLI, Markdown export

**Files:**
- Create: `packages/core/src/pipeline/run.ts`, `packages/core/src/case/export-markdown.ts`, `packages/core/src/cli.ts`
- Test: `packages/core/test/pipeline/run.test.ts`, `packages/core/test/case/export-markdown.test.ts`

**Interfaces:**
- Consumes: all stage functions (Tasks 7–12), `buildRouter`, `buildSources`, `createDb`, `runMigrations`, `seedDefaults`.
- Produces:
  - `createRun(db, config: RunConfig): Promise<{ id: string }>` (status `queued`).
  - `executeRun(deps: StageDeps, runId: string, stageImpls?: Partial<Record<Stage, StageFn>>): Promise<'succeeded'|'failed'>`. For each `Stage` in order:
    - if a `runStages` row is `done`, reuse its `output`
    - otherwise insert/update the row to `running`, call the stage with the previous output, then save `output` + `done`
    - set `runs.currentStage`
    - on a throw: stage row `failed`, `runs.status 'failed'`, `runs.error` = message; return `'failed'`
    - re-calling `executeRun` on a failed run resumes from the failed stage
    - An empty stage output short-circuits the remaining stages to `done` with empty outputs, and the run `succeeded`. "Empty" means the output's id list is empty: `signalIds` (harvest), `ideaIds` (ideate/dedupe/screen), `passed` (gate), or `caseIds` (case/verify)
  - `caseToMarkdown(c: CaseRow, claims: ClaimRow[], scores: ScoreRow[]): string`. Sections in tab order (Summary, Evidence, Numbers, Competitors, Pitch, Score). Gate flags as a `> ⚠️ Gate flags:` block at the top. Numbers show the formulas list and an inputs table with a source link or "assumption: …" per input. Claims show a ✅ / ❌ / ⚠️ unreachable / ⏳ status.
  - CLI (`npm run gen -- <cmd>`), with `commander`:
    - `run --seed <open|sector|lens|idea> [--sectors a,b] [--lenses x,y] [--file <path>] [--ideas N] [--advance N]` → creates and executes, prints progress (`[stage] message`), then prints case slugs, total `costUsd`, and the export paths. `--seed idea` requires `--file`. An unreadable or empty file → exit code 2 with message `Idea file is empty or unreadable: <path>`.
    - `resume <runId>`
    - `export [slug|--all]` → `output/cases/<slug>.md`
    - `runs` → table of recent runs (id, seed, status, stage, cost, cases)
  - The CLI calls `process.loadEnvFile()` if `.env` exists, then `createDb` → `runMigrations` → `seedDefaults` on every start (cheap, idempotent).
  - **Paths:** npm runs workspace scripts inside `packages/core`, so the CLI resolves `--file`, the `output/cases` dir, a relative `pglite://` path, and `.env` against `process.env.INIT_CWD ?? process.cwd()` (the directory where the user ran `npm`, normally the repo root).

- [ ] **Step 1: Write the failing tests**

```ts
it('resumes from the failed stage without re-running done stages', async () => {
  const db = await testDb(); const { id } = await createRun(db, defaultRunConfig({ seedType: 'open' }));
  const calls: string[] = []; let failGate = true;
  const impl = (name: Stage) => async () => { calls.push(name); if (name === 'gate' && failGate) throw Object.assign(new Error('503'), { status: 503 }); return { ideaIds: ['i1'], caseIds: ['c1'], signalIds: ['s1'], passed: ['i1'], advisory: [] }; };
  const stageImpls = Object.fromEntries(STAGES.map(s => [s, impl(s)]));
  expect(await executeRun(deps(db), id, stageImpls)).toBe('failed');
  failGate = false;
  expect(await executeRun(deps(db), id, stageImpls)).toBe('succeeded');
  expect(calls).toEqual(['harvest','ideate','dedupe','screen','gate','gate','case','verify','score']);
  expect(await db.select().from(runStages).where(eq(runStages.runId, id))).toHaveLength(8);
});
it('short-circuits when screen advances nothing', async () => { /* screen returns { ideaIds: [] } → gate..score not called, run succeeded */ });
it('renders markdown with gate flags, formulas and claim statuses', () => {
  const md = caseToMarkdown(caseFixture({ gateFlags: ['evidence'] }), [claim('verified'), claim('unreachable')], aiScores());
  expect(md).toMatch(/⚠️ Gate flags: evidence/); expect(md).toContain('$3,840'); expect(md).toContain('✅'); expect(md).toContain('unreachable');
});
```

- [ ] **Step 2:** Run. Expected: FAIL. **Step 3:** Implement `run.ts`, `export-markdown.ts`, `cli.ts`. **Step 4:** Run the full suite `npm test`. Expected: all PASS.
- [ ] **Step 5:** Check the CLI error path: `npm run gen -- run --seed idea --file nope.md`. Expected: exit code 2 and the message above.
- [ ] **Step 6:** Commit `feat: resumable run orchestrator, CLI and markdown export`.

---

### Task 14: Live benchmark run and first open run

**Files:**
- Create: `docs/runs/2026-10-xx-benchmark.md` (results log; use the actual date)
- Modify: `docs/CONTEXT.md` (status + session log)

No new code unless the run exposes a defect. Fix each defect with a failing test first, in the owning task's test file.

- [ ] **Step 1:** Create `.env` from `.env.example`: `LLM_API_KEY` = the Fuelix token (copy it from the user's global Claude settings into `.env` only), and `DATABASE_URL=pglite://.data/pglite`. Run `npx tsx scripts/smoke-llm.ts`. Expected: 4 OK lines.
- [ ] **Step 2:** Run the benchmark: `npm run gen -- run --seed idea --file "docs/Lead Gen Test.md"`. Expected: run `succeeded`, 1 case, and its Markdown exported.
- [ ] **Step 3:** Check spec §12.1 (case portion) and record pass/fail with evidence in `docs/runs/…-benchmark.md`:
  - the buyer is the agency (or the case argues convincingly for a better one)
  - a levels table exists with ≥3 levels
  - buyer ROI and market numbers show formulas, and each input has a source or a named assumption
  - **100% of displayed sources resolve or are visibly flagged `unreachable`/`unsupported`**
  - (The pilot plan for gamersgetaway.ca is Plan 3's validation pack. Plan 1 does not fetch or touch that site.)
- [ ] **Step 4:** Run an open exploration: `npm run gen -- run --seed open --ideas 12 --advance 5`. Expected: ≥5 ideas reach the gate. Record how many pass, plus their titles and AI scores, in the same log for the owner to review (§12.2: the owner judges whether ≥2 are pitch-worthy).
- [ ] **Step 5:** Record total `costUsd` per run and any 429s seen (from `llm_calls`). Update `docs/CONTEXT.md` status to "Plan 1 complete; next: Plan 2 (Dashboard)".
- [ ] **Step 6:** Commit `docs: benchmark and first open run results`.
