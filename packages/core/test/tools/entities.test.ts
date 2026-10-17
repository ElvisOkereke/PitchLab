import { describe, expect, it } from 'vitest';
import { decodeEntities } from '../../src/tools/entities';
import { cleanText } from '../../src/tools/sources/types';

describe('decodeEntities', () => {
  it('decodes decimal, hex and named forms of the same character', () => {
    expect(decodeEntities('it&#8217;s')).toBe('it’s');
    expect(decodeEntities('it&#x2019;s')).toBe('it’s');
    expect(decodeEntities('it&rsquo;s')).toBe('it’s');
    expect(decodeEntities('it&#X2019;s')).toBe('it’s');
  });

  it('decodes every numeric entity and the named set', () => {
    expect(decodeEntities('&#128512; &#xe9; &#233;')).toBe('😀 é é');
    expect(decodeEntities('&lsquo;a&rsquo; &ldquo;b&rdquo; c&hellip; d&mdash;e&ndash;f&nbsp;g')).toBe('‘a’ “b” c… d—e–f g');
    expect(decodeEntities('&amp; &lt; &gt; &quot; &apos;')).toBe('& < > " \'');
  });

  it('decodes once: an encoded entity stays one entity', () => {
    expect(decodeEntities('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;');
  });

  it('never produces control or invisible format characters (tab and newline excepted)', () => {
    for (const s of ['&#x202E;', '&#27;', '&#x1B;', '&#x200B;', '&#127;', '&#x85;', '&#xFEFF;', '&#x2066;', '&#xE0041;', '&#13;']) {
      expect(decodeEntities(s)).toBe(s);
    }
    expect(decodeEntities('a&#9;b&#10;c')).toBe('a\tb\nc');
  });

  it('leaves invalid code points and unknown names literal', () => {
    for (const s of ['&#0;', '&#xD800;', '&#xDFFF;', '&#1114112;', '&#x110000;', '&#99999999999999999999;', '&bogus;', '&#;', '&#x;']) {
      expect(decodeEntities(s)).toBe(s);
    }
  });
});

describe('cleanText decoding', () => {
  it('decodes all numeric and the named entities, then still neutralises decoded tags', () => {
    expect(cleanText('<p>Don&#8217;t &ldquo;fix&rdquo; it&hellip;</p>')).toBe('Don’t “fix” it…');
    expect(cleanText('&#60;script&#62;alert(1)&#x3C;/script&#x3E; hi')).toBe('alert(1) hi');
    expect(cleanText('a&nbsp;b')).toBe('a b');
  });
});
