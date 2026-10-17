import { describe, it, expect, vi, afterEach } from 'vitest';
import { APIConnectionError as AnthropicConnectionError } from '@anthropic-ai/sdk';
import { APIConnectionError as OpenAIConnectionError } from 'openai';
import { isRetryable, retryDelayMs, withRetry } from '../../src/llm/retry';

describe('withRetry', () => {
  afterEach(() => vi.useRealTimers());

  it('honours retry-after and gives up after 5 attempts', async () => {
    vi.useFakeTimers();
    const err = Object.assign(new Error('rate'), { status: 429, headers: { 'retry-after': '2' } });
    const fn = vi.fn().mockRejectedValue(err);
    const p = withRetry(fn, { attempts: 5, baseMs: 1000 });
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(2000 * 5);
    await expect(p).rejects.toThrow('rate');
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('does not retry a 400', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('bad'), { status: 400 }));
    await expect(withRetry(fn, { attempts: 5, baseMs: 1 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('returns the first success after transient failures', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('down'), { status: 503 }))
      .mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
      .mockResolvedValue('ok');
    await expect(withRetry(fn, { attempts: 5, baseMs: 1 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('retry policy', () => {
  it('classifies retryable errors', () => {
    for (const status of [429, 500, 502, 503, 504, 529]) expect(isRetryable({ status })).toBe(true);
    expect(isRetryable({ status: 400 })).toBe(false);
    expect(isRetryable({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isRetryable(new Error('plain'))).toBe(false);
    expect(isRetryable(new AnthropicConnectionError({ message: 'conn' }))).toBe(true);
    expect(isRetryable(new OpenAIConnectionError({ message: 'conn' }))).toBe(true);
  });

  it('reads retry-after from a Headers instance exactly, else backs off with ±20% jitter', () => {
    const headers = new Headers({ 'retry-after': '3' });
    expect(retryDelayMs({ status: 429, headers }, 0, 1000)).toBe(3000);
    for (let i = 0; i < 20; i++) {
      const d = retryDelayMs({ status: 503 }, 2, 1000);
      expect(d).toBeGreaterThanOrEqual(3200);
      expect(d).toBeLessThanOrEqual(4800);
    }
  });
});
