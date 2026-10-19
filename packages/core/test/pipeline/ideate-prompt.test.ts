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
  it('is v7 and carries no benchmark-specific examples', () => {
    expect(loadPrompt('ideate').version).toBe('ideate.v7');
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
  it('says a new buyer or channel is not a differentiator and asks for known incumbents and the functional gap (option a)', () => {
    const text = render();
    expect(text).toContain(
      'A new buyer, channel, distribution wedge or packaging of an existing product is NOT a differentiator. ' +
        'If the only difference between your idea and something already sold is who buys it or how it is sold, do not propose it.',
    );
    expect(text).toContain(
      'For each idea, list the incumbents you know (check `<already-sold>` first, then your own knowledge) in `knownIncumbents` ' +
        '(empty only if you truly know of none), and state in `functionalGap` the specific function or capability they leave unserved. ' +
        'The gap must be about what the product does, not who it is for.',
    );
  });
  it('counts only operator and neutral signals as evidence; vendor and untagged signals never count (fail closed)', () => {
    const text = render();
    expect(text).toContain('at least 3 signals from at least 3 different websites');
    expect(text).toContain('counting only signals whose voice is `operator` or `neutral`');
    expect(text).toContain('they may inform what already exists, but they never count as evidence of pain');
    expect(text).toContain('Signals with voice `untagged` were never classified and never count as evidence of pain either.');
    expect(text).not.toContain('unknown');
  });
});
