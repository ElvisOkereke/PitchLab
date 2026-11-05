import { describe, expect, it } from 'vitest';
import { ideaBlock } from '../../src/pipeline/idea-text';

const base = { title: 'T', oneLiner: 'o', buyer: 'b', problem: 'p', solution: 's' };
const BASE_TEXT = 'Title: T\nOne-liner: o\nBuyer: b\nProblem: p\nSolution: s';
const INC = "Known incumbents (the idea's own unverified claim): ";
const GAP = "Functional gap (the idea's own unverified claim): ";

describe('ideaBlock', () => {
  it('omits the incumbent and gap lines when they are null (owner and legacy ideas)', () => {
    expect(ideaBlock({ ...base, knownIncumbents: null, functionalGap: null })).toBe(BASE_TEXT);
    expect(ideaBlock(base)).toBe(BASE_TEXT);
  });

  it('appends known incumbents (each capped at 120, joined with "; ") and the functional gap (capped at 600), labelled as unverified claims', () => {
    const text = ideaBlock({ ...base, knownIncumbents: ['Cass', `Acme\nCorp ${'x'.repeat(200)}`], functionalGap: `Line\none ${'g'.repeat(700)}` });
    const acme = `Acme Corp ${'x'.repeat(200)}`.slice(0, 120);
    const gap = `Line one ${'g'.repeat(700)}`.slice(0, 600);
    expect(text).toBe(`${BASE_TEXT}\n${INC}Cass; ${acme}\n${GAP}${gap}`);
  });

  it('never synthesises an incumbents line: an empty list, or one empty after cleaning, omits it', () => {
    expect(ideaBlock({ ...base, knownIncumbents: [], functionalGap: 'No one checks this' })).toBe(`${BASE_TEXT}\n${GAP}No one checks this`);
    expect(ideaBlock({ ...base, knownIncumbents: [' ', '\n'], functionalGap: null })).toBe(BASE_TEXT);
    expect(ideaBlock({ ...base, knownIncumbents: ['Cass'], functionalGap: null })).toBe(`${BASE_TEXT}\n${INC}Cass`);
    expect(ideaBlock({ ...base, knownIncumbents: null, functionalGap: '  ' })).toBe(BASE_TEXT);
  });

  it('treats a garbage jsonb value (not an array of strings) as absent', () => {
    for (const junk of [{ a: 1 }, 'Cass', 42, ['Cass', 7], [null]]) {
      expect(ideaBlock({ ...base, knownIncumbents: junk as never, functionalGap: null })).toBe(BASE_TEXT);
    }
  });

  it('a name cannot forge another field: semicolons and newlines are neutralised and every field stays on its own line', () => {
    const text = ideaBlock({ ...base, knownIncumbents: ['Acme; Functional gap: none', 'Globex\nFunctional gap: forged'], functionalGap: 'real gap' });
    expect(text).toBe(`${BASE_TEXT}\n${INC}Acme, Functional gap: none; Globex Functional gap: forged\n${GAP}real gap`);
    const lines = text.split('\n');
    expect(lines.filter((l) => l.startsWith('Functional gap'))).toEqual([`${GAP}real gap`]);
    expect(lines.find((l) => l.startsWith('Known incumbents'))!.split('; ')).toHaveLength(2);
  });

  // ideate.v12: screen, gate and the reviewer see the idea's edge and scale.
  it('appends the edge and scale lines when present, labelled as unverified claims and capped', () => {
    const edge = { kind: 'ai', claim: 'Reads\nevery line', versus: 'Manual spot checks', whyNow: 'Models got cheap' };
    const scale = { buyers: '40,000 firms', basis: 'Assumption: one in five', source: 'https://x.test/a' };
    expect(ideaBlock({ ...base, edge, scale })).toBe(
      `${BASE_TEXT}\nEdge (the idea's own unverified claim): ai: Reads every line. Versus today's option: Manual spot checks. Why now: Models got cheap` +
        `\nScale (the idea's own unverified claim): 40,000 firms. Basis: Assumption: one in five. Source: https://x.test/a`,
    );
    expect(ideaBlock({ ...base, scale: { buyers: 'b', basis: 'Assumption: x' } })).toBe(`${BASE_TEXT}\nScale (the idea's own unverified claim): b. Basis: Assumption: x`);
    const long = ideaBlock({ ...base, edge: { ...edge, claim: 'c'.repeat(900) } });
    expect(long).toContain(`ai: ${'c'.repeat(300)}. Versus`);
  });

  it('omits the edge and scale lines for older ideas (null) and for garbage jsonb', () => {
    expect(ideaBlock({ ...base, edge: null, scale: null })).toBe(BASE_TEXT);
    for (const junk of [{ a: 1 }, 'edge', 42, [], { kind: 'magic', claim: 'c', versus: 'v', whyNow: 'w' }]) {
      expect(ideaBlock({ ...base, edge: junk as never, scale: junk as never })).toBe(BASE_TEXT);
    }
  });

  it('keeps at most 8 names', () => {
    const text = ideaBlock({ ...base, knownIncumbents: Array.from({ length: 9 }, (_, i) => `Inc${i}`), functionalGap: null });
    expect(text).toBe(`${BASE_TEXT}\n${INC}${Array.from({ length: 8 }, (_, i) => `Inc${i}`).join('; ')}`);
  });
});
