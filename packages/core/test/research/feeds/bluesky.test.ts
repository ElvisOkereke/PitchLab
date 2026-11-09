import { beforeEach, describe, expect, it } from 'vitest';
import { resetThrottle } from '../../../src/research/http';
import { blueskyFeed, resetBlueskyState } from '../../../src/research/feeds/bluesky';
import { header, json, mockFetch, opts, text } from './helpers';

beforeEach(() => {
  resetThrottle();
  resetBlueskyState();
});

const LONG = 'Honestly I spend six hours a week chasing unpaid invoices and nothing fixes it.';
const post = (rkey: string, body = LONG) => ({
  uri: `at://did:plc:abc123/app.bsky.feed.post/${rkey}`,
  author: { handle: 'secret.handle.example', displayName: 'Secret Name' },
  record: { text: body, createdAt: '2026-11-01T10:00:00Z' },
});

describe('blueskyFeed', () => {
  it('searches the public AppView with limit 25 and builds author-free post urls', async () => {
    const f = mockFetch(() => json({ posts: [post('3kabc'), post('3kdef', 'too short')] }));
    const items = await blueskyFeed('invoice pain', opts(f.impl));
    const u = f.calls[0]!.url;
    expect(u.origin + u.pathname).toBe('https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts');
    expect(u.searchParams.get('q')).toBe('invoice pain');
    expect(u.searchParams.get('limit')).toBe('25');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: 'bluesky', url: 'https://bsky.app/profile/did:plc:abc123/post/3kabc', text: LONG });
    expect(JSON.stringify(items)).not.toContain('secret');
  });

  it('stops with an auth error naming the env vars when the endpoint wants sign-in and none are set', async () => {
    const f = mockFetch(() => text('AuthMissing', 401));
    await expect(blueskyFeed('x y', opts(f.impl))).rejects.toMatchObject({ code: 'auth', message: expect.stringContaining('BLUESKY_APP_PASSWORD') });
    expect(f.calls).toHaveLength(1);
  });

  it('on 403 with credentials, creates a session and retries with the bearer token; secrets stay out of errors', async () => {
    const f = mockFetch((u) => {
      if (u.hostname === 'public.api.bsky.app') return text('Forbidden', 403);
      if (u.pathname.endsWith('createSession')) return json({ accessJwt: 'jwt-secret-token' });
      return json({ posts: [post('3kabc')] });
    });
    const items = await blueskyFeed('x y', { ...opts(f.impl), handle: 'me.bsky.social', appPassword: 'app-pass-secret' });
    expect(items).toHaveLength(1);
    const session = f.calls[1]!;
    expect(session.url.href).toBe('https://bsky.social/xrpc/com.atproto.server.createSession');
    expect(JSON.parse(String(session.init.body))).toEqual({ identifier: 'me.bsky.social', password: 'app-pass-secret' });
    const retry = f.calls[2]!;
    expect(retry.url.hostname).toBe('bsky.social');
    expect(header(retry.init, 'Authorization')).toBe('Bearer jwt-secret-token');
    // a later query reuses the session
    await blueskyFeed('again now', { ...opts(f.impl), handle: 'me.bsky.social', appPassword: 'app-pass-secret' });
    expect(f.calls.filter((c) => c.url.pathname.endsWith('createSession'))).toHaveLength(1);
  });

  it('a failed sign-in error carries no password or token', async () => {
    const f = mockFetch((u) => (u.pathname.endsWith('createSession') ? text('{"error":"AuthenticationRequired","message":"app-pass-secret"}', 401) : text('no', 401)));
    const err = await blueskyFeed('x y', { ...opts(f.impl), handle: 'me.bsky.social', appPassword: 'app-pass-secret' }).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain('app-pass-secret');
    expect(JSON.stringify(err)).not.toContain('app-pass-secret');
  });

  it('maps 429 to rate_limited and HTML to bad_response', async () => {
    await expect(blueskyFeed('x y', opts(mockFetch(() => text('', 429)).impl))).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(blueskyFeed('x y', opts(mockFetch(() => text('<html></html>', 200, 'text/html')).impl))).rejects.toMatchObject({ code: 'bad_response' });
  });
});
