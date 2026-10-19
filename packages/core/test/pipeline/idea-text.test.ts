import { describe, expect, it } from 'vitest';
import { ideaBlock } from '../../src/pipeline/idea-text';

const base = { title: 'T', oneLiner: 'o', buyer: 'b', problem: 'p', solution: 's' };
const BASE_TEXT = 'Title: T\nOne-liner: o\nBuyer: b\nProblem: p\nSolution: s';

describe('ideaBlock', () => {
  it('omits the incumbent and gap lines when they are null (owner and legacy ideas)', () => {
    expect(ideaBlock({ ...base, knownIncumbents: null, functionalGap: null })).toBe(BASE_TEXT);
    expect(ideaBlock(base)).toBe(BASE_TEXT);
  });

  it('appends known incumbents (each capped at 120, joined with "; ") and the functional gap (capped at 600)', () => {
    const text = ideaBlock({ ...base, knownIncumbents: ['Cass', `Acme\nCorp ${'x'.repeat(200)}`], functionalGap: `Line\none ${'g'.repeat(700)}` });
    const acme = `Acme Corp ${'x'.repeat(200)}`.slice(0, 120);
    const gap = `Line one ${'g'.repeat(700)}`.slice(0, 600);
    expect(text).toBe(`${BASE_TEXT}\nKnown incumbents: Cass; ${acme}\nFunctional gap: ${gap}`);
  });

  it('shows an empty incumbent list as "(none known)" and omits only the absent field', () => {
    expect(ideaBlock({ ...base, knownIncumbents: [], functionalGap: 'No one checks this' }))
      .toBe(`${BASE_TEXT}\nKnown incumbents: (none known)\nFunctional gap: No one checks this`);
    expect(ideaBlock({ ...base, knownIncumbents: ['Cass'], functionalGap: null })).toBe(`${BASE_TEXT}\nKnown incumbents: Cass`);
  });
});
