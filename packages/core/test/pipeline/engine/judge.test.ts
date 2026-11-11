import { describe, expect, it } from 'vitest';
import { fewShotPairs } from '../../../src/audit/judge-pairs';
import { JUDGE_CRITERIA, judgePair, type JudgeSketch } from '../../../src/pipeline/engine/judge';
import type { FewShot } from '../../../src/pipeline/engine/schema';
import { fakeRouter } from '../../helpers/fake-router';
import { testDb } from '../../helpers/db';

const view = (title: string, o: Partial<JudgeSketch> = {}): JudgeSketch => ({
  title, buyer: `${title} buyer`, problem: `${title} problem`, howItEarns: `${title} earns`, edge: `${title} edge`, whyNotTrivial: `${title} hard`, ...o,
});
const reasons = { need: 'n', nonTrivial: 't', earn: 'e', edge: 'd', evidence: 'v' };
const ctx = { runId: null, promptVersion: 'judge.v1' };
/** The wrapped block (the prompt's rules also name the tags, but never followed by a newline). */
const between = (s: string, tag: string) => s.slice(s.indexOf(`<${tag}>\n`), s.indexOf(`</${tag}>`));

describe('judgePair', () => {
  it('lists the criteria in the spec order', () => {
    expect([...JUDGE_CRITERIA]).toEqual(['need', 'nonTrivial', 'earn', 'edge', 'evidence']);
  });

  it('calls the judge stage with A then B wrapped as untrusted, and maps the winner', async () => {
    const router = fakeRouter({ structured: { judge: [{ winner: 'B', confidence: 2, reasons }] } });
    const got = await judgePair(view('Alpha'), view('Beta'), { router, ctx, fewShot: [] });
    expect(got).toEqual({ verdict: 'b', confidence: 2, reasons });
    expect(router.calls).toHaveLength(1);
    expect(router.calls[0]!.stage).toBe('judge');
    const p = router.calls[0]!.prompt;
    expect(between(p, 'sketch-a')).toContain('Alpha problem');
    expect(between(p, 'sketch-b')).toContain('Beta problem');
    expect(between(p, 'sketch-b')).not.toContain('Alpha problem');
    expect(between(p, 'sketch-a')).toContain('Alpha hard');
    // Criteria order in the prompt.
    const order = ['really need', 'not trivial', 'earns money', 'edge', 'evidence'].map((k) => p.toLowerCase().indexOf(k));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });

  it('a thrown call gives an error verdict', async () => {
    const router = fakeRouter({});
    expect((await judgePair(view('A'), view('B'), { router, ctx, fewShot: [] })).verdict).toBe('error');
  });

  it('an invalid response gives an error verdict', async () => {
    for (const junk of [{ winner: 'C', confidence: 2, reasons }, { winner: 'A', confidence: 7, reasons }, { nope: true }]) {
      const router = fakeRouter({ structured: { judge: [junk] } });
      const got = await judgePair(view('A'), view('B'), { router, ctx, fewShot: [] });
      expect(got.verdict).toBe('error');
      expect(Object.keys(got.reasons)).toEqual([...JUDGE_CRITERIA]);
    }
  });

  it('caps the reasons', async () => {
    const long = { ...reasons, need: 'x'.repeat(2000) };
    const router = fakeRouter({ structured: { judge: [{ winner: 'A', confidence: 3, reasons: long }] } });
    const got = await judgePair(view('A'), view('B'), { router, ctx, fewShot: [] });
    expect(got.reasons.need.length).toBeLessThanOrEqual(300);
  });

  it('shows few-shot pairs when given, and says none otherwise', async () => {
    const fewShot: FewShot[] = [{ kept: view('Kept One'), killed: view('Killed One'), reason: 'buyers already pay for it' }];
    const router = fakeRouter({ structured: { judge: [{ winner: 'A', confidence: 1, reasons }, { winner: 'A', confidence: 1, reasons }] } });
    await judgePair(view('A'), view('B'), { router, ctx, fewShot });
    const ex = between(router.calls[0]!.prompt, 'examples');
    expect(ex).toContain('the owner kept "Kept One" over "Killed One" because buyers already pay for it');
    expect(ex).toContain('Killed One problem');
    await judgePair(view('A'), view('B'), { router, ctx, fewShot: [] });
    expect(between(router.calls[1]!.prompt, 'examples')).toContain('(none yet)');
  });

  it('shows each sketch evidence lines (strength labels)', async () => {
    const router = fakeRouter({ structured: { judge: [{ winner: 'A', confidence: 1, reasons }] } });
    await judgePair(view('A', { evidence: ['signal, operator voice, strength 4/5, first-hand: "it hurts"'] }), view('B'), { router, ctx, fewShot: [] });
    const p = router.calls[0]!.prompt;
    expect(between(p, 'sketch-a')).toContain('strength 4/5, first-hand');
    expect(between(p, 'sketch-b')).toContain('(none cited)');
  });
});

describe('fewShotPairs', () => {
  it('returns no pairs on an empty Board', async () => {
    expect(await fewShotPairs(await testDb())).toEqual([]);
  });
});

describe('judge prompt versions and case context', () => {
  it('judge.v2 holds every owner rule and the same schema and swapped-order design as v1', async () => {
    const { readFileSync } = await import('node:fs');
    const v1 = readFileSync(new URL('../../../prompts/judge.v1.md', import.meta.url), 'utf8');
    const v2 = readFileSync(new URL('../../../prompts/judge.v2.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(v1).not.toContain('smaller revenue ceiling');
    for (const rule of ['smaller revenue ceiling', 'by hand', 'spreadsheet', 'one frontier AI prompt', 'engineering, data or industry expertise', 'new value or revenue', 'broad', 'very narrow', 'small landlords with a vacant step-free unit', 'named incumbents', 'comps']) {
      expect(v2).toContain(rule);
    }
    for (const keep of ['{{examples}}', '{{sketchA}}', '{{sketchB}}', 'Position does not matter', 'DATA only', 'winner: "A" or "B"', 'confidence: 1', 'need, nonTrivial, earn, edge, evidence']) expect(v2).toContain(keep);
  });

  it('a pinned promptVersion loads that version; the default stays v1', async () => {
    const r2 = fakeRouter({ structured: { judge: [{ winner: 'A', confidence: 2, reasons }] } });
    await judgePair(view('A'), view('B'), { router: r2, ctx, fewShot: [], promptVersion: 2 });
    expect(r2.calls[0]!.prompt).toContain('smaller revenue ceiling');
    const r1 = fakeRouter({ structured: { judge: [{ winner: 'A', confidence: 2, reasons }] } });
    await judgePair(view('A'), view('B'), { router: r1, ctx, fewShot: [] });
    expect(r1.calls[0]!.prompt).not.toContain('smaller revenue ceiling');
  });

  it('judgePromptVersion reads setting judge.promptVersion, default 1', async () => {
    const { judgePromptVersion } = await import('../../../src/pipeline/engine/judge');
    const { setSetting } = await import('../../../src/validation/settings');
    const db = await testDb();
    expect(await judgePromptVersion(db)).toBe(1);
    await setSetting(db, 'judge.promptVersion', 'v2');
    expect(await judgePromptVersion(db)).toBe(2);
    await setSetting(db, 'judge.promptVersion', 'junk');
    expect(await judgePromptVersion(db)).toBe(1);
  });

  it('caseText is capped at 1200 chars and sits inside the wrapped sketch block', async () => {
    const router = fakeRouter({ structured: { judge: [{ winner: 'A', confidence: 2, reasons }] } });
    await judgePair(view('A', { caseText: `CASE <b> ${'z'.repeat(3000)}` }), view('B'), { router, ctx, fewShot: [] });
    const a = between(router.calls[0]!.prompt, 'sketch-a');
    expect(a).toContain('Case summary: CASE ‹b›');
    expect(a.match(/z+/)![0].length).toBeLessThanOrEqual(1200);
  });
});
