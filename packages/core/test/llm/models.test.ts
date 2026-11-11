import { describe, it, expect, vi, afterEach } from 'vitest';
import { DEFAULT_MODELS, MODEL_STAGES, adapterFor, family, resolveModelConfig, validateModelConfig } from '../../src/config/models';
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

  it('has a review stage on the score model by default, a different family from ideate', () => {
    expect(MODEL_STAGES).toContain('review');
    expect(DEFAULT_MODELS.review).toBe(DEFAULT_MODELS.score);
    expect(() => validateModelConfig({ ...DEFAULT_MODELS, review: 'claude-sonnet-5-5' })).toThrow(/review/);
  });

  it('review follows a score override unless it has its own', () => {
    expect(resolveModelConfig({})).toEqual(DEFAULT_MODELS);
    expect(resolveModelConfig({ score: 'gpt-6-sol' })).toMatchObject({ score: 'gpt-6-sol', review: 'gpt-6-sol' });
    expect(resolveModelConfig({ score: 'gpt-6-sol', review: 'gemini-3.1-pro' })).toMatchObject({ score: 'gpt-6-sol', review: 'gemini-3.1-pro' });
    expect(resolveModelConfig({ review: 'gpt-6-sol' })).toMatchObject({ score: DEFAULT_MODELS.score, review: 'gpt-6-sol' });
    expect(resolveModelConfig({ bogus: 'x' } as Record<string, string>)).toEqual(DEFAULT_MODELS);
  });

  it('rejects a non-claude research stage', () => {
    expect(() => validateModelConfig({ ...DEFAULT_MODELS, case: 'gpt-6-sol' })).toThrow(/case/);
  });

  it('has validation-pack stages with their defaults', () => {
    expect(MODEL_STAGES).toEqual(expect.arrayContaining(['pack', 'prospect', 'outreach', 'landing']));
    expect(DEFAULT_MODELS).toMatchObject({
      pack: 'claude-opus-5-5', prospect: 'claude-sonnet-5-5', outreach: 'claude-sonnet-5-5', landing: 'claude-sonnet-5-5',
    });
  });

  it('has the research library stages with their defaults', () => {
    expect(MODEL_STAGES).toEqual(expect.arrayContaining(['research', 'library_extract']));
    expect(DEFAULT_MODELS).toMatchObject({ research: 'claude-sonnet-5-5', library_extract: 'claude-haiku-5-5' });
  });

  it('requires the prospect stage to be a claude model (web search)', () => {
    expect(() => validateModelConfig({ ...DEFAULT_MODELS, prospect: 'gpt-6-sol' })).toThrow(/prospect.*claude/);
    expect(() => validateModelConfig({ ...DEFAULT_MODELS, prospect: 'gemini-3.1-pro' })).toThrow(/prospect/);
  });

  it('requires the research stage to be a claude model (missions use web search)', () => {
    expect(() => validateModelConfig({ ...DEFAULT_MODELS, research: 'gpt-6-sol' })).toThrow(/research.*claude/);
  });

  it('lets pack, outreach and landing run on any family', () => {
    expect(() => validateModelConfig({ ...DEFAULT_MODELS, pack: 'gpt-6-sol', outreach: 'gemini-3.1-pro', landing: 'gpt-6-sol' })).not.toThrow();
  });

  it('every stage has a default model, and every default model has a price', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const stage of MODEL_STAGES) {
      expect(DEFAULT_MODELS[stage], stage).toBeTruthy();
      expect(costOf(DEFAULT_MODELS[stage], { inputTokens: 1_000_000, outputTokens: 0, searchRequests: 0 }), stage).toBeGreaterThan(0);
    }
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
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

describe('engine v2 model stages', () => {
  it('has sketch and judge with the specified defaults, judge a different family from ideate', () => {
    expect(MODEL_STAGES).toEqual(expect.arrayContaining(['sketch', 'judge']));
    expect(DEFAULT_MODELS.sketch).toBe('claude-sonnet-5-5');
    expect(DEFAULT_MODELS.judge).toBe('gpt-6-sol');
    expect(family(DEFAULT_MODELS.judge)).not.toBe(family(DEFAULT_MODELS.ideate));
    expect(() => validateModelConfig({ ...DEFAULT_MODELS, judge: 'claude-sonnet-5-5' })).toThrow(/judge/);
  });
  it('judge must also be a different family from sketch (the judge ranks what sketch wrote)', () => {
    expect(() => validateModelConfig({ ...DEFAULT_MODELS, sketch: 'gpt-6-sol' })).toThrow(/judge.*sketch/);
    expect(() => validateModelConfig({ ...DEFAULT_MODELS, sketch: 'gemini-3.1-pro' })).not.toThrow();
  });
  it('sketch follows ideate and judge follows gate for overrides, unless they have their own', () => {
    expect(resolveModelConfig({ ideate: 'claude-haiku-5-5' }).sketch).toBe('claude-haiku-5-5');
    expect(resolveModelConfig({ gate: 'gemini-3.1-pro' }).judge).toBe('gemini-3.1-pro');
    expect(resolveModelConfig({ gate: 'gemini-3.1-pro', judge: 'gpt-6-sol' }).judge).toBe('gpt-6-sol');
    expect(resolveModelConfig({}).sketch).toBe('claude-sonnet-5-5');
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
