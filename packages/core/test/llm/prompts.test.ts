import { describe, expect, it } from 'vitest';
import { loadPrompt } from '../../src/llm/prompts';
import { extractAudienceVars } from '../../src/pipeline/harvest';

const AUDIENCE = extractAudienceVars('business');

describe('loadPrompt', () => {
  it('loads latest version and renders vars', () => {
    const p = loadPrompt('extract-signals');
    expect(p.version).toBe('extract-signals.v4');
    expect(() => p.render({})).toThrow(/items/);
    expect(p.render({ ...AUDIENCE, countries: 'CA, US', items: 'X' })).toContain('CA, US');
  });
  it('throws on unknown vars and unknown prompts', () => {
    const p = loadPrompt('extract-signals');
    expect(() => p.render({ ...AUDIENCE, countries: 'a', items: 'b', bogus: 'c' })).toThrow(/bogus/);
    expect(() => loadPrompt('nope')).toThrow(/not found/);
  });
  it('latest versions after the generation rebuild', () => {
    expect(['ideate', 'gate', 'screen', 'extract-signals', 'harvest-research'].map((n) => loadPrompt(n).version))
      .toEqual(['ideate.v9', 'gate.v3', 'screen.v4', 'extract-signals.v4', 'harvest-research.v6']);
  });
  it('normalises CRLF line endings (Windows checkouts with core.autocrlf)', () => {
    expect(loadPrompt('extract-signals').render({ ...AUDIENCE, countries: 'CA, US', items: 'X' })).not.toContain('\r');
  });
});
