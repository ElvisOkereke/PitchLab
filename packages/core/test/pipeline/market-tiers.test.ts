import { describe, expect, it } from 'vitest';
import { MARKET_TIERS, pickTieredSectors } from '../../src/pipeline/market-tiers';
import { seededRandom } from '../../src/pipeline/seed-context';
import { CA_US } from '../../src/db/seed';

describe('pickTieredSectors', () => {
  const broad = Object.keys(MARKET_TIERS.broad!);

  it('gives at least 3 enterprise or mid sectors of 6 over 20 seeds, and is deterministic per seed', () => {
    for (let s = 0; s < 20; s++) {
      const a = pickTieredSectors(broad, MARKET_TIERS.broad, 6, seededRandom(`seed-${s}`));
      expect(a).toHaveLength(6);
      expect(new Set(a).size).toBe(6);
      expect(a.filter((x) => MARKET_TIERS.broad![x] !== 'small').length).toBeGreaterThanOrEqual(3);
      expect(pickTieredSectors(broad, MARKET_TIERS.broad, 6, seededRandom(`seed-${s}`))).toEqual(a);
    }
  });

  it('picks the plain seeded shuffle slice when the market has no tiers (ca-us unchanged)', () => {
    const shuffle = (arr: string[], random: () => number) => {
      const copy = [...arr];
      for (let i = copy.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [copy[i], copy[j]] = [copy[j]!, copy[i]!]; }
      return copy;
    };
    for (let s = 0; s < 5; s++) {
      expect(pickTieredSectors(CA_US.sectors, MARKET_TIERS['ca-us'], 6, seededRandom(`x${s}`))).toEqual(shuffle(CA_US.sectors, seededRandom(`x${s}`)).slice(0, 6));
    }
  });
});
