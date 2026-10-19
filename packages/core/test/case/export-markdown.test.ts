import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listInputs } from '../../src/calc/inputs';
import { computeNumbers } from '../../src/calc/numbers';
import { CRITERIA, type CaseSections } from '../../src/case/schema';
import { caseToMarkdown, type CaseRow, type ClaimRow, type ScoreRow } from '../../src/case/export-markdown';

const FIXTURE = new URL('../helpers/fixtures/case-draft.json', import.meta.url);

function caseFixture(opts: { gateFlags?: string[]; mutate?: (s: CaseSections) => void; title?: string } = {}): CaseRow {
  const { title, usedSignalUrls: _used, ...draft } = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const sections: CaseSections = {
    ...draft,
    summary: { ...draft.summary, gateFlags: opts.gateFlags ?? [] },
    evidence: {
      claims: draft.evidence.claims,
      signals: [{ quote: 'Our forms die after plugin updates', url: 'https://news.example/item/1', sourceName: 'Hacker News' }],
    },
    numbers: { inputs: draft.numbers.inputs, results: computeNumbers(draft.numbers.inputs) },
  };
  opts.mutate?.(sections);
  const now = new Date('2026-10-17T00:00:00Z');
  return {
    id: 'case-1', ideaId: 'idea-1', slug: 'lead-flow-verification', title: opts.title ?? title, stage: 'new',
    sections, killReason: null, gateAdvisory: (opts.gateFlags ?? []).length > 0, model: 'claude-x', promptVersion: 'case-write.v1',
    createdAt: now, updatedAt: now,
  };
}

let n = 0;
function claim(verified: ClaimRow['verified'], overrides: Partial<ClaimRow> = {}): ClaimRow {
  n += 1;
  return {
    id: `claim-${n}`, caseId: 'case-1', section: 'evidence', text: `Claim ${n} (${verified})`, sourceUrl: `https://src.example/${n}`,
    quote: `quote ${n}`, verified, confidence: null, reviewNote: null, checkedAt: null, createdAt: new Date(), ...overrides,
  };
}

function aiScores(): ScoreRow[] {
  return CRITERIA.map((c, i) => ({
    id: `s${i}`, caseId: 'case-1', criterion: c, value: 4, note: `${c} note`, by: 'ai' as const, model: 'gemini-x',
    promptVersion: 'score.v1', createdAt: new Date(),
  }));
}

describe('caseToMarkdown', () => {
  it('renders markdown with gate flags, formulas and claim statuses', () => {
    const md = caseToMarkdown(caseFixture({ gateFlags: ['evidence'] }), [claim('verified'), claim('unreachable')], aiScores());
    expect(md).toMatch(/⚠️ Gate flags: evidence/);
    expect(md).toContain('$3,840');
    expect(md).toContain('✅');
    expect(md).toContain('unreachable');
  });

  it('puts the gate flag block at the top and the sections in tab order', () => {
    const md = caseToMarkdown(caseFixture({ gateFlags: ['evidence', 'control'] }), [], aiScores());
    const lines = md.split('\n');
    expect(lines[0]).toBe('# Lead-flow verification for web agencies');
    expect(md.indexOf('> ⚠️ Gate flags: evidence, control')).toBeLessThan(md.indexOf('## Summary'));
    const order = ['## Summary', '## For you to check', '## Evidence', '## Numbers', '## Competitors', '## Pitch', '## Score'].map((h) => md.indexOf(`\n${h}\n`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('omits the gate flag block when there are no flags', () => {
    expect(caseToMarkdown(caseFixture(), [], [])).not.toContain('Gate flags');
  });

  it('shows the formulas list and an inputs table with a source link or assumption per input', () => {
    const md = caseToMarkdown(caseFixture(), [], []);
    expect(md).toContain('- Annual price = $8 × 40 × 12 = $3,840');
    expect(md).toMatch(/\| price\.amount \| 8 \| assumption: Our proposed price per monitored site per month/);
    expect(md).toMatch(/\| price\.unitsPerBuyer \| 40 \| \[agency-benchmarks\.example\]\(https:\/\/agency-benchmarks\.example\/2026-small-agency-report\)/);
  });

  it('shows every claim status', () => {
    const md = caseToMarkdown(caseFixture(), [claim('verified'), claim('unsupported'), claim('unreachable'), claim('unverified')], []);
    expect(md).toMatch(/✅ verified.*\(verified\)/);
    expect(md).toMatch(/❌ unsupported.*\(unsupported\)/);
    expect(md).toMatch(/⚠️ unreachable.*\(unreachable\)/);
    expect(md).toMatch(/⏳ unverified.*\(unverified\)/);
  });

  it('flags each signal with its verification status and keeps signal rows out of the claims list', () => {
    const sig = claim('unsupported', {
      section: 'signal', text: 'Our forms die after plugin updates', sourceUrl: 'https://news.example/item/1', quote: 'Our forms die after plugin updates',
    });
    const md = caseToMarkdown(caseFixture(), [sig], []);
    expect(md).toContain('- "Our forms die after plugin updates" (Hacker News, [news.example](https://news.example/item/1)) ❌');
    expect(md).toContain('_No claims recorded._');
  });

  it('marks a signal or competitor without a verification claim (e.g. beyond the cap) as not checked', () => {
    const md = caseToMarkdown(caseFixture(), [], []);
    expect(md).toContain('- "Our forms die after plugin updates" (Hacker News, [news.example](https://news.example/item/1)) not checked');
    expect(md).toMatch(/\| Generic uptime monitor \|.*\| not checked \|/);
  });

  it('gives the competitors table a Product and a Pricing status column', () => {
    const url = 'https://uptime-tool.example/pricing';
    const md = caseToMarkdown(caseFixture(), [
      claim('verified', { section: 'competitor', text: 'Generic uptime monitor', sourceUrl: url, quote: null }),
      claim('needs_review', { section: 'competitor-pricing', text: 'Generic uptime monitor pricing: $15/month for 50 monitors', sourceUrl: url, quote: null }),
    ], []);
    expect(md).toContain('| Name | Link | Pricing | Gap | Product | Pricing check |');
    expect(md).toMatch(/\| Generic uptime monitor \| \[uptime-tool\.example\]\(https:\/\/uptime-tool\.example\/pricing\) \| .* \| ✅ verified \| 🔍 needs review \|/);
    expect(md).not.toContain('- ✅ verified: Generic uptime monitor');
    expect(md).not.toMatch(/- 🔍 needs review: Generic uptime monitor/);
  });

  it('shows "not published — check" in the pricing column when the case quotes no figure', () => {
    const kase = caseFixture({ mutate: (s) => { s.competitors.list[0]!.pricing = 'Not published'; } });
    const md = caseToMarkdown(kase, [
      claim('verified', { section: 'competitor', text: 'Generic uptime monitor', sourceUrl: 'https://uptime-tool.example/pricing', quote: null }),
    ], []);
    expect(md).toMatch(/\| Generic uptime monitor \|.*\| Not published \|.*\| ✅ verified \| 🔍 not published — check \|/);
  });

  it('keys competitor flags by url and name, so two competitors on one site keep their own status', () => {
    const kase = caseFixture({ mutate: (s) => { s.competitors.list[1]!.url = s.competitors.list[0]!.url; } });
    const url = kase.sections.competitors.list[0]!.url;
    const md = caseToMarkdown(kase, [
      claim('verified', { section: 'competitor', text: 'Generic uptime monitor', sourceUrl: url, quote: null }),
      claim('unsupported', { section: 'competitor', text: 'Synthetic browser testing platform', sourceUrl: url, quote: null }),
      claim('verified', { section: 'competitor-pricing', text: 'Synthetic browser testing platform pricing: From $99/month', sourceUrl: url, quote: null }),
    ], []);
    expect(md).toMatch(/\| Generic uptime monitor \|.*\| ✅ verified \| not checked \|/);
    expect(md).toMatch(/\| Synthetic browser testing platform \|.*\| ❌ unsupported \| ✅ verified \|/);
  });

  it('lists unreachable links, unsure checks and unpublished prices under "For you to check", but not real failures', () => {
    const kase = caseFixture({ mutate: (s) => { s.competitors.list[1]!.pricing = 'Contact sales'; } });
    const md = caseToMarkdown(kase, [
      claim('unreachable', { text: 'Agencies run 40 sites', sourceUrl: 'https://down.example/report', reviewNote: 'page could not be loaded by the checker — open it yourself' }),
      claim('needs_review', { section: 'competitor', text: 'Generic uptime monitor', sourceUrl: 'https://uptime-tool.example/pricing', quote: null, reviewNote: 'checker unsure (confidence 0.45)' }),
      claim('unsupported', { text: 'Forms fail weekly', sourceUrl: 'https://wrong.example/x' }),
      claim('unreachable', { section: 'signal', text: 'Our forms die after plugin updates', sourceUrl: 'https://news.example/item/1', quote: 'Our forms die after plugin updates' }),
    ], []);
    const start = md.indexOf('\n## For you to check\n');
    const end = md.indexOf('\n## Evidence\n');
    expect(start).toBeGreaterThan(md.indexOf('\n## Summary\n'));
    expect(end).toBeGreaterThan(start);
    const section = md.slice(start, end);
    expect(section).toContain('Agencies run 40 sites');
    expect(section).toContain('[down.example](https://down.example/report)');
    expect(section).toContain('page could not be loaded by the checker — open it yourself');
    expect(section).toContain('Generic uptime monitor');
    expect(section).toContain('checker unsure (confidence 0.45)');
    expect(section).toContain('Synthetic browser testing platform');
    expect(section).toContain('[synthetic-tests.example](https://synthetic-tests.example/pricing)');
    expect(section).toContain('pricing not published');
    // A legacy row without a note still gets a reason.
    expect(section).toMatch(/Our forms die after plugin updates.*news\.example.*page could not be loaded/);
    expect(section).not.toContain('Forms fail weekly');
    expect(md).toContain('❌ unsupported: Forms fail weekly');
  });

  /** A verification claim for every displayed link of the fixture case. */
  function settledClaims(status: ClaimRow['verified'] = 'verified'): ClaimRow[] {
    const s = caseFixture().sections;
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
  const checkSection = (md: string) => md.slice(md.indexOf('\n## For you to check\n'), md.indexOf('\n## Evidence\n'));

  it('says there is nothing to check only when every displayed source was confirmed or flagged', () => {
    const md = caseToMarkdown(caseFixture(), [...settledClaims(), claim('verified'), claim('unsupported')], []);
    expect(md).toContain('## For you to check\n\nNothing — every displayed source was confirmed or flagged.\n');
    expect(checkSection(md)).not.toMatch(/^- /m);
  });

  it('lists never-checked (unverified) claims and does not claim all-clear', () => {
    const md = caseToMarkdown(caseFixture(), [...settledClaims(), claim('unverified', { text: 'Agencies churn yearly', sourceUrl: 'https://churn.example/' })], []);
    const section = checkSection(md);
    expect(section).toMatch(/Agencies churn yearly \(\[churn\.example\]\(https:\/\/churn\.example\/\)\): not checked yet — open it yourself/);
    expect(md).not.toContain('Nothing — every displayed source');
  });

  it('lists displayed links that have no verification claim at all (legacy cases)', () => {
    const md = caseToMarkdown(caseFixture(), [claim('verified')], []);
    const section = checkSection(md);
    expect(section).toMatch(/\*\*Signal:\*\* Our forms die after plugin updates .*not checked yet — open it yourself/);
    expect(section).toMatch(/\*\*Number input:\*\* reachableBuyers: 3000 .*not checked yet/);
    expect(section).toMatch(/\*\*Competitor:\*\* Generic uptime monitor .*not checked yet/);
    expect(md).not.toContain('Nothing — every displayed source');
  });

  it('reads a legacy "<name>: <pricing>" competitor claim (before tuning-2) as that competitor\'s check', () => {
    const kase = caseFixture({ mutate: (s) => { s.competitors.list[1]!.pricing = 'Not published'; } });
    const [a, b] = kase.sections.competitors.list;
    const md = caseToMarkdown(kase, [
      ...settledClaims().filter((c) => c.section !== 'competitor' && c.section !== 'competitor-pricing'),
      claim('unsupported', { section: 'competitor', text: `${a!.name}: ${a!.pricing}`, sourceUrl: a!.url, quote: null }),
      claim('unreachable', { section: 'competitor', text: `${b!.name}: Not published`, sourceUrl: b!.url, quote: null }),
    ], []);
    const old = '(old check: name + pricing)';
    expect(md).toContain(`| ❌ unsupported ${old} | ❌ unsupported ${old} |`);
    expect(md).toMatch(/\| Synthetic browser testing platform \|.*\| ⚠️ unreachable \(old check: name \+ pricing\) \| 🔍 not published — check \|/);
    const section = checkSection(md);
    expect(section).not.toContain('not checked yet');
    expect(section).not.toContain('Generic uptime monitor');
    expect(section).toMatch(/\*\*Competitor:\*\* Synthetic browser testing platform: Not published .*page could not be loaded/);
    expect(section).toMatch(/\*\*Competitor pricing:\*\* Synthetic browser testing platform .*pricing not published/);
    expect(section.match(/^- /gm)).toHaveLength(2);
  });

  it('shows an unconfirmable competitor claim (needs_review from verify) as 🔍 and lists it with its note', () => {
    const note = 'the checker could not find this on the linked page — check it yourself';
    const [a] = caseFixture().sections.competitors.list;
    const md = caseToMarkdown(caseFixture(), [
      ...settledClaims().filter((c) => !(c.section.startsWith('competitor') && c.sourceUrl === a!.url)),
      claim('needs_review', { section: 'competitor', text: a!.name, sourceUrl: a!.url, quote: null, reviewNote: note }),
      claim('needs_review', { section: 'competitor-pricing', text: `${a!.name} pricing: ${a!.pricing}`, sourceUrl: a!.url, quote: null, reviewNote: note }),
    ], []);
    expect(md).toMatch(/\| Generic uptime monitor \|.*\| 🔍 needs review \| 🔍 needs review \|/);
    const section = checkSection(md);
    // Product and pricing share the url and the note but not the label, so they stay on separate lines (D4).
    expect(section.split('\n').filter((l) => l.startsWith('- '))).toEqual([
      `- **Competitor:** Generic uptime monitor ([uptime-tool.example](https://uptime-tool.example/pricing)): ${note}`,
      `- **Competitor pricing:** Generic uptime monitor pricing: $15/month for 50 monitors ([uptime-tool.example](https://uptime-tool.example/pricing)): ${note}`,
    ]);
    expect(md).not.toContain('❌');
  });

  it('merges "For you to check" items that share a url, reason and label, keeping the first and counting the claims', () => {
    const down = 'https://apex.example/report';
    const reviewNote = 'page could not be loaded by the checker — open it yourself';
    const md = caseToMarkdown(caseFixture(), [
      ...settledClaims(),
      claim('unreachable', { text: 'Overpayments run 1%', sourceUrl: down, reviewNote }),
      claim('unreachable', { text: 'Audits recover 20%', sourceUrl: down, reviewNote }),
      claim('unreachable', { text: 'Recovery takes 90 days', sourceUrl: down, reviewNote }),
      claim('unreachable', { section: 'numbers', text: 'problem.rate: 3', sourceUrl: down, reviewNote }),
      claim('needs_review', { text: 'Same page, different reason', sourceUrl: down, reviewNote: 'checker unsure (confidence 0.45)' }),
    ], []);
    const section = checkSection(md);
    const lines = section.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toEqual([
      `- **Claim:** Overpayments run 1% ([apex.example](${down})): ${reviewNote} (3 claims)`,
      `- **Number input:** problem.rate: 3 ([apex.example](${down})): ${reviewNote}`,
      `- **Claim:** Same page, different reason ([apex.example](${down})): checker unsure (confidence 0.45)`,
    ]);
  });

  it('keeps a competitor\'s product and pricing items on separate lines even with the same url and reason', () => {
    const kase = caseFixture();
    const [a] = kase.sections.competitors.list;
    const reviewNote = 'page could not be loaded by the checker — open it yourself';
    const md = caseToMarkdown(kase, [
      ...settledClaims().filter((c) => !(c.section.startsWith('competitor') && c.sourceUrl === a!.url)),
      claim('unreachable', { section: 'competitor', text: a!.name, sourceUrl: a!.url, quote: null, reviewNote }),
      claim('unreachable', { section: 'competitor-pricing', text: `${a!.name} pricing: ${a!.pricing}`, sourceUrl: a!.url, quote: null, reviewNote }),
    ], []);
    const lines = checkSection(md).split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^- \*\*Competitor:\*\* Generic uptime monitor .*open it yourself$/);
    expect(lines[1]).toMatch(/^- \*\*Competitor pricing:\*\* Generic uptime monitor pricing: .*open it yourself$/);
  });

  it('tells the owner to verify everything when the case has no claims', () => {
    const md = caseToMarkdown(caseFixture(), [], []);
    expect(md).toContain('## For you to check\n\nThis case has no checked sources — verify everything yourself.\n');
    expect(md).not.toContain('Nothing — every displayed source');
  });

  it('shows the 🔍 status for a needs_review claim', () => {
    const md = caseToMarkdown(caseFixture(), [claim('needs_review')], []);
    expect(md).toMatch(/🔍 needs review.*\(needs_review\)/);
  });

  it('shows the worst status when two claims share a url and text', () => {
    const sig = { section: 'signal', text: 'Our forms die after plugin updates', sourceUrl: 'https://news.example/item/1', quote: 'Our forms die after plugin updates' };
    const md = caseToMarkdown(caseFixture(), [claim('unsupported', sig), claim('verified', sig)], []);
    expect(md).toContain('(Hacker News, [news.example](https://news.example/item/1)) ❌');
  });

  it('flags each sourced number input in its source cell', () => {
    const input = claim('unreachable', {
      section: 'numbers', text: 'price.unitsPerBuyer: 40', sourceUrl: 'https://agency-benchmarks.example/2026-small-agency-report',
    });
    const md = caseToMarkdown(caseFixture(), [input], []);
    expect(md).toMatch(/\| price\.unitsPerBuyer \| 40 \| \[agency-benchmarks\.example\]\([^)]*\): "[^"]*" ⚠️ \|/);
    expect(md).toContain('⚠️ unreachable: price.unitsPerBuyer: 40');
  });

  it('renders AI and owner scores as criterion | value | note tables', () => {
    const owner: ScoreRow = { ...aiScores()[0]!, id: 'o1', criterion: 'gut', value: 2, note: 'meh', by: 'owner', model: null, promptVersion: null };
    const md = caseToMarkdown(caseFixture(), [], [...aiScores(), owner]);
    expect(md).toContain('| Criterion | Value | Note |');
    expect(md).toContain('| pain | 4 | pain note |');
    expect(md).toContain('### Owner scores');
    expect(md).toContain('| gut | 2 | meh |');
  });

  it('escapes untrusted text and only links http(s) urls', () => {
    const kase = caseFixture({
      title: 'Evil <script>alert(1)</script> & co',
      gateFlags: ['<b>x</b>'],
      mutate: (s) => {
        s.summary.problem = 'See ![img](https://evil.example/x.png) and [click](javascript:alert(1))';
        s.competitors.list[0]!.url = 'javascript:alert(1)';
        s.competitors.list[0]!.gap = 'a | b\nc';
      },
    });
    const md = caseToMarkdown(kase, [claim('verified', { sourceUrl: 'javascript:alert(2)', quote: '<img src=x onerror=alert(3)>' })], []);
    expect(md).toContain('# Evil &lt;script&gt;alert(1)&lt;/script&gt; &amp; co');
    expect(md).toContain('Gate flags: &lt;b&gt;x&lt;/b&gt;');
    expect(md).not.toMatch(/<script|<img|<b>/);
    expect(md).toContain('!\\[img\\](https://evil.example/x.png)');
    expect(md).toContain('\\[click\\](javascript:alert(1))');
    expect(md).not.toMatch(/(^|[^\\])\]\(javascript:/m);
    expect(md).toContain('javascript:alert(1)');
    expect(md).toContain('a \\| b c');
  });

  it('decodes HTML entities in legacy stored quotes before escaping them', () => {
    const quote = 'We don&#8217;t know &amp; can&rsquo;t see it &lt;b&gt;';
    const kase = caseFixture({ mutate: (s) => { s.evidence.signals = [{ quote, url: 'https://news.example/item/9', sourceName: 'HN' }]; } });
    const md = caseToMarkdown(kase, [
      claim('verified', { section: 'signal', text: quote, sourceUrl: 'https://news.example/item/9', quote }),
      claim('verified', { text: 'Owners claim', quote: 'It&#x2019;s broken' }),
    ], []);
    expect(md).toContain('- "We don’t know &amp; can’t see it &lt;b&gt;" (HN, [news.example](https://news.example/item/9)) ✅');
    expect(md).toContain('  - Quote: "It’s broken"');
    expect(md).not.toContain('&#8217;');
    expect(md).not.toMatch(/<b>/);
  });

  it('keeps control and invisible characters (encoded or raw) out of rendered quotes', () => {
    const quote = 'evil &#x202E;txt.exe &#27;[31m zero&#x200B;width raw‮bidi​zw\u0007bell';
    const kase = caseFixture({ mutate: (s) => { s.evidence.signals = [{ quote, url: 'https://news.example/item/9', sourceName: 'HN' }]; } });
    const md = caseToMarkdown(kase, [
      claim('unreachable', { section: 'signal', text: quote, sourceUrl: 'https://news.example/item/9', quote }),
      claim('verified', { text: 'c', quote }),
    ], []);
    expect(md).not.toMatch(/[‮​\u001B\u0007]/u);
    expect(md).toContain('rawbidizwbell');
  });

  it('uses an existing competitor-pricing claim even when the pricing text does not look like a price', () => {
    const pricing = 'Not published (first 150 testers)';
    const kase = caseFixture({ mutate: (s) => { s.competitors.list[0]!.pricing = pricing; } });
    const url = kase.sections.competitors.list[0]!.url;
    const md = caseToMarkdown(kase, [
      ...settledClaims().filter((c) => !(c.section.startsWith('competitor') && c.sourceUrl === url)),
      claim('verified', { section: 'competitor', text: 'Generic uptime monitor', sourceUrl: url, quote: null }),
      claim('verified', { section: 'competitor-pricing', text: `Generic uptime monitor pricing: ${pricing}`, sourceUrl: url, quote: null }),
    ], []);
    expect(md).toMatch(/\| Generic uptime monitor \|.*\| ✅ verified \| ✅ verified \|/);
    expect(md).not.toContain('not published — check');
    expect(md).toContain('Nothing — every displayed source was confirmed or flagged.');
  });

  it('escapes an unknown claim section used as a label', () => {
    const md = caseToMarkdown(caseFixture(), [claim('unverified', { section: '<b>odd</b>', text: 'x' })], []);
    expect(md).toContain('**&lt;b&gt;odd&lt;/b&gt;:**');
    expect(md).not.toMatch(/<b>/);
  });

  it('percent-encodes parentheses in link targets', () => {
    const md = caseToMarkdown(caseFixture(), [claim('verified', { sourceUrl: 'https://x.example/a_(b) c' })], []);
    expect(md).toContain('[x.example](https://x.example/a_%28b%29%20c)');
  });
});
