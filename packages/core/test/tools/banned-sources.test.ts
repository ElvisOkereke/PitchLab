import { describe, expect, it } from 'vitest';
import { isBannedSource } from '../../src/tools/banned-sources';

describe('isBannedSource', () => {
  it('bans every listed domain, including subdomains', () => {
    for (const url of [
      'https://www.reddit.com/r/webdev/comments/1',
      'https://old.reddit.com/r/x',
      'https://redd.it/abc',
      'https://www.g2.com/products/x/reviews',
      'https://capterra.com/p/1',
      'https://uk.trustpilot.com/review/acme.com',
      'https://www.upwork.com/jobs/x',
      'https://ca.indeed.com/viewjob?jk=1',
      'https://www.linkedin.com/posts/x',
      'https://www.bing.com/search?q=x',
      'HTTPS://WWW.REDDIT.COM/r/x',
    ]) {
      expect(isBannedSource(url), url).toBe(true);
    }
  });

  it('allows other domains, including look-alikes', () => {
    for (const url of [
      'https://news.ycombinator.com/item?id=1',
      'https://notreddit.com/x',
      'https://reddit.com.evil.example/x',
      'https://example.com/?ref=reddit.com',
    ]) {
      expect(isBannedSource(url), url).toBe(false);
    }
  });

  it('returns false for unparseable urls', () => {
    expect(isBannedSource('not a url')).toBe(false);
    expect(isBannedSource('')).toBe(false);
  });
});
