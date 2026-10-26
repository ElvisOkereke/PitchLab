import { describe, expect, it } from 'vitest';
import { capQuote, scrubPersonal } from '../../src/research/privacy';

describe('scrubPersonal', () => {
  it.each([
    ['thanks u/some_guy for that', 'some_guy'],
    ['see /u/Other-One said', 'Other-One'],
    ['ping @handle_1 please', 'handle_1'],
    ['email me at jane.doe@example.com now', 'jane.doe'],
    ['https://www.reddit.com/user/bob/ is me', 'bob'],
    ['https://twitter.com/alice99 tweeted', 'alice99'],
    ['https://x.com/carol tweeted', 'carol'],
    ['see twitter.com/scheme_less now', 'scheme_less'],
    ['see x.com/nohttp now', 'nohttp'],
    ['https://facebook.com/fbuser/posts/1', 'fbuser'],
    ['https://www.instagram.com/instauser/', 'instauser'],
    ['https://github.com/ghuser', 'ghuser'],
    ['github.com/ghuser/ is me', 'ghuser'],
    ['Posted by jsmith', 'jsmith'],
    ['posted by dang', 'dang'],
    ['Posted by: jsmith', 'jsmith'],
    ['Posted by Sarah Johnson', 'Johnson'],
    ['Posted by randomuser on Monday', 'randomuser'],
    ['https://www.tiktok.com/@tikuser/video/1', 'tikuser'],
    ['https://medium.com/@medusr', 'medusr'],
    ['https://youtube.com/@ytuser', 'ytuser'],
    ['https://www.linkedin.com/in/dave-smith-123 profile', 'dave-smith'],
  ])('removes identifiers from %s', (input, gone) => {
    expect(scrubPersonal(input)).not.toContain(gone);
  });
  it('removes "posted by X"', () => {
    const out = scrubPersonal('Posted by random_user42 on Monday');
    expect(out).not.toContain('random_user42');
    expect(out).toContain('Posted by');
    expect(out).toContain('Monday');
    expect(scrubPersonal('posted by u/abcd')).toBe('posted by [user]');
  });
  it.each(['meet @ 5pm', 'at @5pm sharp', 'use u/s here', 'see example.com/u/123 ok', 'posted by the team', 'Posted by someone else', 'https://github.com/org/repo/issues/12', 'github.com/org/repo', 'visit box.com/files'])('keeps %s', (s) => {
    expect(scrubPersonal(s)).toBe(s);
  });
  it('strips a GitHub profile link at the end of a sentence', () => {
    const out = scrubPersonal('Find me at github.com/ghuser.');
    expect(out).not.toContain('ghuser');
    expect(scrubPersonal('Code is at https://github.com/ghuser. Thanks')).not.toContain('ghuser');
    expect(scrubPersonal('see github.com/org/repo.')).toBe('see github.com/org/repo.');
  });
  it('does not drop words across a sentence boundary after "posted by"', () => {
    const out = scrubPersonal('Posted by jsmith. The team replied');
    expect(out).not.toContain('jsmith');
    expect(out).toContain('The team replied');
    expect(scrubPersonal('Posted by j.smith today')).not.toContain('smith');
  });
  it('leaves ordinary text alone', () => {
    expect(scrubPersonal('Invoices take 3 hours a week.')).toBe('Invoices take 3 hours a week.');
  });
});

describe('capQuote', () => {
  it('keeps short text', () => expect(capQuote('short')).toBe('short'));
  it('caps at 500 on a word boundary', () => {
    const out = capQuote('word '.repeat(200));
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.endsWith('word')).toBe(true);
  });
});
