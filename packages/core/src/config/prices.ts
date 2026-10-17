// Notional prices: Fuelix is employer-paid; edit freely.

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  searchRequests: number;
}

/** USD per 1M tokens. */
const PRICES: Record<string, { in: number; out: number }> = {
  'claude-opus-5-5': { in: 5, out: 25 },
  'claude-sonnet-5-5': { in: 3, out: 15 },
  'claude-haiku-5-5': { in: 1, out: 5 },
  'gpt-6-sol': { in: 2.5, out: 15 },
  'gemini-3.1-pro': { in: 2, out: 12 },
  'text-embedding-3-small': { in: 0.02, out: 0 },
};

/** USD per 1k web searches. */
const WEB_SEARCH_PER_1K = 10;

const warned = new Set<string>();

export function costOf(model: string, usage: Usage): number {
  const price = PRICES[model];
  if (!price) {
    if (!warned.has(model)) {
      warned.add(model);
      console.warn(`costOf: no price for model "${model}"; recording cost 0`);
    }
    return 0;
  }
  return (
    (usage.inputTokens * price.in + usage.outputTokens * price.out) / 1_000_000 +
    (usage.searchRequests * WEB_SEARCH_PER_1K) / 1000
  );
}
