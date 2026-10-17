import { APIConnectionError as AnthropicConnectionError } from '@anthropic-ai/sdk';
import { APIConnectionError as OpenAIConnectionError } from 'openai';

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]);
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT']);
/** Anthropic error types that arrive as a mid-stream SSE `error` event (thrown with status undefined). */
const RETRYABLE_ERROR_TYPES = new Set(['overloaded_error', 'api_error']);

/** Upper bound on any single retry wait, including a server-supplied `retry-after`. */
export const MAX_RETRY_DELAY_MS = 60_000;

type ErrLike = { status?: unknown; code?: unknown; headers?: unknown; cause?: unknown; type?: unknown; error?: unknown };

function errorType(e: ErrLike): unknown {
  const body = e.error as { type?: unknown; error?: { type?: unknown } } | undefined;
  return e.type ?? body?.error?.type ?? body?.type;
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof AnthropicConnectionError || err instanceof OpenAIConnectionError) return true;
  if (!err || typeof err !== 'object') return false;
  const e = err as ErrLike;
  if (typeof e.status === 'number' && RETRYABLE_STATUS.has(e.status)) return true;
  if (typeof e.code === 'string' && RETRYABLE_CODES.has(e.code)) return true;
  const type = errorType(e);
  if (typeof type === 'string' && RETRYABLE_ERROR_TYPES.has(type)) return true;
  const cause = e.cause as ErrLike | undefined;
  return typeof cause?.code === 'string' && RETRYABLE_CODES.has(cause.code);
}

function header(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === name && typeof v === 'string') return v;
  }
  return undefined;
}

/**
 * `retry-after` seconds exactly when present, else baseMs·2^attempt with ±20% jitter;
 * either way clamped to MAX_RETRY_DELAY_MS.
 */
export function retryDelayMs(err: unknown, attempt: number, baseMs: number): number {
  const raw = err && typeof err === 'object' ? header((err as ErrLike).headers, 'retry-after') : undefined;
  const seconds = raw === undefined ? NaN : Number(raw);
  const delay = Number.isFinite(seconds) && seconds >= 0
    ? seconds * 1000
    : baseMs * 2 ** attempt * (0.8 + Math.random() * 0.4);
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

export async function withRetry<T>(fn: () => Promise<T>, opts: { attempts: number; baseMs: number }): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt + 1 >= opts.attempts || !isRetryable(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(err, attempt, opts.baseMs)));
    }
  }
}
