import { ELO_K, ELO_START, MAX_PER_BUSINESS_MODEL, MAX_PER_CELL, TOP_SKETCHES } from './kinds';

/** Pure: Elo math, Swiss pairing and the top-N pick for the tournament (spec §4). No I/O. */

/** One judge call's verdict, by position: `a` is the sketch shown first. */
export type Verdict = 'a' | 'b' | 'draw' | 'error';
export type MatchResult = 'a' | 'b' | 'draw';

/** A's expected score against B. */
export function expected(ra: number, rb: number): number {
  return 1 / (1 + 10 ** ((rb - ra) / 400));
}

/** Both ratings after one match. */
export function update(ra: number, rb: number, result: MatchResult, k = ELO_K): [number, number] {
  const sa = result === 'a' ? 1 : result === 'b' ? 0 : 0.5;
  const delta = k * (sa - expected(ra, rb));
  return [ra + delta, rb - delta];
}

/**
 * One match from its two calls: `ab` shows A first, `ba` shows B first (so its verdict is mirrored). Only two calls that
 * agree on a winner decide the match; a split, a draw or an error is a draw.
 */
export function combine(ab: Verdict, ba: Verdict): MatchResult {
  const mirrored = ba === 'a' ? 'b' : ba === 'b' ? 'a' : ba;
  return (ab === 'a' || ab === 'b') && ab === mirrored ? ab : 'draw';
}

/** The key of a played pair (order-free). */
export const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
/** The key recording that a sketch sat a round out (a bye): it is the last to get another. */
export const byeKey = (id: string): string => `bye:${id}`;

export type SwissRating = { id: string; elo: number; cell: string | null };

/** The pairing search gives up after this many steps and keeps the most pairs it found. */
const MAX_STEPS = 20_000;

function shuffle<T>(arr: readonly T[], rand: () => number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/**
 * Depth-first pairing without rematches: `choose` names the next sketch to pair and its partners in preference order.
 * A sketch with no partner left sits the round out. Returns a complete pairing when one is found, else the largest.
 */
function search(ids: string[], choose: (rem: string[]) => { x: string; partners: string[] }, played: Set<string>): [string, string][] {
  const target = Math.floor(ids.length / 2);
  let best: [string, string][] = [];
  let steps = 0;
  const go = (rem: string[], acc: [string, string][]): boolean => {
    if (acc.length > best.length) best = [...acc];
    if (best.length === target) return true;
    if (rem.length < 2 || acc.length + Math.floor(rem.length / 2) <= best.length || ++steps > MAX_STEPS) return false;
    const { x, partners } = choose(rem);
    for (const y of partners) {
      if (played.has(pairKey(x, y))) continue;
      acc.push([x, y]);
      if (go(rem.filter((id) => id !== x && id !== y), acc)) return true;
      acc.pop();
      if (steps > MAX_STEPS) return false;
    }
    return go(rem.filter((id) => id !== x), acc);
  };
  go(ids, []);
  return best;
}

/** Round 1: shuffled, then paired across different cells where possible (always from the largest cells left). */
function firstRound(ratings: SwissRating[], played: Set<string>, rand: () => number): [string, string][] {
  const order = shuffle(ratings.map((r) => r.id), rand);
  // A sketch with no cell is a cell of its own.
  const cellOf = new Map(ratings.map((r) => [r.id, r.cell ?? `\u0000${r.id}`]));
  const sizes = (ids: string[]) => {
    const m = new Map<string, number>();
    for (const id of ids) m.set(cellOf.get(id)!, (m.get(cellOf.get(id)!) ?? 0) + 1);
    return m;
  };
  let pool = order;
  if (pool.length % 2 === 1) {
    // The bye: preferably a sketch without one yet, from the largest cell, last in shuffled order.
    const size = sizes(pool);
    const pos = new Map(pool.map((id, i) => [id, i]));
    const bye = [...pool].sort((x, y) =>
      Number(played.has(byeKey(x))) - Number(played.has(byeKey(y)))
      || size.get(cellOf.get(y)!)! - size.get(cellOf.get(x)!)!
      || pos.get(y)! - pos.get(x)!)[0]!;
    pool = pool.filter((id) => id !== bye);
  }
  return search(pool, (rem) => {
    const size = sizes(rem);
    // The first sketch (shuffled order) of the largest cell, paired preferably with the largest other cell.
    const x = rem.reduce((b, id) => (size.get(cellOf.get(id)!)! > size.get(cellOf.get(b)!)! ? id : b), rem[0]!);
    const others = rem.filter((id) => id !== x);
    const cross = others.filter((id) => cellOf.get(id) !== cellOf.get(x));
    const same = others.filter((id) => cellOf.get(id) === cellOf.get(x));
    const crossSorted = cross.map((id, i) => ({ id, i })).sort((p, q) => size.get(cellOf.get(q.id)!)! - size.get(cellOf.get(p.id)!)! || p.i - q.i).map((p) => p.id);
    return { x, partners: [...crossSorted, ...same] };
  }, played);
}

/**
 * The pairs of one Swiss round. Round 1 pairs across different cells where possible (seeded shuffle); later rounds pair
 * Elo neighbours (ties in input order) without rematches. With an odd count, one sketch gets a bye (no rating change):
 * the lowest rated (round 1: one of the largest cell) that has not had one, as recorded by `byeKey` in `played`.
 * Deterministic for the same inputs and seed; each pair is [higher seeded, lower seeded].
 */
export function swissPairs(ratings: SwissRating[], round: number, played: Set<string>, rand: () => number): [string, string][] {
  if (ratings.length < 2) return [];
  if (round <= 1) return firstRound(ratings, played, rand);
  const order = ratings.map((r, i) => ({ r, i })).sort((x, y) => y.r.elo - x.r.elo || x.i - y.i).map((x) => x.r.id);
  let pool = order;
  if (pool.length % 2 === 1) {
    const bye = [...pool].reverse().find((id) => !played.has(byeKey(id))) ?? pool[pool.length - 1]!;
    pool = pool.filter((id) => id !== bye);
  }
  return search(pool, (rem) => ({ x: rem[0]!, partners: rem.slice(1) }), played);
}

export type RankRow = { id: string; elo: number | null; cell: string | null; businessModel: string | null; createdAt: Date };

/**
 * The first `n` of `ordered` with at most MAX_PER_CELL per cell and MAX_PER_BUSINESS_MODEL per business model (no cell
 * or model is not capped). When the caps leave fewer than `n`, the skipped ones fill up in order: a narrow run still
 * sends on everything it has.
 */
function pickCapped(ordered: RankRow[], n: number): string[] {
  const out: string[] = [];
  const skipped: string[] = [];
  const perCell = new Map<string, number>();
  const perModel = new Map<string, number>();
  for (const r of ordered) {
    if (out.length >= n) break;
    if ((r.cell && (perCell.get(r.cell) ?? 0) >= MAX_PER_CELL) || (r.businessModel && (perModel.get(r.businessModel) ?? 0) >= MAX_PER_BUSINESS_MODEL)) {
      skipped.push(r.id);
      continue;
    }
    out.push(r.id);
    if (r.cell) perCell.set(r.cell, (perCell.get(r.cell) ?? 0) + 1);
    if (r.businessModel) perModel.set(r.businessModel, (perModel.get(r.businessModel) ?? 0) + 1);
  }
  for (const id of skipped) {
    if (out.length >= n) break;
    out.push(id);
  }
  return out;
}

const bySketchOrder = (a: RankRow, b: RankRow) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The top `n` by Elo (a null elo counts as ELO_START), ties to the earlier sketch, under the cell and business model caps. */
export function topByElo(rows: RankRow[], n = TOP_SKETCHES): string[] {
  const ordered = [...rows].sort((a, b) => (b.elo ?? ELO_START) - (a.elo ?? ELO_START) || bySketchOrder(a, b));
  return pickCapped(ordered, n);
}

/**
 * The top `n` when the tournament could not rank (every judge call failed): one sketch per diversity cell in turn
 * (cells in order of their first sketch, sketches in sketch order), under the same caps.
 */
export function topByCell(rows: RankRow[], n = TOP_SKETCHES): string[] {
  const groups = new Map<string, RankRow[]>();
  for (const r of [...rows].sort(bySketchOrder)) {
    const key = r.cell ?? `\u0000${r.id}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const ordered: RankRow[] = [];
  for (let k = 0; ordered.length < rows.length; k++) {
    for (const g of groups.values()) if (g[k]) ordered.push(g[k]!);
  }
  return pickCapped(ordered, n);
}
