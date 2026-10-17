import { describe, expect, it, vi } from 'vitest';
import { fetchGithubIssueText, parseGithubIssueUrl } from '../../src/tools/github-issue';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('parseGithubIssueUrl', () => {
  it('accepts issue and pull urls, with a trailing slash, query or fragment', () => {
    expect(parseGithubIssueUrl('https://github.com/acme/forms/issues/12')).toEqual({ owner: 'acme', repo: 'forms', number: 12 });
    expect(parseGithubIssueUrl('https://github.com/acme/forms.js/pull/7/')).toEqual({ owner: 'acme', repo: 'forms.js', number: 7 });
    expect(parseGithubIssueUrl('https://github.com/acme/forms/issues/12#issuecomment-99')).toEqual({ owner: 'acme', repo: 'forms', number: 12 });
  });

  it('rejects anything else', () => {
    for (const u of [
      'https://github.com/acme/forms',
      'https://github.com/acme/forms/issues',
      'https://github.com/acme/forms/pull/7/files',
      'https://github.com.evil.example/acme/forms/issues/1',
      'http://github.com/acme/forms/issues/1',
      'https://gist.github.com/acme/forms/issues/1',
      'https://example.com/acme/forms/issues/1',
      'not a url',
    ]) expect(parseGithubIssueUrl(u)).toBeNull();
  });
});

describe('fetchGithubIssueText', () => {
  it('joins title, body and comment bodies from the API, sending the token as a Bearer header', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) =>
      url.endsWith('/comments?per_page=100')
        ? json([{ body: 'First comment' }, { body: 'Second &amp; <b>last</b>' }])
        : json({ title: 'Forms broke', body: 'Body text' }));
    const text = await fetchGithubIssueText('https://github.com/acme/forms/issues/12', { token: 'tok', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(text).toBe('Forms broke\n\nBody text\n\nFirst comment\n\nSecond & last');
    expect(fetchImpl.mock.calls.map((c) => c[0])).toEqual([
      'https://api.github.com/repos/acme/forms/issues/12',
      'https://api.github.com/repos/acme/forms/issues/12/comments?per_page=100',
    ]);
    const init = fetchImpl.mock.calls[0]![1] as unknown as RequestInit;
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('sends no Authorization header without a token, and keeps the issue text when only the comments call fails', async () => {
    const fetchImpl = vi.fn(async (url: string, _init?: RequestInit) => (url.includes('/comments') ? json({ message: 'nope' }, 500) : json({ title: 'T', body: null })));
    const text = await fetchGithubIssueText('https://github.com/acme/forms/pull/3', { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(text).toBe('T');
    expect((fetchImpl.mock.calls[0]![1] as unknown as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBeUndefined();
  });

  it('returns null when the issue call fails (e.g. 403 rate limit) or the url is not an issue', async () => {
    const fetchImpl = vi.fn(async () => json({ message: 'API rate limit exceeded' }, 403));
    expect(await fetchGithubIssueText('https://github.com/acme/forms/issues/1', { fetchImpl: fetchImpl as unknown as typeof fetch })).toBeNull();
    expect(await fetchGithubIssueText('https://example.com/x', { fetchImpl: fetchImpl as unknown as typeof fetch })).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
