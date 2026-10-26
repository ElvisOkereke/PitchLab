// Not used: site terms — see docs/superpowers/specs/2026-10-17-business-case-generator-design.md §11.1 sources.
// Kept (with its tests) so it can be re-enabled if the owner gets permission; research missions never wire it.

import { cleanText, toDate } from '../../tools/sources/types';
import { request, SourceError, throttle, type HttpOpts } from '../http';
import type { KnowledgeDraft } from '../../library/kinds';

export const sourceType = 'producthunt';
export const MIN_INTERVAL_MS = 1000;

export type ProductHuntItem = { name: string; tagline: string; url: string; launchedAt: Date | null; votes: number; pricingHint?: string };

export interface ProductHuntOpts extends HttpOpts {
  token?: string;
  limit?: number;
}

const QUERY = `query($topic: String, $first: Int) {
  posts(topic: $topic, first: $first, order: VOTES) {
    edges { node { name tagline url website createdAt votesCount } }
  }
}`;

function pricingHint(tagline: string): string | undefined {
  const m = /\bfree(?:mium)?\b|\bopen[- ]source\b|\$\s?\d+(?:\.\d+)?(?:\s?\/\s?\w+)?|\bpaid\b/i.exec(tagline);
  return m ? m[0] : undefined;
}

const TOPIC_QUERY = `query($q: String) { topics(query: $q, first: 1) { edges { node { slug } } } }`;

type Gql = {
  data?: { posts?: { edges?: { node?: Record<string, unknown> }[] }; topics?: { edges?: { node?: { slug?: string } }[] } };
  errors?: unknown[];
};

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** `topic` is a topic slug or a keyword; a keyword that is not a slug is resolved through the topics search. */
export async function productHuntSearch(topic: string, opts: ProductHuntOpts = {}): Promise<ProductHuntItem[]> {
  if (!opts.token) return [];
  const gql = async (query: string, variables: Record<string, unknown>): Promise<Gql> => {
    await throttle('api.producthunt.com', MIN_INTERVAL_MS, opts);
    const json = (await request(
      'producthunt',
      'https://api.producthunt.com/v2/api/graphql',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      },
      opts,
    )) as Gql;
    if (json?.errors?.length && !json.data) throw new SourceError('bad_response', 'producthunt');
    return json;
  };
  const first = opts.limit ?? 10;
  let slug = slugify(topic);
  if (!slug) return []; // never fall through to global top posts
  let json = await gql(QUERY, { topic: slug, first });
  if (!json?.data?.posts?.edges?.length) {
    const found = (await gql(TOPIC_QUERY, { q: topic }))?.data?.topics?.edges?.[0]?.node?.slug;
    if (found && found !== slug) {
      slug = found;
      json = await gql(QUERY, { topic: slug, first });
    }
  }
  const out: ProductHuntItem[] = [];
  for (const e of json?.data?.posts?.edges ?? []) {
    const n = e.node;
    if (!n || typeof n.name !== 'string') continue;
    const url = String(n.website ?? n.url ?? '');
    if (!url) continue;
    const tagline = cleanText(String(n.tagline ?? ''));
    out.push({
      name: cleanText(n.name),
      tagline,
      url,
      launchedAt: toDate(n.createdAt as string),
      votes: Number(n.votesCount) || 0,
      pricingHint: pricingHint(tagline),
    });
  }
  return out;
}

export function productHuntToDraft(p: ProductHuntItem): KnowledgeDraft {
  let domain = '';
  try {
    domain = new URL(p.url).hostname;
  } catch {
    // keep empty domain
  }
  return {
    kind: 'startup',
    title: p.name,
    summary: p.tagline,
    audience: 'both',
    countries: [],
    industries: [],
    facts: { name: p.name, whatItDoes: p.tagline, businessModel: p.pricingHint ?? 'unknown', outcome: 'active' },
    source: { url: p.url, domain, sourceType, publishedAt: p.launchedAt ?? undefined, quoteVerified: false },
  };
}
