// Live smoke check of the model router against the configured gateway (not part of `npm test`).
// Usage (from packages/core): LLM_API_KEY=... DATABASE_URL=pglite://memory npx tsx scripts/smoke-llm.ts
import { z } from 'zod';
import { loadEnv } from '../src/config/env';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { llmCalls } from '../src/db/schema';
import { buildRouter } from '../src/llm/router';

const env = loadEnv();
const db = await createDb(env.DATABASE_URL);
await runMigrations(db);
const router = buildRouter(env, db);
const ctx = { runId: null, promptVersion: 'smoke.v1' };

let failed = 0;
async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const detail = await fn();
    console.log(`OK   ${name} (${Date.now() - started} ms) ${detail}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

await check(`text(extract) [${router.modelFor('extract')}]`, async () => {
  const out = await router.text('extract', { prompt: 'Reply with the single word: pong', maxTokens: 50 }, ctx);
  return JSON.stringify(out.trim().slice(0, 60));
});

await check(`structured(gate) [${router.modelFor('gate')}]`, async () => {
  const out = await router.structured('gate', {
    prompt: 'Is 17 a prime number? Give a one-sentence reason.',
    schema: z.object({ prime: z.boolean(), reason: z.string() }),
    schemaName: 'prime_check',
  }, ctx);
  return JSON.stringify(out);
});

await check(`research(harvest) [${router.modelFor('harvest')}]`, async () => {
  const out = await router.research('harvest', {
    prompt: 'Find one recent news article about small-business accounting software. One sentence, cite it.',
    maxSearches: 1,
    maxTokens: 2000,
  }, ctx);
  return `text=${out.text.length} chars, sources=${out.sources.length}${out.sources[0] ? ` e.g. ${out.sources[0].url}` : ''}`;
});

await check(`embed [${router.modelFor('embed')}]`, async () => {
  const [vector] = await router.embed(['invoice reconciliation pain'], ctx);
  return `length=${vector.length}`;
});

const rows = await db.select().from(llmCalls);
const total = rows.reduce((sum, r) => sum + Number(r.costUsd), 0);
console.log(`llm_calls rows=${rows.length} ok=${rows.filter((r) => r.ok).length} notional cost=$${total.toFixed(4)}`);
process.exit(failed ? 1 : 0);
