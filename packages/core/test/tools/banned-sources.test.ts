import { describe, expect, it } from 'vitest';
import { BANNED_DOMAINS, NEVER_FETCH_HOSTS, isBannedSource, isNeverFetchHost } from '../../src/tools/banned-sources';
import { NEVER_FETCH_HOSTS as FetchPageHosts, isNeverFetchHost as fetchPageIsNeverFetchHost } from '../../src/tools/fetch-page';

describe('never-fetch hosts (P3-R8)', () => {
  it('isBannedSource also refuses the pilot site and its subdomains; look-alikes pass', () => {
    expect(NEVER_FETCH_HOSTS).toContain('gamersgetaway.ca');
    for (const url of ['https://www.gamersgetaway.ca/x', 'http://gamersgetaway.ca', 'https://SHOP.GamersGetaway.CA./cart']) {
      expect(isBannedSource(url), url).toBe(true);
      expect(isNeverFetchHost(new URL(url).hostname), url).toBe(true);
    }
    expect(isBannedSource('https://notgamersgetaway.ca/')).toBe(false);
    expect(isNeverFetchHost('gamersgetaway.ca.evil.com')).toBe(false);
  });

  it('trailing dots and empty labels fail closed (P3-R13)', () => {
    for (const host of ['gamersgetaway.ca.', 'gamersgetaway.ca..', 'www..gamersgetaway.ca', 'GAMERSGETAWAY.CA...', 'www..example.com']) {
      expect(isNeverFetchHost(host), host).toBe(true);
    }
    for (const url of ['https://gamersgetaway.ca./', 'https://gamersgetaway.ca../', 'https://www..gamersgetaway.ca/', 'https://a..example.com/']) {
      expect(isBannedSource(url), url).toBe(true);
    }
    expect(isNeverFetchHost('example.com.')).toBe(false);
  });

  it('fetch-page re-exports the same list and check', () => {
    expect(FetchPageHosts).toBe(NEVER_FETCH_HOSTS);
    expect(fetchPageIsNeverFetchHost).toBe(isNeverFetchHost);
  });
});

describe('isBannedSource', () => {
  it('bans only bing.com now, including subdomains (owner ruling 2026-11-08: terms-of-service bans lifted)', () => {
    expect(BANNED_DOMAINS).toEqual(['bing.com']);
    for (const url of ['https://www.bing.com/search?q=x', 'https://bing.com/', 'HTTPS://WWW.BING.COM/x']) {
      expect(isBannedSource(url), url).toBe(true);
    }
  });

  it('allows reddit, G2, Capterra, Trustpilot, Upwork, Indeed and LinkedIn, and other domains', () => {
    for (const url of [
      'https://news.ycombinator.com/item?id=1',
      'https://www.reddit.com/r/webdev/comments/1',
      'https://old.reddit.com/r/x',
      'https://redd.it/abc',
      'https://www.g2.com/products/x/reviews',
      'https://capterra.com/p/1',
      'https://uk.trustpilot.com/review/acme.com',
      'https://www.upwork.com/jobs/x',
      'https://ca.indeed.com/viewjob?jk=1',
      'https://www.linkedin.com/posts/x',
      'https://notbing.com/x',
      'https://bing.com.evil.example/x',
      'https://example.com/?ref=bing.com',
    ]) {
      expect(isBannedSource(url), url).toBe(false);
    }
  });

  it('the never-fetch pilot site stays refused whatever the banned list says', () => {
    expect(isBannedSource('https://gamersgetaway.ca/')).toBe(true);
    expect(isBannedSource('https://shop.gamersgetaway.ca/x')).toBe(true);
  });

  it('fails closed: unparseable, non-http(s) and IP-literal urls count as banned', () => {
    for (const url of [
      'not a url',
      '',
      'javascript:alert(1)',
      'ftp://example.com/file',
      'file:///etc/passwd',
      'http://1.2.3.4/x',
      'http://[::1]/x',
      'https://[2606:4700::1111]/',
    ]) {
      expect(isBannedSource(url), url).toBe(true);
    }
  });
});
