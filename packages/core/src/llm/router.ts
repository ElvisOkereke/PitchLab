import pLimit from 'p-limit';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { llmCalls, runs } from '../db/schema';
import type { Env } from '../config/env';
import { adapterFor, isModelStage, resolveModelConfig, validateModelConfig, type ModelStage } from '../config/models';
import { costOf, type Usage } from '../config/prices';
import { createAnthropicAdapter } from './anthropic';
import { createOpenAIAdapter } from './openai';
import { withRetry } from './retry';
import { getSetting } from '../validation/settings';
import {
  StructuredOutputError,
  type AdapterRequest,
  type AdapterResponse,
  type CallCtx,
  type ModelRouter,
  type ProviderAdapter,
} from './types';
import { errorMessage } from '../tools/scrub';

export { StructuredOutputError } from './types';

const DEFAULT_MAX_TOKENS = 8000;
const RESEARCH_MAX_TOKENS = 16000;
const MAX_REASKS = 2;
const RETRY = { attempts: 5, baseMs: 1000 };

export function createRouter(opts: {
  adapters: { anthropic: ProviderAdapter; openai: ProviderAdapter };
  db: Db;
  models: Record<ModelStage, string>;
  maxConcurrency: number;
  /** The judge stage takes its model from setting `judge.model` when set (live tournament and calibration without `--model`). */
  judgeFromSettings?: boolean;
  /** Where a bad `judge.model` setting is reported (once per router); default console.warn. */
  warn?: (m: string) => void;
}): ModelRouter {
  const { adapters, db, models } = opts;
  const limit = pLimit(opts.maxConcurrency);

  async function log(row: {
    stage: ModelStage; provider: string; model: string; usage: Usage; latencyMs: number; ctx: CallCtx; error?: string;
  }): Promise<void> {
    const cost = costOf(row.model, row.usage);
    await db.insert(llmCalls).values({
      runId: row.ctx.runId,
      missionId: row.ctx.missionId ?? null,
      stage: row.stage,
      provider: row.provider,
      model: row.model,
      inputTokens: row.usage.inputTokens,
      outputTokens: row.usage.outputTokens,
      searchRequests: row.usage.searchRequests,
      costUsd: String(cost),
      latencyMs: row.latencyMs,
      promptVersion: row.ctx.promptVersion,
      ok: row.error === undefined,
      error: row.error ?? null,
    });
    if (row.ctx.runId !== null) {
      await db.update(runs)
        .set({ costUsd: sql`${runs.costUsd} + ${String(cost)}::numeric` })
        .where(eq(runs.id, row.ctx.runId));
    }
  }

  /** Run one adapter call under the concurrency limit with retries, logging every attempt. */
  /** The model for a call: `models[stage]`, except the judge stage with a valid setting `judge.model` (a bad one is ignored). */
  let warnedJudge = false;
  async function modelOf(stage: ModelStage): Promise<string> {
    if (stage !== 'judge' || !opts.judgeFromSettings) return models[stage];
    try {
      const v = await getSetting(db, 'judge.model');
      if (typeof v !== 'string' || v.trim() === '') return models[stage];
      try {
        validateModelConfig({ ...models, judge: v.trim() });
      } catch (err) {
        if (!warnedJudge) {
          warnedJudge = true;
          (opts.warn ?? ((m: string) => console.warn(m)))(`Ignoring setting judge.model (${errorMessage(err)}); using ${models[stage]}`);
        }
        return models[stage];
      }
      return v.trim();
    } catch {
      return models[stage];
    }
  }

  async function invoke<T>(
    stage: ModelStage,
    ctx: CallCtx,
    call: (adapter: ProviderAdapter, model: string) => Promise<{ result: T; usage: Usage }>,
  ): Promise<T> {
    const model = await modelOf(stage);
    const provider = adapterFor(model);
    const adapter = adapters[provider];
    const attempt = async (): Promise<T> => {
      const started = performance.now();
      const elapsed = () => Math.round(performance.now() - started);
      try {
        const { result, usage } = await call(adapter, model);
        await log({ stage, provider, model, usage, latencyMs: elapsed(), ctx });
        return result;
      } catch (err) {
        // D2-R2: llm_calls.error is persisted, so it is scrubbed; the original error is rethrown unchanged.
        const error = errorMessage(err);
        await log({ stage, provider, model, usage: { inputTokens: 0, outputTokens: 0, searchRequests: 0 }, latencyMs: elapsed(), ctx, error });
        throw err;
      }
    };
    return limit(() => withRetry(attempt, RETRY));
  }

  function complete(stage: ModelStage, req: Omit<AdapterRequest, 'model'>, ctx: CallCtx): Promise<AdapterResponse> {
    return invoke(stage, ctx, async (adapter, model) => {
      const res = await adapter.complete({ ...req, model });
      // A throwing callback must not count as a provider failure (and be retried).
      if (res.truncated) { try { ctx.onTruncated?.(); } catch { /* ignore */ } }
      return { result: res, usage: res.usage };
    });
  }

  return {
    modelFor: (stage) => models[stage],
    effectiveModel: modelOf,

    async text(stage, { system, prompt, maxTokens }, ctx) {
      const res = await complete(stage, {
        system, messages: [{ role: 'user', content: prompt }], maxTokens: maxTokens ?? DEFAULT_MAX_TOKENS,
      }, ctx);
      return res.text;
    },

    async structured(stage, { system, prompt, schema, schemaName, maxTokens }, ctx) {
      const { $schema: _drop, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
      const messages: AdapterRequest['messages'] = [{ role: 'user', content: prompt }];
      let issues = '';
      for (let ask = 0; ask <= MAX_REASKS; ask++) {
        const res = await complete(stage, {
          system,
          messages: [...messages],
          maxTokens: maxTokens ?? DEFAULT_MAX_TOKENS,
          jsonSchema: { name: schemaName, schema: jsonSchema },
        }, ctx);
        if (res.json === undefined) {
          issues = 'output was not valid JSON';
        } else {
          const parsed = schema.safeParse(res.json);
          if (parsed.success) return parsed.data;
          issues = z.prettifyError(parsed.error);
        }
        const previous = res.json !== undefined ? JSON.stringify(res.json) : res.text;
        messages.push(
          { role: 'assistant', content: previous || '(empty)' },
          {
            role: 'user',
            content: res.truncated
              ? 'Your output was cut off before it finished. Return the same number of items, each shorter, as complete JSON only.'
              : `Your output was invalid: ${issues}. Return corrected JSON only.`,
          },
        );
      }
      throw new StructuredOutputError(`${stage}: structured output still invalid after ${MAX_REASKS} re-asks`, issues);
    },

    async research(stage, { system, prompt, maxSearches, maxTokens }, ctx) {
      const res = await complete(stage, {
        system,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: maxTokens ?? RESEARCH_MAX_TOKENS,
        webSearch: { maxUses: maxSearches },
      }, ctx);
      return { text: res.text, sources: res.sources };
    },

    async embed(texts, ctx) {
      if (texts.length === 0) return [];
      return invoke('embed', ctx, async (adapter, model) => {
        const { vectors, inputTokens } = await adapter.embed(model, texts);
        return { result: vectors, usage: { inputTokens, outputTokens: 0, searchRequests: 0 } };
      });
    },
  };
}

/** `extra` overrides stages on top of MODEL_OVERRIDES (calibration `--model`); an explicit judge model pins it over setting `judge.model`. */
export function buildRouter(env: Env, db: Db, extra: Partial<Record<ModelStage, string>> = {}): ModelRouter {
  const unknown = Object.keys(env.MODEL_OVERRIDES).filter((k) => !isModelStage(k));
  if (unknown.length) throw new Error(`MODEL_OVERRIDES has unknown stage(s): ${unknown.join(', ')}`);
  const models = resolveModelConfig({ ...env.MODEL_OVERRIDES, ...extra });
  validateModelConfig(models);
  return createRouter({
    adapters: {
      anthropic: createAnthropicAdapter({ baseURL: env.LLM_ANTHROPIC_BASE_URL, key: env.LLM_API_KEY }),
      openai: createOpenAIAdapter({ baseURL: env.LLM_OPENAI_BASE_URL, key: env.LLM_API_KEY }),
    },
    db,
    models,
    maxConcurrency: env.LLM_MAX_CONCURRENCY,
    judgeFromSettings: extra.judge === undefined,
  });
}
