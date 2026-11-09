import { beforeEach, describe, expect, it } from 'vitest';
import { resetThrottle } from '../../../src/research/http';
import { arxivFeed, arxivQuery } from '../../../src/research/feeds/arxiv';
import { githubTrendingFeed } from '../../../src/research/feeds/githubtrending';
import { hnShowFeed } from '../../../src/research/feeds/hnshow';
import { huggingFaceFeed } from '../../../src/research/feeds/huggingface';
import { ytShortsFeed } from '../../../src/research/feeds/ytshorts';
import { testDb } from '../../helpers/db';
import { json, mockFetch, opts, text } from './helpers';

beforeEach(resetThrottle);

describe('hnShowFeed', () => {
  const hit = (id: string, title: string, story = '') => ({ objectID: id, title, story_text: story, points: 12, num_comments: 3, created_at: '2026-11-01T00:00:00Z', author: 'secretauthor' });

  it('asks Algolia for show_hn and ask_hn, newest first, and links to the HN item', async () => {
    const f = mockFetch((u) => json({ hits: [hit(u.searchParams.get('tags') === 'show_hn' ? '111' : '222', 'Show HN: invoice bot', 'I built a bot')] }));
    const items = await hnShowFeed('', opts(f.impl));
    expect(f.calls.map((c) => c.url.pathname)).toEqual(['/api/v1/search_by_date', '/api/v1/search_by_date']);
    expect(f.calls.map((c) => c.url.searchParams.get('tags'))).toEqual(['show_hn', 'ask_hn']);
    expect(f.calls[0]!.url.searchParams.has('query')).toBe(false);
    expect(items.map((i) => i.url)).toEqual(['https://news.ycombinator.com/item?id=111', 'https://news.ycombinator.com/item?id=222']);
    expect(items[0]).toMatchObject({ source: 'hn', title: 'Show HN: invoice bot' });
    expect(items[0]!.text).toContain('Show HN post, 12 points, 3 comments');
    expect(JSON.stringify(items)).not.toContain('secretauthor');
  });

  it('passes a query through and caps a query at 25 items', async () => {
    const hits = Array.from({ length: 40 }, (_, i) => hit(String(1000 + i), `Show HN: thing ${i}`));
    const f = mockFetch(() => json({ hits }));
    const items = await hnShowFeed('freight', opts(f.impl));
    expect(f.calls[0]!.url.searchParams.get('query')).toBe('freight');
    expect(items).toHaveLength(25);
  });

  it('maps 429 and HTML', async () => {
    await expect(hnShowFeed('', opts(mockFetch(() => text('', 429)).impl))).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(hnShowFeed('', opts(mockFetch(() => text('<html>', 200, 'text/html')).impl))).rejects.toMatchObject({ code: 'bad_response' });
  });
});

describe('arxivFeed', () => {
  const entry = (id: string, title: string, summary: string) => `<entry><id>http://arxiv.org/abs/${id}</id><title>${title}</title><summary>${summary}</summary><published>2026-11-01T00:00:00Z</published><author><name>Secret Author</name></author></entry>`;
  const atom = (...entries: string[]) => `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${entries.join('')}</feed>`;

  it('builds an AND query, sorts by submission date, and parses the Atom entries', async () => {
    const f = mockFetch(() => text(atom(entry('2611.00001v1', 'Agents for invoices', 'We study agents.')), 200, 'application/atom+xml'));
    const items = await arxivFeed('invoice agents, small business', opts(f.impl));
    const u = f.calls[0]!.url;
    expect(u.origin + u.pathname).toBe('https://export.arxiv.org/api/query');
    expect(u.searchParams.get('search_query')).toBe('all:invoice AND all:agents AND all:small AND all:business');
    expect(u.searchParams.get('sortBy')).toBe('submittedDate');
    expect(u.searchParams.get('max_results')).toBe('25');
    expect(items).toEqual([expect.objectContaining({ source: 'arxiv', url: 'https://arxiv.org/abs/2611.00001v1', title: 'Agents for invoices' })]);
    expect(items[0]!.text).toContain('We study agents.');
    expect(JSON.stringify(items)).not.toContain('Secret Author');
  });

  it('arxivQuery keeps five words and drops punctuation', () => {
    expect(arxivQuery('A b, one two three four five six')).toBe('all:one AND all:two AND all:three AND all:four AND all:five');
  });

  it('stops on 429 and on HTML where Atom was expected', async () => {
    await expect(arxivFeed('agents now', opts(mockFetch(() => text('', 429)).impl))).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(arxivFeed('agents now', opts(mockFetch(() => text('<!doctype html><html></html>', 200, 'text/html')).impl))).rejects.toMatchObject({ code: 'bad_response' });
  });
});

describe('huggingFaceFeed', () => {
  it('reads trending models and spaces', async () => {
    const f = mockFetch((u) =>
      json(u.pathname === '/api/models'
        ? [{ id: 'acme/tiny-llm', pipeline_tag: 'text-generation', tags: ['gguf', 'chat'], likes: 50, downloads: 1000, createdAt: '2026-10-30T00:00:00Z' }]
        : [{ id: 'acme/demo', sdk: 'gradio', likes: 9 }]));
    const items = await huggingFaceFeed('ignored', opts(f.impl));
    expect(f.calls.map((c) => `${c.url.pathname}?sort=${c.url.searchParams.get('sort')}`)).toEqual(['/api/models?sort=trendingScore', '/api/spaces?sort=trendingScore']);
    expect(items.map((i) => i.url)).toEqual(['https://huggingface.co/acme/tiny-llm', 'https://huggingface.co/spaces/acme/demo']);
    expect(items[0]!.text).toContain('text-generation');
    expect(items[0]).toMatchObject({ source: 'huggingface' });
  });

  it('caps at 25 and maps 429, HTML and non-list JSON', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `o/m${i}` }));
    expect(await huggingFaceFeed('', opts(mockFetch(() => json(many)).impl))).toHaveLength(25);
    await expect(huggingFaceFeed('', opts(mockFetch(() => text('', 429)).impl))).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(huggingFaceFeed('', opts(mockFetch(() => text('<html>', 200, 'text/html')).impl))).rejects.toMatchObject({ code: 'bad_response' });
    await expect(huggingFaceFeed('', opts(mockFetch(() => json({ error: 'x' })).impl))).rejects.toMatchObject({ code: 'bad_response' });
  });
});

describe('githubTrendingFeed', () => {
  const row = (repo: string, desc: string) => `<article class="Box-row"><h2 class="h3 lh-condensed"><a href="/${repo}" data-view-component="true"> ${repo.replace('/', ' / ')}</a></h2><p class="col-9 color-fg-muted my-1 pr-4">${desc}</p><div><span itemprop="programmingLanguage">TypeScript</span><span class="d-inline-block float-sm-right">1,234 stars this week</span></div></article>`;

  it('requests the weekly trending page and parses repo, description and stars', async () => {
    const f = mockFetch(() => text(`<html><body>${row('acme/invoicer', 'Invoices &amp; quotes for crews')}${row('acme/other', 'Other')}</body></html>`, 200, 'text/html'));
    const items = await githubTrendingFeed('', opts(f.impl));
    expect(f.calls[0]!.url.href).toBe('https://github.com/trending?since=weekly');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ source: 'githubtrending', url: 'https://github.com/acme/invoicer', title: 'acme/invoicer' });
    expect(items[0]!.text).toBe('acme/invoicer: Invoices & quotes for crews. Language: TypeScript. 1,234 stars this week.');
  });

  it('caps at 25 and stops when the page has no repository rows or the server limits us', async () => {
    const many = Array.from({ length: 40 }, (_, i) => row(`o/r${i}`, 'd')).join('');
    expect(await githubTrendingFeed('', opts(mockFetch(() => text(`<html>${many}</html>`, 200, 'text/html')).impl))).toHaveLength(25);
    await expect(githubTrendingFeed('', opts(mockFetch(() => text('<html><body>Sign in</body></html>', 200, 'text/html')).impl))).rejects.toMatchObject({ code: 'bad_response' });
    await expect(githubTrendingFeed('', opts(mockFetch(() => text('', 429)).impl))).rejects.toMatchObject({ code: 'rate_limited' });
  });
});

describe('ytShortsFeed', () => {
  it('searches with videoDuration=short under the quota guard and returns video and comment items', async () => {
    const db = await testDb();
    const f = mockFetch((u) => {
      if (u.pathname.endsWith('/search')) return json({ items: [{ id: { videoId: 'abcdefghijk' } }] });
      if (u.pathname.endsWith('/videos')) return json({ items: [{ id: 'abcdefghijk', snippet: { title: 'Quick invoice tip', description: 'How I chase invoices', publishedAt: '2026-11-01T00:00:00Z' } }] });
      return json({ items: [{ snippet: { topLevelComment: { snippet: { textOriginal: 'This is exactly my problem every month', publishedAt: '2026-11-02T00:00:00Z', authorDisplayName: 'Secret' } } } }] });
    });
    const items = await ytShortsFeed('invoice tips', { fetch: f.impl, sleep: async () => {}, apiKey: 'k', db });
    expect(f.calls[0]!.url.searchParams.get('videoDuration')).toBe('short');
    expect(f.calls[0]!.url.searchParams.get('type')).toBe('video');
    expect(items.length).toBe(2);
    expect(items.every((i) => i.source === 'youtube')).toBe(true);
    expect(JSON.stringify(items)).not.toContain('Secret');
  });

  it('makes no request without a key', async () => {
    const db = await testDb();
    const f = mockFetch(() => json({}));
    expect(await ytShortsFeed('x y', { fetch: f.impl, sleep: async () => {}, db })).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });
});
