import { describe, expect, it } from 'vitest';
import { loadPrompt } from '../../src/llm/prompts';

describe('loadPrompt', () => {
  it('loads latest version and renders vars', () => {
    const p = loadPrompt('extract-signals');
    expect(p.version).toBe('extract-signals.v1');
    expect(() => p.render({})).toThrow(/items/);
    expect(p.render({ countries: 'CA, US', items: 'X' })).toContain('CA, US');
  });
  it('throws on unknown vars and unknown prompts', () => {
    const p = loadPrompt('extract-signals');
    expect(() => p.render({ countries: 'a', items: 'b', bogus: 'c' })).toThrow(/bogus/);
    expect(() => loadPrompt('nope')).toThrow(/not found/);
  });
});
