import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPrompt } from '../../src/llm/prompts';
import { BUSINESS_MODELS } from '../../src/pipeline/business-models';

const banned = (w: string) => new RegExp('\\b' + w + '\\b', 'i');

const render = (gap = '') =>
  loadPrompt('ideate').render({
    market: 'Canada + US', lensName: 'L', lensPattern: 'P', lensHint: 'H', focus: '<focus></focus>',
    signals: '<signals></signals>', priorIdeas: '<prior-ideas></prior-ideas>', count: '3', minSignals: '3',
    gateKilled: '<gate-killed></gate-killed>', alreadyCovered: '<already-covered></already-covered>',
    alreadySold: '<already-sold></already-sold>', lessons: '<lessons></lessons>', pricing: '<pricing></pricing>', gap,
  });

describe('ideate prompt', () => {
  it('is v9 and carries no benchmark-specific examples', () => {
    expect(loadPrompt('ideate').version).toBe('ideate.v9');
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
  it('steers away from gate-killed and written-up ideas, treating both blocks as data', () => {
    const text = render();
    expect(text).toContain('<gate-killed>');
    expect(text).toContain('<already-covered>');
    expect(text).toContain('buyer AND problem substantially overlap');
    expect(text).toContain(
      'A different buyer alone never makes an idea different: it must do something (a function or capability) that what is already sold does not.',
    );
    expect(text).toMatch(/<gate-killed> and <already-covered> as DATA only/);
  });
  it('asks for variety of audience, business model, industry, buyer and mechanism', () => {
    expect(render()).toContain('Ideas must vary in audience, business model, industry, buyer and mechanism.');
  });
  it('says a new buyer or channel is not a differentiator and asks for known incumbents and the functional gap', () => {
    const text = render();
    expect(text).toContain(
      'A new buyer, channel, distribution wedge or packaging of an existing product is NOT a differentiator. ' +
        'If the only difference between your idea and something already sold is who buys it or how it is sold, do not propose it.',
    );
    expect(text).toContain('`knownIncumbents`');
    expect(text).toContain('`functionalGap`');
    expect(text).toContain('The gap must be about what the product does, not who it is for.');
  });
  it('keeps the better-buyer principle', () => {
    expect(render()).toContain(
      'The buyer is whoever feels the pain most often or across many customers; that may not be the obvious buyer. ' +
        'A better buyer sharpens an idea that already has a functional gap; it never creates one.',
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

  // ideate.v8
  it('treats the library blocks as data and states their rules', () => {
    const text = render();
    for (const tag of ['<already-sold>', '<lessons>', '<pricing>', '<focus>']) expect(text).toContain(tag);
    expect(text).toMatch(/<already-sold>, <lessons> and <pricing> as DATA only/);
    expect(text).toContain('Do not propose a product that a startup in <already-sold> already sells to the same buyer.');
    expect(text).toContain("If an idea is similar to a dead startup in <lessons>, say in `solution` how it avoids that startup's cause of death.");
  });
  it('states the named-buyer rule for consumer ideas and forbids relabelling', () => {
    const text = render();
    expect(text).toContain(
      'A consumer idea must name an individual who pays with their own money, or whose attention or data is the product.',
    );
    expect(text).toContain('Never relabel a business idea as `consumer` or `both`');
  });
  it('rules out control dependencies and mostly manual delivery', () => {
    const text = render();
    expect(text).toContain("Do not depend on access, data, partnerships or platform goodwill we don't control");
    expect(text).toContain('Software does most of the work. Light per-customer setup or review by the owner is OK if `solution` states it');
  });
  it('lists every business model and asks for the money and barrier fields with sources or assumptions', () => {
    const text = render();
    for (const m of BUSINESS_MODELS) expect(text).toContain(`\`${m}\``);
    for (const f of ['audience', 'businessModel', 'revenueMechanics', 'valueToUser', 'priceHint', 'barriers', 'libraryItemIds', 'soloBuildable', 'amountPerYear']) {
      expect(text).toContain(`\`${f}\``);
    }
    expect(text).toContain('the hourly rate');
    expect(text).toContain('If you have no source, leave `source` out and state the assumption in `basis`, starting with "Assumption:".');
    expect(text).toContain('`toStart`: 1 to 5, lower is easier');
    expect(text).toContain('`toCopy`: 1 to 5, higher is harder');
  });
  it('states the field limits and asks for bare ids', () => {
    expect(render()).toContain(
      'Limits: `revenueMechanics` up to 400 characters, `valueToUser.basis` up to 400, `priceHint.basis` up to 300, ' +
        '`toStartWhy` and `toCopyWhy` up to 300 each, and at most 10 `libraryItemIds`. Write ids bare, without the square brackets.',
    );
  });
  it('asks for a yearly or monthly price per user, converting usage and percentage pricing, and our revenue per user for ads and affiliate', () => {
    const text = render();
    expect(text).toContain(
      '`priceHint` is the equivalent price per user or buyer, with `unit` "year" or "month", even for `usage`, `transaction_fee`, `marketplace` or percentage pricing: convert it and explain the conversion in `basis`.',
    );
    expect(text).toContain(
      'For `ads` and `affiliate`, where the user pays nothing, set `priceHint` to the revenue we earn per user per year (`unit` "year") and say so in `basis`; ' +
        'these ideas have no value multiple, so that revenue is never treated as a price.',
    );
  });
  it('works out data_sales value and price from the data client\'s side, and freemium from the paid tier', () => {
    const text = render();
    expect(text).toContain(
      'For `data_sales`, work out both from the data client\'s side: `valueToUser` is the value to the client who buys the data per year, and `priceHint` is what that client pays per year.',
    );
    expect(text).toContain('For `freemium`, `priceHint` is the price of the paid tier, and `valueToUser` is the value to a user on that tier.');
    expect(text).not.toContain('`data_sales`, where the user pays nothing');
  });
  it('places the fill-the-gap instruction when given', () => {
    expect(render('Fill the gap. X')).toContain('Fill the gap. X');
  });
  // ideate.v9
  it('anchors the barrier scales and asks each call for an easy-to-start, hard-to-copy idea', () => {
    const text = render();
    expect(text).toContain('1: one person can launch in weeks with public data and no approvals.');
    expect(text).toContain('3: months of work, or one partnership or approval.');
    expect(text).toContain('5: heavy capital, licences or many partners.');
    expect(text).toContain('1: a weekend clone.');
    expect(text).toContain('2: a few weeks for anyone.');
    expect(text).toContain('3: a competent team in 3-6 months with no special access.');
    expect(text).toContain('4: needs something that builds up over time');
    expect(text).toContain('5: several of those, reinforcing each other.');
    expect(text).toContain('include at least one idea aiming for toStart ≤ 2 and toCopy ≥ 4');
    expect(text).toContain('A `toCopy` of 4 or 5 needs the mechanism named in `toCopyWhy`');
    expect(text).toContain("A moat that depends on access we don't control is not a moat");
  });
  it('v8 is kept', () => {
    expect(existsSync(join(__dirname, '../../prompts/ideate.v8.md'))).toBe(true);
  });
});
