import { describe, expect, it } from 'vitest';
import { loadPrompt } from '../../src/llm/prompts';

describe('loadPrompt', () => {
  it('loads latest version and renders vars', () => {
    const p = loadPrompt('extract-signals');
    expect(p.version).toBe('extract-signals.v3');
    expect(() => p.render({})).toThrow(/items/);
    expect(p.render({ countries: 'CA, US', items: 'X' })).toContain('CA, US');
  });
  it('throws on unknown vars and unknown prompts', () => {
    const p = loadPrompt('extract-signals');
    expect(() => p.render({ countries: 'a', items: 'b', bogus: 'c' })).toThrow(/bogus/);
    expect(() => loadPrompt('nope')).toThrow(/not found/);
  });
  it('latest versions after tuning-4', () => {
    expect(['ideate', 'gate', 'screen', 'extract-signals', 'harvest-research'].map((n) => loadPrompt(n).version))
      .toEqual(['ideate.v8', 'gate.v3', 'screen.v4', 'extract-signals.v3', 'harvest-research.v5']);
  });
  it('normalises CRLF line endings (Windows checkouts with core.autocrlf)', () => {
    expect(loadPrompt('extract-signals').render({ countries: 'CA, US', items: 'X' })).not.toContain('\r');
  });
});
