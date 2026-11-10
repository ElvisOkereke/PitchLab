import { beforeEach, describe, expect, it } from 'vitest';
import { resetThrottle, SourceError, USER_AGENT } from '../../../src/research/http';
import { redditFeed } from '../../../src/research/feeds/reddit';
import { header, mockFetch, opts, text } from './helpers';

beforeEach(resetThrottle);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const author = (name: string) => `<author><name>/u/${name}</name><uri>https://www.reddit.com/user/${name}</uri></author>`;
/** A post entry as Reddit's Atom feeds write it, footer and all. */
const post = (id: string, title: string, body = '') =>
  `<entry>${author('someone_secret')}<content type="html">${esc(
    `${body ? `<!-- SC_OFF --><div class="md"><p>${body}</p></div><!-- SC_ON -->` : ''} &#32; submitted by &#32; <a href="https://www.reddit.com/user/someone_secret"> /u/someone_secret </a> <span><a href="https://example.com/x">[link]</a></span> &#32; <span><a href="https://www.reddit.com/r/smallbusiness/comments/${id}/slug/">[comments]</a></span>`,
  )}</content><id>t3_${id}</id><link href="https://www.reddit.com/r/smallbusiness/comments/${id}/slug/" /><published>2026-11-01T10:00:00+00:00</published><title>${esc(title)}</title></entry>`;
const comment = (id: string, pid: string, body: string) =>
  `<entry>${author('commenter_secret')}<content type="html">${esc(`<!-- SC_OFF --><div class="md"><p>${body}</p></div><!-- SC_ON -->`)}</content><id>t1_${id}</id><link href="https://www.reddit.com/r/smallbusiness/comments/${pid}/slug/${id}/"/><published>2026-11-01T11:00:00+00:00</published><title>/u/commenter_secret on x</title></entry>`;
const feed = (entries: string[]) => `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>${entries.join('')}</feed>`;
const atom = (entries: string[]) => text(feed(entries), 200, 'application/atom+xml');
const commentsFeed = (pid: string, n: number) =>
  atom([post(pid, 'the post again'), ...Array.from({ length: n }, (_, i) => comment(`c${pid}${i}`, pid, `Comment ${i} on ${pid} says invoices take forever.`))]);
const isComments = (u: URL) => u.pathname.startsWith('/comments/');
const pidOf = (u: URL) => u.pathname.split('/')[2]!;

describe('redditFeed', () => {
  it('searches the public Atom feed, newest this week, with the PitchLab user agent', async () => {
    const f = mockFetch((u) => (isComments(u) ? commentsFeed(pidOf(u), 0) : atom([post('a1', 'Invoice pain', 'Chasing invoices takes hours')])));
    const items = await redditFeed('invoice software', opts(f.impl));
    const u = f.calls[0]!.url;
    expect(u.origin + u.pathname).toBe('https://www.reddit.com/search.rss');
    expect(u.searchParams.get('q')).toBe('invoice software');
    expect(u.searchParams.get('sort')).toBe('new');
    expect(u.searchParams.get('t')).toBe('week');
    expect(header(f.calls[0]!.init, 'User-Agent')).toBe(USER_AGENT);
    expect(items[0]).toMatchObject({ source: 'reddit', url: 'https://www.reddit.com/r/smallbusiness/comments/a1/slug/', title: 'Invoice pain', text: 'Chasing invoices takes hours' });
  });

  it('never keeps authors, /u/ handles or the submitted-by footer', async () => {
    const f = mockFetch((u) => (isComments(u) ? commentsFeed(pidOf(u), 2) : atom([post('a1', 'Invoice pain', 'Ask u/helper_secret about it'), post('a2', 'Link only')])));
    const items = await redditFeed('invoice software', opts(f.impl));
    const s = JSON.stringify(items);
    expect(s).not.toContain('secret');
    expect(s).not.toContain('submitted by');
    expect(s).not.toContain('[comments]');
    expect(items.find((i) => i.title === 'Link only')!.text).toBe('Link only');
  });

  it('reads a subreddit top of the week for r/<name>', async () => {
    const f = mockFetch((u) => (isComments(u) ? commentsFeed(pidOf(u), 0) : atom([post('a1', 'Top post')])));
    await redditFeed('r/smallbusiness', opts(f.impl));
    expect(f.calls[0]!.url.pathname).toBe('/r/smallbusiness/top/.rss');
    expect(f.calls[0]!.url.searchParams.get('t')).toBe('week');
  });

  it('keeps comments (not the post entry) for the top posts, with comment permalinks', async () => {
    const f = mockFetch((u) => (isComments(u) ? commentsFeed(pidOf(u), 2) : atom([post('a1', 'Invoice pain', 'Body')])));
    const items = await redditFeed('invoices', opts(f.impl));
    expect(f.calls[1]!.url.pathname).toBe('/comments/a1/.rss');
    expect(items.map((i) => i.url)).toEqual([
      'https://www.reddit.com/r/smallbusiness/comments/a1/slug/',
      'https://www.reddit.com/r/smallbusiness/comments/a1/slug/ca10/',
      'https://www.reddit.com/r/smallbusiness/comments/a1/slug/ca11/',
    ]);
    expect(items[1]).toMatchObject({ title: 'Invoice pain', text: 'Comment 0 on a1 says invoices take forever.' });
  });

  it('fetches comments only for the top 3 posts, and never exceeds 25 items per query', async () => {
    const posts = Array.from({ length: 15 }, (_, i) => post(`p${i}x`, `Post ${i}`, `Body of post ${i}`));
    const f = mockFetch((u) => (isComments(u) ? commentsFeed(pidOf(u), 10) : atom(posts)));
    const items = await redditFeed('freight', opts(f.impl));
    const commentCalls = f.calls.filter((c) => isComments(c.url));
    expect(commentCalls.map((c) => c.url.pathname)).toEqual(['/comments/p0x/.rss']); // 15 posts leave room for 10 comments only
    expect(commentCalls[0]!.url.searchParams.get('limit')).toBe('10');
    expect(items).toHaveLength(25);
  });

  it('waits about 6 seconds between requests to reddit', async () => {
    const sleeps: number[] = [];
    const f = mockFetch((u) => (isComments(u) ? commentsFeed(pidOf(u), 1) : atom([post('p0x', 'A'), post('p1x', 'B')])));
    await redditFeed('freight', opts(f.impl, sleeps));
    expect(f.calls.length).toBe(3);
    expect(sleeps).toHaveLength(2); // none before the first request, one before each later one
    for (const ms of sleeps) expect(ms).toBeGreaterThan(5000);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(6000);
  });

  it('drops links that are not reddit post permalinks', async () => {
    const bad = post('a1', 'Elsewhere').replace(/<link href="[^"]*"/, '<link href="https://evil.example/r/x/comments/a1/slug/"');
    const f = mockFetch((u) => (isComments(u) ? commentsFeed(pidOf(u), 0) : atom([bad, post('a2', 'Fine')])));
    const items = await redditFeed('x y', opts(f.impl));
    expect(items.map((i) => i.title)).toEqual(['Fine']);
  });

  it('maps 429 to rate_limited and 403 to auth', async () => {
    await expect(redditFeed('x y', opts(mockFetch(() => text('slow down', 429)).impl))).rejects.toMatchObject({ code: 'rate_limited' });
    resetThrottle();
    await expect(redditFeed('x y', opts(mockFetch(() => text('blocked', 403)).impl))).rejects.toMatchObject({ code: 'auth' });
  });

  it('treats an HTML page as a bad response', async () => {
    const f = mockFetch(() => text('<!doctype html><html><body>Blocked</body></html>', 200, 'text/html'));
    await expect(redditFeed('x y', opts(f.impl))).rejects.toBeInstanceOf(SourceError);
    await expect(redditFeed('x y', opts(f.impl))).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('an empty feed is no items, not an error', async () => {
    const f = mockFetch(() => atom([]));
    await expect(redditFeed('x y', opts(f.impl))).resolves.toEqual([]);
  });
});
