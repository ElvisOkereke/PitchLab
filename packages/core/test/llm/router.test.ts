import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { testDb } from '../helpers/db';
import { fakeRouter } from '../helpers/fake-router';
import { llmCalls, runs } from '../../src/db/schema';
import { DEFAULT_MODELS } from '../../src/config/models';
import { costOf } from '../../src/config/prices';
import { createRouter, buildRouter, StructuredOutputError } from '../../src/llm/router';
import type { AdapterRequest, AdapterResponse, ProviderAdapter } from '../../src/llm/types';
import { loadEnv } from '../../src/config/env';

type Scripted = Partial<AdapterResponse> | Error;

function scriptedAdapter(script: Scripted[], embedVectors: number[][] = []) {
  const requests: AdapterRequest[] = [];
  const embeds: { model: string; texts: string[] }[] = [];
  const adapter: ProviderAdapter & { requests: AdapterRequest[]; embeds: typeof embeds } = {
    requests,
    embeds,
    async complete(r) {
      requests.push(structuredClone(r));
      const next = script.shift();
      if (!next) throw new Error('script exhausted');
      if (next instanceof Error) throw next;
      return {
        text: '',
        sources: [],
        usage: { inputTokens: 100, outputTokens: 50, searchRequests: 0 },
        ...next,
      };
    },
    async embed(model, texts) {
      embeds.push({ model, texts });
      return { vectors: embedVectors, inputTokens: 12 };
    },
  };
  return adapter;
}

const ctx = { runId: null, promptVersion: 'v' };

describe('createRouter', () => {
  it('re-asks once on invalid JSON, logs both calls with cost', async () => {
    const db = await testDb();
    const a = scriptedAdapter([{ json: { n: 'x' } }, { json: { n: 3 } }]);
    const r = createRouter({ adapters: { anthropic: a, openai: a }, db, models: DEFAULT_MODELS, maxConcurrency: 2 });
    expect(
      await r.structured('screen', { prompt: 'p', schema: z.object({ n: z.number() }), schemaName: 'x' }, { runId: null, promptVersion: 'screen.v1' }),
    ).toEqual({ n: 3 });
    expect(a.requests[1].messages.at(-1)!.content).toMatch(/invalid/);
    expect(a.requests[1].messages.at(-2)).toEqual({ role: 'assistant', content: '{"n":"x"}' });
    const calls = await db.select().from(llmCalls);
    expect(calls).toHaveLength(2);
    expect(calls[0].promptVersion).toBe('screen.v1');
    expect(calls[0].stage).toBe('screen');
    expect(calls[0].model).toBe('claude-haiku-5-5');
    expect(calls[0].provider).toBe('anthropic');
    expect(calls[0].ok).toBe(true);
    expect(Number(calls[0].costUsd)).toBeCloseTo(costOf('claude-haiku-5-5', { inputTokens: 100, outputTokens: 50, searchRequests: 0 }));
  });

  it('sends the zod schema as JSON Schema and default maxTokens', async () => {
    const db = await testDb();
    const a = scriptedAdapter([{ json: { n: 1 } }]);
    const r = createRouter({ adapters: { anthropic: a, openai: a }, db, models: DEFAULT_MODELS, maxConcurrency: 1 });
    await r.structured('screen', { system: 's', prompt: 'p', schema: z.object({ n: z.number() }), schemaName: 'score' }, ctx);
    const req = a.requests[0];
    expect(req.system).toBe('s');
    expect(req.maxTokens).toBe(8000);
    expect(req.jsonSchema?.name).toBe('score');
    expect(req.jsonSchema?.schema).toMatchObject({ type: 'object', properties: { n: { type: 'number' } }, required: ['n'] });
  });

  it('treats missing JSON as invalid and re-asks', async () => {
    const db = await testDb();
    const a = scriptedAdapter([{ text: 'not json' }, { json: { n: 2 } }]);
    const r = createRouter({ adapters: { anthropic: a, openai: a }, db, models: DEFAULT_MODELS, maxConcurrency: 1 });
    expect(await r.structured('screen', { prompt: 'p', schema: z.object({ n: z.number() }), schemaName: 'x' }, ctx)).toEqual({ n: 2 });
    expect(a.requests[1].messages.at(-2)).toEqual({ role: 'assistant', content: 'not json' });
  });

  it('throws StructuredOutputError after 2 re-asks', async () => {
    const db = await testDb();
    const a = scriptedAdapter([{ json: {} }, { json: {} }, { json: {} }]);
    const r = createRouter({ adapters: { anthropic: a, openai: a }, db, models: DEFAULT_MODELS, maxConcurrency: 1 });
    await expect(
      r.structured('screen', { prompt: 'p', schema: z.object({ n: z.number() }), schemaName: 'x' }, { runId: null, promptVersion: 'v' }),
    ).rejects.toBeInstanceOf(StructuredOutputError);
    expect(a.requests).toHaveLength(3);
  });

  it('routes gate to the openai adapter and research to anthropic', async () => {
    const db = await testDb();
    const anthropic = scriptedAdapter([{ text: 'found', sources: [{ url: 'https://a' }] }]);
    const openai = scriptedAdapter([{ json: { pass: true } }]);
    const r = createRouter({ adapters: { anthropic, openai }, db, models: DEFAULT_MODELS, maxConcurrency: 2 });
    await r.structured('gate', { prompt: 'p', schema: z.object({ pass: z.boolean() }), schemaName: 'gate' }, ctx);
    const res = await r.research('harvest', { prompt: 'q', maxSearches: 3 }, ctx);
    expect(openai.requests.map((q) => q.model)).toEqual(['gpt-6-sol']);
    expect(anthropic.requests.map((q) => q.model)).toEqual(['claude-sonnet-5-5']);
    expect(anthropic.requests[0].webSearch).toEqual({ maxUses: 3 });
    expect(anthropic.requests[0].maxTokens).toBe(16000);
    expect(res).toEqual({ text: 'found', sources: [{ url: 'https://a' }] });
    const providers = (await db.select().from(llmCalls)).map((c) => c.provider).sort();
    expect(providers).toEqual(['anthropic', 'openai']);
  });

  it('adds each call cost to the run and logs failed attempts', async () => {
    const db = await testDb();
    const [run] = await db.insert(runs).values({ config: {} as never, status: 'running' }).returning();
    const a = scriptedAdapter([
      { text: 'one', usage: { inputTokens: 1000, outputTokens: 1000, searchRequests: 0 } },
      Object.assign(new Error('bad request'), { status: 400 }),
    ]);
    const r = createRouter({ adapters: { anthropic: a, openai: a }, db, models: DEFAULT_MODELS, maxConcurrency: 1 });
    const runCtx = { runId: run.id, promptVersion: 'extract.v1' };
    expect(await r.text('extract', { prompt: 'p', maxTokens: 100 }, runCtx)).toBe('one');
    await expect(r.text('extract', { prompt: 'p' }, runCtx)).rejects.toThrow('bad request');

    const calls = await db.select().from(llmCalls).where(eq(llmCalls.runId, run.id));
    expect(calls.map((c) => c.ok)).toEqual([true, false]);
    expect(calls[1].error).toBe('bad request');
    expect(Number(calls[1].costUsd)).toBe(0);
    const [after] = await db.select().from(runs).where(eq(runs.id, run.id));
    expect(Number(after.costUsd)).toBeCloseTo(0.006);
  });

  it('embeds through the openai adapter and logs the call', async () => {
    const db = await testDb();
    const anthropic = scriptedAdapter([]);
    const openai = scriptedAdapter([], [[1, 2], [3, 4]]);
    const r = createRouter({ adapters: { anthropic, openai }, db, models: DEFAULT_MODELS, maxConcurrency: 1 });
    expect(await r.embed(['a', 'b'], { runId: null, promptVersion: 'embed.v1' })).toEqual([[1, 2], [3, 4]]);
    expect(openai.embeds).toEqual([{ model: 'text-embedding-3-small', texts: ['a', 'b'] }]);
    const [call] = await db.select().from(llmCalls);
    expect(call).toMatchObject({ stage: 'embed', provider: 'openai', inputTokens: 12, outputTokens: 0, ok: true });
  });

  it('exposes the resolved model per stage', async () => {
    const db = await testDb();
    const a = scriptedAdapter([]);
    const r = createRouter({ adapters: { anthropic: a, openai: a }, db, models: { ...DEFAULT_MODELS, score: 'gemini-x' }, maxConcurrency: 1 });
    expect(r.modelFor('score')).toBe('gemini-x');
    expect(r.modelFor('case')).toBe('claude-opus-5-5');
  });
});

describe('buildRouter', () => {
  const base = { LLM_API_KEY: 'test-key', DATABASE_URL: 'pglite://memory' };

  it('applies MODEL_OVERRIDES on top of the defaults', async () => {
    const db = await testDb();
    const r = buildRouter(loadEnv({ ...base, MODEL_OVERRIDES: '{"screen":"claude-sonnet-5-5"}' }), db);
    expect(r.modelFor('screen')).toBe('claude-sonnet-5-5');
    expect(r.modelFor('extract')).toBe('claude-haiku-5-5');
  });

  it('rejects unknown override keys', async () => {
    const db = await testDb();
    expect(() => buildRouter(loadEnv({ ...base, MODEL_OVERRIDES: '{"scren":"x"}' }), db)).toThrow(/scren/);
  });

  it('rejects an invalid resulting config', async () => {
    const db = await testDb();
    expect(() => buildRouter(loadEnv({ ...base, MODEL_OVERRIDES: '{"gate":"claude-opus-5-5"}' }), db)).toThrow(/gate/);
  });
});

describe('fakeRouter', () => {
  it('shifts queued responses per stage and records calls', async () => {
    const r = fakeRouter({
      text: { extract: ['a', 'b'] },
      research: { harvest: [{ text: 'r', sources: [] }] },
      embed: (t) => t.map(() => [0]),
    });
    expect(await r.text('extract', { prompt: 'p1' }, ctx)).toBe('a');
    expect(await r.text('extract', { prompt: 'p2' }, ctx)).toBe('b');
    await expect(r.text('extract', { prompt: 'p3' }, ctx)).rejects.toThrow(/extract/);
    expect(await r.research('harvest', { prompt: 'q', maxSearches: 1 }, ctx)).toEqual({ text: 'r', sources: [] });
    expect(await r.embed(['x'], ctx)).toEqual([[0]]);
    expect(r.calls.slice(0, 2)).toEqual([
      { stage: 'extract', kind: 'text', prompt: 'p1' },
      { stage: 'extract', kind: 'text', prompt: 'p2' },
    ]);
    expect(r.calls.map((c) => c.kind)).toEqual(['text', 'text', 'text', 'research', 'embed']);
  });

  it('validates structured responses with the schema', async () => {
    const r = fakeRouter({ structured: { screen: [{ n: 1 }, { n: 'bad' }] } });
    const schema = z.object({ n: z.number() });
    expect(await r.structured('screen', { prompt: 'p', schema, schemaName: 's' }, ctx)).toEqual({ n: 1 });
    await expect(r.structured('screen', { prompt: 'p', schema, schemaName: 's' }, ctx)).rejects.toBeInstanceOf(StructuredOutputError);
  });

  it('reports default or overridden models', () => {
    const r = fakeRouter({ models: { score: 'gpt-6-sol' } });
    expect(r.modelFor('score')).toBe('gpt-6-sol');
    expect(r.modelFor('ideate')).toBe('claude-opus-5-5');
  });
});
