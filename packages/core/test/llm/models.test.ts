import { describe, it, expect, vi, afterEach } from 'vitest';
import { DEFAULT_MODELS, adapterFor, family, validateModelConfig } from '../../src/config/models';
import { costOf } from '../../src/config/prices';

describe('model config', () => {
  it('accepts the defaults', () => {
    expect(() => validateModelConfig(DEFAULT_MODELS)).not.toThrow();
  });

  it('rejects same-family gate and ideation', () => {
    expect(() => validateModelConfig({ ...DEFAULT_MODELS, gate: 'claude-sonnet-5-5' })).toThrow(/gate/);
  });

  it('rejects same-family score and ideation', () => {
    expect(() => validateModelConfig({ ...DEFAULT_MODELS, score: 'claude-haiku-5-5' })).toThrow(/score/);
  });

  it('rejects a non-claude research stage', () => {
    expect(() => validateModelConfig({ ...DEFAULT_MODELS, case: 'gpt-6-sol' })).toThrow(/case/);
  });

  it('classifies families by prefix and picks the adapter', () => {
    expect(family('claude-opus-5-5')).toBe('claude');
    expect(family('gpt-6-sol')).toBe('gpt');
    expect(family('text-embedding-3-small')).toBe('gpt');
    expect(family('gemini-3.1-pro')).toBe('gemini');
    expect(family('llama-9')).toBe('other');
    expect(adapterFor('claude-haiku-5-5')).toBe('anthropic');
    expect(adapterFor('gemini-3.1-pro')).toBe('openai');
  });
});

describe('costOf', () => {
  afterEach(() => vi.restoreAllMocks());

  it('prices tokens per 1M and web searches per 1k', () => {
    expect(costOf('claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 1_000_000, searchRequests: 0 })).toBeCloseTo(30);
    expect(costOf('claude-sonnet-5-5', { inputTokens: 1000, outputTokens: 2000, searchRequests: 1 })).toBeCloseTo(0.003 + 0.03 + 0.01);
    expect(costOf('text-embedding-3-small', { inputTokens: 1_000_000, outputTokens: 0, searchRequests: 0 })).toBeCloseTo(0.02);
  });

  it('returns 0 for an unknown model and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const usage = { inputTokens: 10, outputTokens: 10, searchRequests: 0 };
    expect(costOf('mystery-model-x', usage)).toBe(0);
    expect(costOf('mystery-model-x', usage)).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
