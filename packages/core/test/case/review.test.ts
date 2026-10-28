import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listInputs } from '../../src/calc/inputs';
import { computeNumbers } from '../../src/calc/numbers';
import type { CaseSections } from '../../src/case/schema';
import { safeHttpUrl } from '../../src/case/links';
import { EXPIRED_PLACEHOLDER } from '../../src/case/expired';
import {
  STATUS_EMOJI, STATUS_LABEL, cleanQuote, competitorChecks, forYouToCheck, inputStatus, linkFlags, signalStatus,
  type ClaimRow, type ClaimStatus,
} from '../../src/case/review';

const FIXTURE = new URL('../helpers/fixtures/case-draft.json', import.meta.url);

function sectionsFixture(mutate?: (s: CaseSections) => void): CaseSections {
  const { title: _t, usedSignalUrls: _u, ...draft } = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const s: CaseSections = {
    ...draft,
    summary: { ...draft.summary, gateFlags: [] },
    evidence: {
      claims: draft.evidence.claims,
      signals: [{ quote: 'Our forms die after plugin updates', url: 'https://news.example/item/1', sourceName: 'Hacker News' }],
    },
    numbers: { inputs: draft.numbers.inputs, results: computeNumbers(draft.numbers.inputs) },
  };
  mutate?.(s);
  return s;
}

let n = 0;
function claim(verified: ClaimStatus, overrides: Partial<ClaimRow> = {}): ClaimRow {
  n += 1;
  return {
    id: `claim-${n}`, caseId: 'case-1', section: 'evidence', text: `Claim ${n}`, sourceUrl: `https://src.example/${n}`,
    quote: `quote ${n}`, verified, confidence: null, reviewNote: null, checkedAt: null, createdAt: new Date(), ...overrides,
  };
}

/** A verification claim for every displayed link of the sections. */
function settled(s: CaseSections, status: ClaimStatus = 'verified'): ClaimRow[] {
  return [
    ...s.evidence.signals.map((x) => claim(status, { section: 'signal', text: x.quote, sourceUrl: x.url, quote: x.quote })),
    ...listInputs(s.numbers.inputs).flatMap(({ label, sourced }) =>
      sourced.source ? [claim(status, { section: 'numbers', text: `${label}: ${sourced.value}`, sourceUrl: sourced.source.url })] : []),
    ...s.competitors.list.flatMap((x) => [
      claim(status, { section: 'competitor', text: x.name, sourceUrl: x.url, quote: null }),
      claim(status, { section: 'competitor-pricing', text: `${x.name} pricing: ${x.pricing}`, sourceUrl: x.url, quote: null }),
    ]),
  ];
}

describe('case review', () => {
  it('has one emoji and one label per claim status', () => {
    expect(STATUS_EMOJI).toEqual({ verified: '✅', unsupported: '❌', unreachable: '⚠️', needs_review: '🔍', unverified: '⏳' });
    expect(STATUS_LABEL).toEqual({
      verified: '✅ verified', unsupported: '❌ unsupported', unreachable: '⚠️ unreachable', needs_review: '🔍 needs review', unverified: '⏳ unverified',
    });
  });

  it('lists unreachable, needs_review and unverified claims, never unsupported', () => {
    const s = sectionsFixture();
    const r = forYouToCheck(s, [
      ...settled(s),
      claim('unreachable', { text: 'Down claim', sourceUrl: 'https://down.example/' }),
      claim('needs_review', { section: 'numbers', text: 'problem.rate: 3', sourceUrl: 'https://unsure.example/', reviewNote: 'checker unsure (confidence 0.45)' }),
      claim('unverified', { text: 'Never checked', sourceUrl: 'https://later.example/' }),
      claim('unsupported', { text: 'Wrong claim', sourceUrl: 'https://wrong.example/' }),
    ]);
    expect(r.state).toBe('items');
    expect(r.items).toEqual([
      { label: 'Claim', text: 'Down claim', url: 'https://down.example/', reason: 'page could not be loaded by the checker — open it yourself', count: 1 },
      { label: 'Number input', text: 'problem.rate: 3', url: 'https://unsure.example/', reason: 'checker unsure (confidence 0.45)', count: 1 },
      { label: 'Claim', text: 'Never checked', url: 'https://later.example/', reason: 'not checked yet — open it yourself', count: 1 },
    ]);
  });

  it('merges items sharing url + reason + label and counts them', () => {
    const s = sectionsFixture();
    const url = 'https://apex.example/report';
    const r = forYouToCheck(s, [
      ...settled(s),
      claim('unreachable', { text: 'First', sourceUrl: url }),
      claim('unreachable', { text: 'Second', sourceUrl: url }),
      claim('unreachable', { section: 'numbers', text: 'problem.rate: 3', sourceUrl: url }),
    ]);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]!).toMatchObject({ label: 'Claim', text: 'First', count: 2 });
    expect(r.items[1]!).toMatchObject({ label: 'Number input', count: 1 });
  });

  it('lists a competitor whose pricing has no figure', () => {
    const s = sectionsFixture((x) => { x.competitors.list[1]!.pricing = 'Contact sales'; });
    const r = forYouToCheck(s, [...settled(s).filter((c) => c.section !== 'competitor-pricing' || !c.text.startsWith('Synthetic'))]);
    expect(r.items).toContainEqual(expect.objectContaining({
      label: 'Competitor pricing', text: 'Synthetic browser testing platform', reason: 'pricing not published — check it yourself',
    }));
  });

  it('lists displayed links that have no claim at all (legacy cases)', () => {
    const s = sectionsFixture();
    const r = forYouToCheck(s, [claim('verified')]);
    const labels = r.items.map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(['Signal', 'Number input', 'Competitor', 'Competitor pricing']));
    expect(r.items.every((i) => i.reason === 'not checked yet — open it yourself')).toBe(true);
  });

  it('does not list an expired YouTube signal (placeholder quote) as not checked', () => {
    const s = sectionsFixture((x) => {
      x.evidence.signals.push({ quote: EXPIRED_PLACEHOLDER, url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', sourceName: 'YouTube' });
    });
    const r = forYouToCheck(s, settled(s).filter((c) => c.quote !== EXPIRED_PLACEHOLDER));
    expect(r.items.map((i) => i.text)).not.toContain(EXPIRED_PLACEHOLDER);
    expect(r.items.filter((i) => i.label === 'Signal')).toEqual([]);
  });

  it('state is no_claims with zero claim rows and all_clear when every source is settled', () => {
    const s = sectionsFixture();
    const none = forYouToCheck(s, []);
    expect(none.state).toBe('no_claims');
    expect(none.items.length).toBeGreaterThan(0);
    const clear = forYouToCheck(s, [...settled(s), claim('verified'), claim('unsupported')]);
    expect(clear).toEqual({ state: 'all_clear', items: [] });
  });

  it('returns raw text (no escaping)', () => {
    const s = sectionsFixture();
    const r = forYouToCheck(s, [...settled(s), claim('unreachable', { text: '<b>x</b>', section: '<i>odd</i>', reviewNote: 'a & b' })]);
    const item = r.items.find((i) => i.text === '<b>x</b>')!;
    expect(item.text).toBe('<b>x</b>');
    expect(item.label).toBe('<i>odd</i>');
    expect(item.reason).toBe('a & b');
  });

  it('cleans legacy entities and invisible characters from item text and quotes, without escaping', () => {
    expect(cleanQuote('We don&#8217;t &lt;b&gt; raw‮bidi​zw')).toBe('We don’t <b> rawbidizw');
    const s = sectionsFixture();
    const r = forYouToCheck(s, [...settled(s), claim('unreachable', { text: 'It&#x2019;s down' })]);
    expect(r.items.map((i) => i.text)).toContain('It’s down');
  });

  it('linkFlags keeps the worst status per link; signalStatus and inputStatus look links up', () => {
    const sig = { section: 'signal', text: 'q', sourceUrl: 'https://s.example/1', quote: 'q' };
    const f = linkFlags([
      claim('verified', sig), claim('unsupported', sig),
      claim('unreachable', { section: 'numbers', text: 'reachableBuyers: 3000', sourceUrl: 'https://n.example/' }),
    ]);
    expect(signalStatus(f, { url: 'https://s.example/1', quote: 'q' })).toBe('unsupported');
    expect(signalStatus(f, { url: 'https://s.example/1', quote: 'other' })).toBeUndefined();
    expect(inputStatus(f, 'reachableBuyers', 3000)).toBe('unreachable');
    expect(inputStatus(f, 'reachableBuyers', 3001)).toBeUndefined();
  });

  it('competitorChecks: a stored pricing claim beats the price predicate', () => {
    const x = { url: 'https://c.example/p', name: 'Comp', pricing: 'Not published (first 150 testers)' };
    const none = competitorChecks(linkFlags([]), x);
    expect(none).toEqual({ product: { status: null, text: 'not checked' }, pricing: { status: null, text: '🔍 not published — check' } });
    const f = linkFlags([
      claim('verified', { section: 'competitor', text: 'Comp', sourceUrl: x.url, quote: null }),
      claim('needs_review', { section: 'competitor-pricing', text: `Comp pricing: ${x.pricing}`, sourceUrl: x.url, quote: null }),
    ]);
    expect(competitorChecks(f, x)).toEqual({
      product: { status: 'verified', text: '✅ verified' }, pricing: { status: 'needs_review', text: '🔍 needs review' },
    });
  });

  it('competitorChecks reads a legacy "<name>: <pricing>" claim as the old combined check', () => {
    const x = { url: 'https://c.example/p', name: 'Comp', pricing: '$15/month' };
    const f = linkFlags([claim('unsupported', { section: 'competitor', text: 'Comp: $15/month', sourceUrl: x.url, quote: null })]);
    expect(competitorChecks(f, x)).toEqual({
      product: { status: 'unsupported', text: '❌ unsupported (old check: name + pricing)' },
      pricing: { status: 'unsupported', text: '❌ unsupported (old check: name + pricing)' },
    });
    expect(competitorChecks(linkFlags([]), x).pricing).toEqual({ status: null, text: 'not checked' });
  });

  it('safeHttpUrl accepts http(s) only', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'mailto:a@b.c', '/relative', 'notaurl', '']) expect(safeHttpUrl(bad)).toBeNull();
    expect(safeHttpUrl('https://a.test/x')?.hostname).toBe('a.test');
    expect(safeHttpUrl('http://b.test')?.protocol).toBe('http:');
  });
});
