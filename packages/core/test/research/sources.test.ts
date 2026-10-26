import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetThrottle, SourceError } from '../../src/research/http';
import { redditSearch, resetRedditState } from '../../src/research/sources/reddit';
import { productHuntSearch, productHuntToDraft } from '../../src/research/sources/producthunt';
import { appReviews } from '../../src/research/sources/appreviews';
import { resetYcCache, ycCompanies, ycToDraft, type YcCompany } from '../../src/research/sources/yc';

const sleep = async () => {};
type Call = { url: string; init?: RequestInit };
function router(routes: (url: string, init?: RequestInit) => { body: unknown; status?: number }) {
  const calls: Call[] = [];
  const impl = (async (u: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(u), init });
    const r = routes(String(u), init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

beforeEach(() => {
  resetThrottle();
  resetRedditState();
  resetYcCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const redditRoutes = (url: string) => {
  if (url.includes('access_token')) return { body: { access_token: 'tok', expires_in: 3600 } };
  if (url.includes('/search'))
    return {
      body: {
        data: {
          children: [
            {
              data: {
                id: 'p1',
                title: 'Invoicing is painful',
                selftext: 'I waste hours &amp; hours',
                permalink: '/r/smallbusiness/comments/p1/invoicing/',
                created_utc: 1700000000,
                author: 'secret_user',
                author_fullname: 't2_x',
              },
            },
          ],
        },
      },
    };
  return {
    body: [
      {},
      { data: { children: [{ data: { body: 'Same here', permalink: '/r/smallbusiness/comments/p1/invoicing/c1/', created_utc: 1700000100, author: 'other_user' } }] } },
    ],
  };
};

describe('redditSearch', () => {
  it('returns [] and makes no network call without keys, logging once', async () => {
    const { impl, calls } = router(redditRoutes);
    expect(await redditSearch('x', { fetch: impl })).toEqual([]);
    expect(await redditSearch('x', { fetch: impl, clientId: 'a' })).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
  it('maps posts and comments with no author fields, using client_credentials', async () => {
    const { impl, calls } = router(redditRoutes);
    const items = await redditSearch('invoicing', { fetch: impl, sleep, clientId: 'id', clientSecret: 'sec' });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ source: 'reddit', title: 'Invoicing is painful', text: 'I waste hours & hours' });
    expect(items[0]!.publishedAt).toBeInstanceOf(Date);
    expect(items[1]!.text).toBe('Same here');
    const json = JSON.stringify(items);
    expect(json).not.toMatch(/secret_user|other_user|author/);
    const tokenCall = calls[0]!;
    expect(tokenCall.init?.body).toBe('grant_type=client_credentials');
    expect((tokenCall.init?.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
    expect((tokenCall.init?.headers as Record<string, string>)['User-Agent']).toContain('pitchlab-research');
  });
  it('caches the token until expiry', async () => {
    const { impl, calls } = router(redditRoutes);
    const o = { fetch: impl, sleep, clientId: 'id', clientSecret: 'sec' };
    await redditSearch('a', o);
    await redditSearch('b', o);
    expect(calls.filter((c) => c.url.includes('access_token'))).toHaveLength(1);
  });
  it('raises rate_limited on 429', async () => {
    const { impl } = router((url) => (url.includes('access_token') ? { body: { access_token: 't' } } : { body: {}, status: 429 }));
    await expect(redditSearch('a', { fetch: impl, sleep, clientId: 'id', clientSecret: 'sec' })).rejects.toMatchObject({
      name: 'SourceError',
      code: 'rate_limited',
    });
    expect(SourceError).toBeDefined();
  });
  it('waits MIN_INTERVAL between requests to the same host', async () => {
    const { impl } = router(redditRoutes);
    const waits: number[] = [];
    let t = 0;
    await redditSearch('a', { fetch: impl, clientId: 'id', clientSecret: 'sec', now: () => t, sleep: async (ms) => void waits.push(ms) });
    expect(waits.some((w) => w > 0 && w <= 1000)).toBe(true);
  });
});

describe('productHuntSearch', () => {
  const body = {
    data: {
      posts: {
        edges: [
          { node: { name: 'Billy', tagline: 'Free invoicing for freelancers', url: 'https://www.producthunt.com/posts/billy', website: 'https://billy.test', createdAt: '2024-05-01T00:00:00Z', votesCount: 120, user: { name: 'maker' } } },
        ],
      },
    },
  };
  it('returns [] with no token and no network call', async () => {
    const { impl, calls } = router(() => ({ body }));
    expect(await productHuntSearch('saas', { fetch: impl })).toEqual([]);
    expect(calls).toHaveLength(0);
  });
  it('maps fields, bearer auth, no maker fields', async () => {
    const { impl, calls } = router(() => ({ body }));
    const r = await productHuntSearch('saas', { fetch: impl, sleep, token: 'T' });
    expect(r).toEqual([
      { name: 'Billy', tagline: 'Free invoicing for freelancers', url: 'https://billy.test', launchedAt: new Date('2024-05-01T00:00:00Z'), votes: 120, pricingHint: 'Free' },
    ]);
    expect(JSON.stringify(r)).not.toMatch(/maker|user/);
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe('Bearer T');
  });
  it('429 is rate_limited, bad token is auth', async () => {
    await expect(productHuntSearch('x', { fetch: router(() => ({ body: {}, status: 429 })).impl, sleep, token: 'T' })).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(productHuntSearch('x', { fetch: router(() => ({ body: {}, status: 401 })).impl, sleep, token: 'bad' })).rejects.toMatchObject({ code: 'auth' });
  });
  it('maps to a startup draft with active outcome', () => {
    const d = productHuntToDraft({ name: 'Billy', tagline: 'Invoices', url: 'https://billy.test/x', launchedAt: null, votes: 3 });
    expect(d.kind).toBe('startup');
    expect(d.facts).toMatchObject({ outcome: 'active', name: 'Billy' });
    expect(d.source).toMatchObject({ domain: 'billy.test', sourceType: 'producthunt', quoteVerified: false });
  });
});

describe('appReviews', () => {
  const feed = {
    feed: {
      entry: [
        { 'im:rating': { label: '1' }, title: { label: 'Broken' }, content: { label: 'Crashes constantly' }, updated: { label: '2024-01-02T00:00:00-07:00' }, id: { label: 'r1' }, author: { name: { label: 'someone' } } },
        { 'im:rating': { label: '5' }, title: { label: 'Great' }, content: { label: 'Love it' }, id: { label: 'r2' } },
      ],
    },
  };
  it('reads low-rated reviews by id, without author', async () => {
    const { impl, calls } = router(() => ({ body: feed }));
    const r = await appReviews('12345', { fetch: impl, sleep });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ source: 'appstore', title: 'Broken', text: 'Crashes constantly' });
    expect(JSON.stringify(r)).not.toMatch(/someone|author/);
    expect(calls[0]!.url).toContain('/us/rss/customerreviews/id=12345');
  });
  it('resolves a text query to an app id first', async () => {
    const { impl, calls } = router((u) => (u.includes('/search') ? { body: { results: [{ trackId: 999 }] } } : { body: feed }));
    const r = await appReviews('invoice app', { fetch: impl, sleep, country: 'ca' });
    expect(r).toHaveLength(1);
    expect(calls[1]!.url).toContain('/ca/rss/customerreviews/id=999');
  });
});

const yc = [
  { name: 'Alpha', one_liner: 'Payroll for startups', website: 'https://alpha.test', status: 'Active', batch: 'W20', industries: ['B2B', 'Fintech'], regions: ['United States of America'] },
  { name: 'Beta', one_liner: 'Dead thing', website: 'https://beta.test', status: 'Inactive', batch: 'S15', industries: ['Consumer'], regions: [] },
  { name: 'Weird', one_liner: 'x', website: '', status: 'Bogus', batch: '', industries: [], regions: [] },
];

describe('ycCompanies', () => {
  it('maps, filters, skips bad rows, and fetches once per process', async () => {
    const { impl, calls } = router(() => ({ body: yc }));
    const all = await ycCompanies({}, { fetch: impl });
    expect(all.map((c) => c.name)).toEqual(['Alpha', 'Beta']);
    expect(all[0]).toEqual({ name: 'Alpha', oneLiner: 'Payroll for startups', url: 'https://alpha.test', status: 'Active', batch: 'W20', industries: ['B2B', 'Fintech'], regions: ['United States of America'] });
    expect((await ycCompanies({ query: 'payroll' }, { fetch: impl })).map((c) => c.name)).toEqual(['Alpha']);
    expect((await ycCompanies({ industries: ['consumer'] }, { fetch: impl })).map((c) => c.name)).toEqual(['Beta']);
    expect(await ycCompanies({ limit: 1 }, { fetch: impl })).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});

describe('ycToDraft', () => {
  const base: YcCompany = { name: 'A', oneLiner: 'o', url: 'https://a.test', status: 'Active', batch: 'W20', industries: ['B2B'], regions: [] };
  it.each([
    ['Active', 'active'],
    ['Inactive', 'dead'],
    ['Acquired', 'acquired'],
    ['Public', 'public'],
  ] as const)('maps %s to %s', (status, outcome) => {
    const d = ycToDraft({ ...base, status });
    expect(d.kind).toBe('startup');
    expect(d.facts).toMatchObject({ outcome });
    expect(d.industries).toEqual(['B2B']);
    expect(d.source.sourceType).toBe('yc');
  });
});
