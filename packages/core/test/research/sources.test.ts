import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetThrottle, SourceError } from '../../src/research/http';
import { redditSearch, resetRedditState } from '../../src/research/sources/reddit';
import { productHuntSearch, productHuntToDraft } from '../../src/research/sources/producthunt';
import { appPriceToDraft, appReviews } from '../../src/research/sources/appreviews';
import { parseFacts } from '../../src/library/kinds';
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
  it('slugifies the topic, falls back to a topic search, graphql errors are bad_response', async () => {
    const bodies: string[] = [];
    const { impl } = router((_u, init) => {
      const b = String(init?.body);
      bodies.push(b);
      if (b.includes('topics(')) return { body: { data: { topics: { edges: [{ node: { slug: 'saas-tools' } }] } } } };
      if (b.includes('"topic":"saas-tools"')) return { body };
      return { body: { data: { posts: { edges: [] } } } };
    });
    const r = await productHuntSearch('Invoicing Tools!', { fetch: impl, sleep, token: 'T' });
    expect(r).toHaveLength(1);
    expect(bodies[0]).toContain('"topic":"invoicing-tools"');
    await expect(productHuntSearch('x', { fetch: router(() => ({ body: { errors: [{ message: 'bad' }] } })).impl, sleep, token: 'T' })).rejects.toMatchObject({ code: 'bad_response' });
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
  it('rejects non-English storefronts and surfaces HTTP failures', async () => {
    await expect(appReviews('1', { fetch: router(() => ({ body: feed })).impl, sleep, country: 'de' })).rejects.toMatchObject({ code: 'bad_response' });
    await expect(appReviews('1', { fetch: router(() => ({ body: {}, status: 429 })).impl, sleep })).rejects.toMatchObject({ code: 'rate_limited' });
  });
  it('reports the resolved app (name, price, genre, url) through onApp', async () => {
    const found = { trackId: 999, trackName: 'QuoteMaster', price: 4.99, currency: 'USD', formattedPrice: '$4.99', primaryGenreName: 'Business', trackViewUrl: 'https://apps.apple.com/ca/app/q/id999' };
    const { impl } = router((u) => (u.includes('/search') ? { body: { results: [found] } } : { body: feed }));
    const apps: unknown[] = [];
    await appReviews('quote app', { fetch: impl, sleep, country: 'ca', onApp: (a) => apps.push(a) });
    expect(apps).toEqual([{ trackName: 'QuoteMaster', price: 4.99, currency: 'USD', formattedPrice: '$4.99', primaryGenreName: 'Business', trackViewUrl: 'https://apps.apple.com/ca/app/q/id999', country: 'ca' }]);
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

describe('ycCompanies failures', () => {
  it('surfaces 429 as SourceError and does not cache it', async () => {
    await expect(ycCompanies({}, { fetch: router(() => ({ body: {}, status: 429 })).impl })).rejects.toMatchObject({ code: 'rate_limited' });
    const ok = router(() => ({ body: yc }));
    expect(await ycCompanies({}, { fetch: ok.impl })).toHaveLength(2);
  });
});

const body = { data: { posts: { edges: [{ node: { name: 'N', tagline: 't', url: 'https://n.test', createdAt: '2024-01-01T00:00:00Z', votesCount: 1 } }] } } };

describe('secrets and mapper facts', () => {
  it('SourceError messages never contain the client secret or token', async () => {
    for (const status of [401, 429, 500]) {
      const { impl } = router((url) => (url.includes('access_token') ? { body: {}, status } : { body: {}, status }));
      const err = await redditSearch('a', { fetch: impl, sleep, clientId: 'cid-xyz', clientSecret: 'SECRET-123' }).catch((e) => e);
      expect(String(err.message)).not.toMatch(/SECRET-123|cid-xyz|Basic /);
    }
    const err = await productHuntSearch('a', { fetch: router(() => ({ body: {}, status: 401 })).impl, sleep, token: 'TOKEN-ABC' }).catch((e) => e);
    expect(String(err.message)).not.toContain('TOKEN-ABC');
  });
  it('clears the cached reddit token on auth failure', async () => {
    let searches = 0;
    const { impl, calls } = router((url) => {
      if (url.includes('access_token')) return { body: { access_token: 't', expires_in: 3600 } };
      searches++;
      return searches === 1 ? { body: {}, status: 401 } : { body: { data: { children: [] } } };
    });
    const o = { fetch: impl, sleep, clientId: 'id', clientSecret: 's' };
    await expect(redditSearch('a', o)).rejects.toMatchObject({ code: 'auth' });
    await redditSearch('a', o);
    expect(calls.filter((c) => c.url.includes('access_token'))).toHaveLength(2);
  });
  it('serialises concurrent calls per host (gaps >= interval) and survives a throwing onCall', async () => {
    let t = 0;
    const starts: number[] = [];
    const impl = (async () => {
      starts.push(t);
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const o = { fetch: impl, sleep: async (ms: number) => void (t += ms), now: () => t, token: 'T', onCall: () => { throw new Error('logger down'); } };
    await Promise.all([1, 2, 3, 4].map((i) => productHuntSearch(`t${i}`, o)));
    expect(starts).toHaveLength(4);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(1000);
  });
  it('returns [] for an unslugifiable topic without any request', async () => {
    const { impl, calls } = router(() => ({ body }));
    expect(await productHuntSearch('!!!', { fetch: impl, sleep, token: 'T' })).toEqual([]);
    expect(calls).toHaveLength(0);
  });
  it('mapper output passes parseFacts', () => {
    const base: YcCompany = { name: 'A', oneLiner: 'o', url: 'https://a.test', status: 'Active', batch: 'W20', industries: [], regions: [] };
    for (const status of ['Active', 'Inactive', 'Acquired', 'Public'] as const) expect(() => parseFacts('startup', ycToDraft({ ...base, status }).facts)).not.toThrow();
    expect(() => parseFacts('startup', productHuntToDraft({ name: 'B', tagline: 't', url: 'https://b.test', launchedAt: null, votes: 1 }).facts)).not.toThrow();
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

describe('appPriceToDraft', () => {
  const app = { trackName: 'QuoteMaster', price: 4.99, currency: 'USD', formattedPrice: '$4.99', primaryGenreName: 'Business', trackViewUrl: 'https://apps.apple.com/us/app/q/id9', country: 'us' };
  it('maps a paid app to a valid structured pricing draft', () => {
    const d = appPriceToDraft(app)!;
    expect(d.kind).toBe('pricing');
    expect(parseFacts('pricing', d.facts)).toEqual({ product: 'QuoteMaster', pricePoints: [{ amount: 4.99, currency: 'USD', unit: 'one-time' }], buyer: 'Business app users', complaints: [] });
    expect(d.source).toMatchObject({ url: app.trackViewUrl, sourceType: 'appstore', quoteVerified: false, domain: 'apps.apple.com' });
    expect(d.countries).toEqual(['US']);
  });
  it('returns null for a free app or a missing price', () => {
    expect(appPriceToDraft({ ...app, price: 0 })).toBeNull();
    expect(appPriceToDraft({ ...app, price: undefined })).toBeNull();
  });
});
