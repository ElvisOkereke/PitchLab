import { describe, expect, it } from 'vitest';
import {
  byeKey, combine, expected, pairKey, swissPairs, topByCell, topByElo, update, type RankRow,
} from '../../../src/pipeline/engine/elo';
import { ELO_K, ELO_START, MAX_PER_BUSINESS_MODEL, MAX_PER_CELL, TOP_SKETCHES } from '../../../src/pipeline/engine/kinds';
import { seededRandom } from '../../../src/pipeline/seed-context';

describe('constants', () => {
  it('match the spec', () => {
    expect([ELO_START, ELO_K, TOP_SKETCHES, MAX_PER_CELL, MAX_PER_BUSINESS_MODEL]).toEqual([1200, 24, 12, 2, 2]);
  });
});

describe('Elo math', () => {
  it('expected score is 0.5 between equal ratings and favours the higher one', () => {
    expect(expected(1200, 1200)).toBe(0.5);
    expect(expected(1400, 1200)).toBeGreaterThan(0.75);
  });
  it('a win between equal ratings gives 1212 and 1188 at K 24', () => {
    expect(update(1200, 1200, 'a')).toEqual([1212, 1188]);
    expect(update(1200, 1200, 'b')).toEqual([1188, 1212]);
  });
  it('a draw between equal ratings changes nothing', () => {
    expect(update(1200, 1200, 'draw')).toEqual([1200, 1200]);
  });
  it('rating is conserved and K scales the change', () => {
    const [a, b] = update(1300, 1100, 'b', 32);
    expect(a + b).toBeCloseTo(2400, 9);
    expect(1300 - a).toBeGreaterThan(24);
  });
});

describe('combine', () => {
  it('mirrors the BA verdict; agreement wins, disagreement, draw or error is a draw', () => {
    // ab: first shown is A. ba: first shown is B, so ba 'b' means A won.
    expect(combine('a', 'b')).toBe('a');
    expect(combine('b', 'a')).toBe('b');
    expect(combine('a', 'a')).toBe('draw');
    expect(combine('b', 'b')).toBe('draw');
    for (const v of ['a', 'b', 'draw', 'error'] as const) {
      expect(combine('error', v)).toBe('draw');
      expect(combine(v, 'error')).toBe('draw');
      expect(combine('draw', v)).toBe('draw');
      expect(combine(v, 'draw')).toBe('draw');
    }
  });
});

const field = (n: number, cellOf: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => ({ id: `s${String(i).padStart(2, '0')}`, elo: ELO_START, cell: cellOf(i) }));

/** Plays `rounds` Swiss rounds where the lower id always wins; returns each round's pairs. */
function play(n: number, rounds: number, seed: string, cellOf: (i: number) => string) {
  const ratings = field(n, cellOf);
  const played = new Set<string>();
  const rand = seededRandom(seed);
  const out: [string, string][][] = [];
  for (let r = 1; r <= rounds; r++) {
    const pairs = swissPairs(ratings, r, played, rand);
    out.push(pairs);
    const paired = new Set(pairs.flat());
    for (const s of ratings) if (!paired.has(s.id)) played.add(byeKey(s.id));
    for (const [a, b] of pairs) {
      played.add(pairKey(a, b));
      const ra = ratings.find((s) => s.id === a)!, rb = ratings.find((s) => s.id === b)!;
      [ra.elo, rb.elo] = update(ra.elo, rb.elo, a < b ? 'a' : 'b');
    }
  }
  return { out, ratings };
}

describe('swissPairs', () => {
  it('never rematches over 5 rounds of 20, and each sketch plays once a round', () => {
    const { out } = play(20, 5, 'run-1main', (i) => `c${i % 4}`);
    const seen = new Set<string>();
    for (const pairs of out) {
      expect(pairs).toHaveLength(10);
      expect(new Set(pairs.flat()).size).toBe(20);
      for (const [a, b] of pairs) {
        expect(a).not.toBe(b);
        expect(seen.has(pairKey(a, b))).toBe(false);
        seen.add(pairKey(a, b));
      }
    }
  });

  it('round 1 pairs across different cells, also with uneven cells', () => {
    const cells = (i: number) => (i < 5 ? 'big' : i < 8 ? 'mid' : 'small'); // 5 / 3 / 2 of 10
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const ratings = field(10, cells);
      const pairs = swissPairs(ratings, 1, new Set(), seededRandom(seed));
      expect(pairs).toHaveLength(5);
      const cellById = new Map(ratings.map((r) => [r.id, r.cell]));
      for (const [a, b] of pairs) expect(cellById.get(a)).not.toBe(cellById.get(b));
    }
  });

  it('later rounds pair Elo neighbours', () => {
    const ratings = field(6, () => 'c').map((r, i) => ({ ...r, elo: 1300 - i * 10 }));
    const pairs = swissPairs(ratings, 2, new Set(), seededRandom('x'));
    expect(pairs).toEqual([['s00', 's01'], ['s02', 's03'], ['s04', 's05']]);
    const avoid = swissPairs(ratings, 2, new Set([pairKey('s00', 's01')]), seededRandom('x'));
    expect(avoid[0]).toEqual(['s00', 's02']);
  });

  it('an odd sketch out gets a bye, and byes rotate', () => {
    const { out } = play(7, 3, 'odd', (i) => `c${i % 3}`);
    const byes = out.map((pairs) => {
      expect(pairs).toHaveLength(3);
      const paired = new Set(pairs.flat());
      const left = field(7, () => '').map((s) => s.id).filter((id) => !paired.has(id));
      expect(left).toHaveLength(1);
      return left[0];
    });
    expect(new Set(byes).size).toBe(3);
  });

  it('is deterministic for the same seed', () => {
    const one = play(20, 5, 'same', (i) => `c${i % 3}`).out;
    const two = play(20, 5, 'same', (i) => `c${i % 3}`).out;
    expect(two).toEqual(one);
    expect(play(20, 1, 'other', (i) => `c${i % 3}`).out).not.toEqual(play(20, 1, 'same', (i) => `c${i % 3}`).out);
  });

  it('handles 0, 1 and 2 sketches', () => {
    expect(swissPairs([], 1, new Set(), seededRandom('z'))).toEqual([]);
    expect(swissPairs(field(1, () => 'c'), 1, new Set(), seededRandom('z'))).toEqual([]);
    expect(swissPairs(field(2, () => 'c'), 1, new Set(), seededRandom('z'))).toHaveLength(1);
    // The only possible pair was already played: nobody plays.
    expect(swissPairs(field(2, () => 'c'), 2, new Set([pairKey('s00', 's01')]), seededRandom('z'))).toEqual([]);
  });
});

const t0 = Date.UTC(2026, 0, 1);
const rank = (id: string, elo: number | null, cell: string | null, businessModel: string | null, order: number): RankRow =>
  ({ id, elo, cell, businessModel, createdAt: new Date(t0 + order * 1000) });

describe('topByElo', () => {
  it('takes the highest Elo with at most 2 per cell and 2 per business model', () => {
    const rows = [
      rank('a', 1300, 'c1', 'saas', 0), rank('b', 1290, 'c1', 'ads', 1), rank('c', 1280, 'c1', 'usage', 2),
      rank('d', 1270, 'c2', 'saas', 3), rank('e', 1260, 'c3', 'saas', 4), rank('f', 1250, 'c4', 'usage', 5),
    ];
    expect(topByElo(rows, 4)).toEqual(['a', 'b', 'd', 'f']);
  });

  it('breaks ties by createdAt and treats a null elo as ELO_START', () => {
    const rows = [rank('late', 1200, 'c1', 'm1', 3), rank('early', null, 'c2', 'm2', 1), rank('top', 1201, 'c3', 'm3', 9)];
    expect(topByElo(rows, 3)).toEqual(['top', 'early', 'late']);
  });

  it('with n or fewer sketches, ranks and sends on all of them (caps do not apply)', () => {
    const rows = [rank('a', 1300, 'c', 'm', 0), rank('b', 1250, 'c', 'm', 1), rank('c', 1200, 'c', 'm', 2)];
    expect(topByElo(rows, 12)).toEqual(['a', 'b', 'c']);
  });

  it('with more than n sketches the caps are hard, even if fewer than n are left', () => {
    // 20 sketches over 3 business models and 5 cells, best Elo first.
    const rows = Array.from({ length: 20 }, (_, i) => rank(`s${i}`, 1400 - i, `c${i % 5}`, `m${i % 3}`, i));
    const top = topByElo(rows, 12);
    expect(top).toEqual(['s0', 's1', 's2', 's3', 's4', 's5']);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const count = (key: 'cell' | 'businessModel') => {
      const m = new Map<string, number>();
      for (const id of top) m.set(byId.get(id)![key]!, (m.get(byId.get(id)![key]!) ?? 0) + 1);
      return Math.max(...m.values());
    };
    expect(count('businessModel')).toBeLessThanOrEqual(2);
    expect(count('cell')).toBeLessThanOrEqual(2);
  });

  it('defaults to TOP_SKETCHES', () => {
    const rows = Array.from({ length: 20 }, (_, i) => rank(`s${i}`, 1200 + i, `c${i}`, `m${i}`, i));
    expect(topByElo(rows)).toHaveLength(TOP_SKETCHES);
  });
});

describe('topByCell', () => {
  it('takes one per cell in sketch order, round after round, under the caps', () => {
    const rows = Array.from({ length: 20 }, (_, i) => rank(`s${i}`, 1200, `c${Math.floor(i / 3)}`, `m${i % 10}`, i));
    expect(topByCell(rows, 12)).toEqual(['s0', 's3', 's6', 's9', 's12', 's15', 's18', 's1', 's4', 's7', 's10', 's13']);
  });

  it('keeps the caps hard with more than n sketches (5 cells of 4: at most 10)', () => {
    const rows = Array.from({ length: 20 }, (_, i) => rank(`s${i}`, 1200, `c${Math.floor(i / 4)}`, `m${i % 10}`, i));
    expect(topByCell(rows, 12)).toEqual(['s0', 's4', 's8', 's12', 's16', 's1', 's5', 's9', 's13', 's17']);
  });
});
