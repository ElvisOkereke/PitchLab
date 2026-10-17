import { describe, expect, it } from 'vitest';
import { loadPrompt } from '../../src/llm/prompts';

const render = () =>
  loadPrompt('ideate').render({
    market: 'Canada + US', lensName: 'L', lensPattern: 'P', lensHint: 'H',
    signals: '<signals></signals>', priorIdeas: '<prior-ideas></prior-ideas>', count: '3', minSignals: '3',
  });

describe('ideate prompt', () => {
  it('is v4 and carries no benchmark-specific examples', () => {
    expect(loadPrompt('ideate').version).toBe('ideate.v4');
    const text = render();
    for (const w of ['lead', 'leads', 'contact form', 'agency', 'uptime']) {
      expect(text).not.toMatch(new RegExp(`\b${w}\b`, 'i'));
    }
  });
  it('asks for variety of industry, buyer and mechanism', () => {
    expect(render()).toContain('Ideas must vary in industry, buyer and mechanism. Monitoring/alerting is only one of many possible mechanisms.');
  });
});
