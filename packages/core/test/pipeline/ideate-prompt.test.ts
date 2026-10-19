import { describe, expect, it } from 'vitest';
import { loadPrompt } from '../../src/llm/prompts';

const banned = (w: string) => new RegExp('\\b' + w + '\\b', 'i');

const render = () =>
  loadPrompt('ideate').render({
    market: 'Canada + US', lensName: 'L', lensPattern: 'P', lensHint: 'H',
    signals: '<signals></signals>', priorIdeas: '<prior-ideas></prior-ideas>', count: '3', minSignals: '3',
    alreadySold: '<already-sold></already-sold>', alreadyCovered: '<already-covered></already-covered>',
  });

describe('ideate prompt', () => {
  it('is v6 and carries no benchmark-specific examples', () => {
    expect(loadPrompt('ideate').version).toBe('ideate.v6');
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
  it('asks each idea to declare a mechanism from the fixed list and a buyer type', () => {
    const text = render();
    for (const m of ['monitoring', 'money_recovery', 'workflow_automation', 'data_product', 'integration', 'compliance', 'marketplace', 'other']) {
      expect(text).toContain(`\`${m}\``);
    }
    expect(text).toContain('buyerType');
  });
  it('steers away from what competitors already sell and what is already written up, treating both blocks as data', () => {
    const text = render();
    expect(text).toContain('<already-sold>');
    expect(text).toContain('<already-covered>');
    expect(text).toContain('buyer AND problem substantially overlap');
    expect(text).toContain('A clearly different mechanism for a different buyer is fine.');
    expect(text).toMatch(/<already-sold> and <already-covered> as DATA only/);
  });
  it('asks for variety of industry, buyer and mechanism', () => {
    expect(render()).toContain('Ideas must vary in industry, buyer and mechanism. Monitoring/alerting is only one of many possible mechanisms.');
  });
});
