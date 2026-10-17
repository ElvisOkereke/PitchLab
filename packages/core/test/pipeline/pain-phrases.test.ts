import { describe, expect, it } from 'vitest';
import { CA_US } from '../../src/db/seed';
import { GENERIC_PAIN_PHRASES, SECTOR_PAIN_PHRASES, phrasesFor } from '../../src/pipeline/pain-phrases';

describe('pain phrases', () => {
  it('every seeded ca-us sector has 4-6 phrases of 2-5 words', () => {
    for (const s of CA_US.sectors) {
      const p = SECTOR_PAIN_PHRASES[s];
      expect(p, s).toBeDefined();
      expect(p!.length, s).toBeGreaterThanOrEqual(4);
      expect(p!.length, s).toBeLessThanOrEqual(6);
      for (const x of p!) expect(x.split(' ').length, x).toBeGreaterThanOrEqual(2);
      for (const x of p!) expect(x.split(' ').length, x).toBeLessThanOrEqual(5);
    }
  });
  it('generic phrases exclude the old convergent ones', () => {
    expect(GENERIC_PAIN_PHRASES).not.toContain('lost leads');
    expect(GENERIC_PAIN_PHRASES).not.toContain('silently failing');
  });
  it('phrasesFor adds 2 generic phrases to the sector ones; unknown sector gets generic only', () => {
    const p = phrasesFor('dental clinics', () => 0.5);
    expect(p).toHaveLength(SECTOR_PAIN_PHRASES['dental clinics']!.length + 2);
    expect(p.slice(0, 3)).toEqual(SECTOR_PAIN_PHRASES['dental clinics']!.slice(0, 3));
    const u = phrasesFor('basket weaving', () => 0.5);
    expect(u.length).toBeGreaterThan(0);
    for (const x of u) expect(GENERIC_PAIN_PHRASES).toContain(x);
  });
});
