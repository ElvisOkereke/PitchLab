import { describe, expect, it } from 'vitest';
import { loadPrompt } from '../../src/llm/prompts';

const banned = (w: string) => new RegExp('\\b' + w + '\\b', 'i');

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
      expect(text).not.toMatch(banned(w));
    }
  });
  it('word-boundary check bites (positive control)', () => {
    expect('Lead form').toMatch(banned('lead'));
    expect('An AGENCY owner').toMatch(banned('agency'));
    expect('uptime monitor').toMatch(banned('uptime'));
    expect('misleading').not.toMatch(banned('lead'));
  });
  it('asks for variety of industry, buyer and mechanism', () => {
    expect(render()).toContain('Ideas must vary in industry, buyer and mechanism. Monitoring/alerting is only one of many possible mechanisms.');
  });
});
