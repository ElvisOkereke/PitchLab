export type Tier = 'enterprise' | 'mid' | 'small';

const tier = (t: Tier, names: string[]): Record<string, Tier> => Object.fromEntries(names.map((n) => [n, t]));

/** The `broad` market's sectors with their tier (migration 0018 inserts the same names). `ca-us` has no tiers. */
export const BROAD_TIERS: Record<string, Tier> = {
  ...tier('enterprise', [
    'insurance carriers', 'banks and credit unions', 'health systems and hospitals', 'health insurers and payers',
    'pharma and life sciences', 'utilities and energy', 'telecom', 'manufacturing', 'chemicals',
    'aerospace and defence suppliers', 'government agencies', 'universities',
  ]),
  ...tier('mid', [
    'logistics shippers and 3PLs', 'wholesale and distribution', 'commercial real estate',
    'construction general contractors', 'engineering firms', 'staffing agencies', 'law firms', 'accounting firms',
    'HR and payroll', 'fintech and payments', 'B2B SaaS companies', 'data and AI teams', 'cybersecurity',
    'ecommerce marketplaces', 'media and publishers', 'automotive dealers', 'agriculture and food processing',
    'mining', 'specialty retail chains', 'hospitality groups',
  ]),
  ...tier('small', ['franchise groups', 'multi-location clinics', 'field services', 'ecommerce brands']),
};

export const MARKET_TIERS: Record<string, Record<string, Tier>> = { broad: BROAD_TIERS };

function shuffle<T>(arr: T[], random: () => number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/**
 * Picks `n` sectors. Without tiers: a plain seeded shuffle. With tiers: at least ceil(n/2) from enterprise or mid
 * (when enough exist), the rest from whatever is left; the result order is shuffled.
 */
export function pickTieredSectors(sectors: string[], tiers: Record<string, Tier> | undefined, n: number, random: () => number): string[] {
  const all = shuffle(sectors, random);
  if (!tiers) return all.slice(0, n);
  const upper = all.filter((s) => tiers[s] === 'enterprise' || tiers[s] === 'mid');
  const firstUpper = upper.slice(0, Math.min(Math.ceil(n / 2), n));
  const taken = new Set(firstUpper);
  const rest = all.filter((s) => !taken.has(s)).slice(0, n - firstUpper.length);
  return shuffle([...firstUpper, ...rest], random);
}
