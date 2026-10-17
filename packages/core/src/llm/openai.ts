import OpenAI from 'openai';
import type { AdapterRequest, AdapterResponse, ProviderAdapter } from './types';

/** Parse model output as JSON, tolerating a ```json fence; undefined if it is not JSON. */
function parseJson(text: string): unknown {
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(unfenced);
  } catch {
    return undefined;
  }
}

export function createOpenAIAdapter(opts: { baseURL: string; key: string }): ProviderAdapter {
  const client = new OpenAI({ baseURL: opts.baseURL, apiKey: opts.key, timeout: 15 * 60_000, maxRetries: 0 });

  return {
    async complete(r: AdapterRequest): Promise<AdapterResponse> {
      if (r.webSearch) throw new Error('web search requires a claude model');

      const system = [
        r.system,
        r.jsonSchema && 'Respond only with JSON matching this JSON Schema:\n' + JSON.stringify(r.jsonSchema.schema),
      ].filter(Boolean).join('\n\n');

      const messages: OpenAI.ChatCompletionMessageParam[] = [
        ...(system ? [{ role: 'system' as const, content: system }] : []),
        ...r.messages,
      ];

      const res = await client.chat.completions.create({
        model: r.model,
        messages,
        // max_completion_tokens, not the deprecated max_tokens: gpt-6-sol rejects max_tokens on Fuelix.
        // Floor of 4000 because reasoning models return empty choices on small budgets.
        max_completion_tokens: Math.max(r.maxTokens, 4000),
        ...(r.jsonSchema ? { response_format: { type: 'json_object' as const } } : {}),
      });

      const text = res.choices[0]?.message?.content ?? '';
      const json = r.jsonSchema ? parseJson(text) : undefined;
      return {
        text,
        ...(json !== undefined ? { json } : {}),
        sources: [],
        usage: {
          inputTokens: res.usage?.prompt_tokens ?? 0,
          outputTokens: res.usage?.completion_tokens ?? 0,
          searchRequests: 0,
        },
      };
    },

    async embed(model: string, texts: string[]) {
      const res = await client.embeddings.create({ model, input: texts, encoding_format: 'float' });
      const vectors = [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      return { vectors, inputTokens: res.usage?.prompt_tokens ?? 0 };
    },
  };
}
