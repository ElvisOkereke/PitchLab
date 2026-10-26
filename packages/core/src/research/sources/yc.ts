import { request, type CallHook } from '../http';
import type { KnowledgeDraft } from '../../library/kinds';

export const sourceType = 'yc';
/** The dataset is fetched once per process. */
export const MIN_INTERVAL_MS = Infinity;
const URL_ALL = 'https://yc-oss.github.io/api/companies/all.json';

export type YcCompany = {
  name: string;
  oneLiner: string;
  url: string;
  status: 'Active' | 'Inactive' | 'Acquired' | 'Public';
  batch: string;
  industries: string[];
  regions: string[];
};

let cache: Promise<YcCompany[]> | null = null;
export function resetYcCache(): void {
  cache = null;
}

const STATUSES = ['Active', 'Inactive', 'Acquired', 'Public'];

async function load(opts: { fetch?: typeof fetch; onCall?: CallHook }): Promise<YcCompany[]> {
  const json = await request('yc', URL_ALL, { maxBytes: 30_000_000, timeoutMs: 30_000 }, { fetch: opts.fetch, onCall: opts.onCall });
  if (!Array.isArray(json)) return [];
  const out: YcCompany[] = [];
  for (const c of json as Record<string, unknown>[]) {
    if (typeof c.name !== 'string' || !STATUSES.includes(c.status as string)) continue;
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    out.push({
      name: c.name,
      oneLiner: typeof c.one_liner === 'string' ? c.one_liner : '',
      url: typeof c.website === 'string' && c.website ? c.website : typeof c.url === 'string' ? c.url : '',
      status: c.status as YcCompany['status'],
      batch: typeof c.batch === 'string' ? c.batch : '',
      industries: strs(c.industries),
      regions: strs(c.regions),
    });
  }
  return out;
}

export async function ycCompanies(
  filter: { query?: string; industries?: string[]; limit?: number } = {},
  opts: { fetch?: typeof fetch; onCall?: CallHook } = {},
): Promise<YcCompany[]> {
  if (!cache) {
    const p = load(opts);
    cache = p;
    // Do not cache a failed or empty load; the error still reaches this caller.
    p.then(
      (r) => {
        if (r.length === 0 && cache === p) cache = null;
      },
      () => {
        if (cache === p) cache = null;
      },
    );
  }
  const all = await cache;
  const q = filter.query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const inds = filter.industries?.map((i) => i.toLowerCase()) ?? [];
  return all
    .filter((c) => {
      const hay = `${c.name} ${c.oneLiner}`.toLowerCase();
      if (q.length && !q.some((w) => hay.includes(w))) return false;
      if (inds.length && !c.industries.some((i) => inds.includes(i.toLowerCase()))) return false;
      return true;
    })
    .slice(0, filter.limit ?? 20);
}

const OUTCOME = { Active: 'active', Inactive: 'dead', Acquired: 'acquired', Public: 'public' } as const;

export function ycToDraft(c: YcCompany): KnowledgeDraft {
  let domain = 'ycombinator.com';
  try {
    domain = new URL(c.url).hostname;
  } catch {
    // keep default domain
  }
  return {
    kind: 'startup',
    title: c.name,
    summary: c.oneLiner,
    audience: 'both',
    countries: [],
    industries: c.industries,
    facts: { name: c.name, whatItDoes: c.oneLiner, businessModel: 'unknown', outcome: OUTCOME[c.status] },
    source: { url: c.url, domain, sourceType, quoteVerified: false },
  };
}
