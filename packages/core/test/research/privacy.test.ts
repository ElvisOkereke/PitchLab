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
    ['https://www.linkedin.com/in/dave-smith-123 profile', 'dave-smith'],
  ])('removes identifiers from %s', (input, gone) => {
    expect(scrubPersonal(input)).not.toContain(gone);
  });
  it('removes "posted by X"', () => {
    const out = scrubPersonal('Posted by randomuser on Monday');
    expect(out).not.toContain('randomuser');
    expect(out).toContain('Monday');
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
