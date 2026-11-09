import { beforeEach, describe, expect, it } from 'vitest';
import { resetThrottle, SourceError, USER_AGENT } from '../../../src/research/http';
import { redditFeed } from '../../../src/research/feeds/reddit';
import { header, json, mockFetch, opts, text } from './helpers';

beforeEach(resetThrottle);

const post = (id: string, title: string, selftext = '') => ({
  data: { id, title, selftext, permalink: `/r/smallbusiness/comments/${id}/slug/`, created_utc: 1_760_000_000, author: 'someone_secret' },
});
const comment = (id: string, pid: string, body: string) => ({
  data: { body, permalink: `/r/smallbusiness/comments/${pid}/slug/${id}/`, created_utc: 1_760_000_100, author: 'commenter_secret' },
});
const listing = (children: unknown[]) => ({ data: { children } });
const comments = (pid: string, n: number) => [listing([]), listing(Array.from({ length: n }, (_, i) => comment(`c${pid}${i}`, pid, `Comment ${i} on ${pid} says invoices take forever.`)))];

describe('redditFeed', () => {
  it('searches the public json endpoint, newest this week, with the PitchLab user agent', async () => {
    const f = mockFetch((u) => json(u.pathname.startsWith('/comments/') ? comments('a1', 0) : listing([post('a1', 'Invoice pain', 'Chasing invoices takes hours')])));
    const items = await redditFeed('invoice software', opts(f.impl));
    const u = f.calls[0]!.url;
    expect(u.origin + u.pathname).toBe('https://www.reddit.com/search.json');
    expect(u.searchParams.get('q')).toBe('invoice software');
    expect(u.searchParams.get('sort')).toBe('new');
    expect(u.searchParams.get('t')).toBe('week');
    expect(header(f.calls[0]!.init, 'User-Agent')).toBe(USER_AGENT);
    expect(items[0]).toMatchObject({ source: 'reddit', url: 'https://www.reddit.com/r/smallbusiness/comments/a1/slug/', title: 'Invoice pain', text: 'Chasing invoices takes hours' });
    expect(JSON.stringify(items)).not.toContain('secret');
  });

  it('reads a subreddit top of the week for r/<name>', async () => {
    const f = mockFetch((u) => json(u.pathname.startsWith('/comments/') ? comments('a1', 0) : listing([post('a1', 'Top post')])));
    await redditFeed('r/smallbusiness', opts(f.impl));
    expect(f.calls[0]!.url.pathname).toBe('/r/smallbusiness/top.json');
    expect(f.calls[0]!.url.searchParams.get('t')).toBe('week');
  });

  it('fetches comments (limit 10) only for the top 3 posts, and never exceeds 25 items per query', async () => {
    const posts = Array.from({ length: 15 }, (_, i) => post(`p${i}x`, `Post ${i}`, `Body of post ${i}`));
    const f = mockFetch((u) => json(u.pathname.startsWith('/comments/') ? comments(u.pathname.split('/')[2]!.replace('.json', ''), 10) : listing(posts)));
    const items = await redditFeed('freight', opts(f.impl));
    const commentCalls = f.calls.filter((c) => c.url.pathname.startsWith('/comments/'));
    expect(commentCalls.map((c) => c.url.pathname)).toEqual(['/comments/p0x.json']); // 15 posts leave room for 10 comments only
    expect(commentCalls[0]!.url.searchParams.get('limit')).toBe('10');
    expect(items).toHaveLength(25);
  });

  it('waits at least 2 seconds between requests to reddit', async () => {
    const sleeps: number[] = [];
    const f = mockFetch((u) => json(u.pathname.startsWith('/comments/') ? comments('p0x', 1) : listing([post('p0x', 'A'), post('p1x', 'B')])));
    await redditFeed('freight', opts(f.impl, sleeps));
    expect(f.calls.length).toBe(3);
    expect(sleeps).toHaveLength(2); // none before the first request, one before each later one
    for (const ms of sleeps) expect(ms).toBeGreaterThan(1500);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(2000);
  });

  it('maps 429 to rate_limited', async () => {
    const f = mockFetch(() => text('slow down', 429));
    await expect(redditFeed('x y', opts(f.impl))).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('treats an HTML page as a bad response', async () => {
    const f = mockFetch(() => text('<!doctype html><html><body>Blocked</body></html>', 200, 'text/html'));
    await expect(redditFeed('x y', opts(f.impl))).rejects.toBeInstanceOf(SourceError);
    await expect(redditFeed('x y', opts(f.impl))).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('treats JSON without a post list as a bad response', async () => {
    const f = mockFetch(() => json({ message: 'nope' }));
    await expect(redditFeed('x y', opts(f.impl))).rejects.toMatchObject({ code: 'bad_response' });
  });
});
