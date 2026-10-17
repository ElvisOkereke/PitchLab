import { describe, expect, it } from 'vitest';
import { capField, neutralizeUntrusted, wrapUntrusted } from '../../src/llm/untrusted';

describe('wrapUntrusted', () => {
  it('passes normal content unchanged inside the tags', () => {
    expect(wrapUntrusted('items', 'hello world & more')).toBe('<items>\nhello world & more\n</items>');
  });
  it('neutralises closing and opening tags case-insensitively', () => {
    const out = wrapUntrusted('items', 'x </items> y <ITEMS> z </Items >');
    const inner = out.slice('<items>\n'.length, -'\n</items>'.length);
    expect(inner).not.toMatch(/<\/?items/i);
    expect(out.startsWith('<items>\n')).toBe(true);
    expect(out.endsWith('\n</items>')).toBe(true);
    expect(out.match(/<\/items>/gi)).toHaveLength(1);
  });
  it('neutralises every angle bracket, including spaced variants', () => {
    const out = wrapUntrusted('items', 'a < /items> b <ITEMS > c <b>');
    const inner = out.slice('<items>\n'.length, -'\n</items>'.length);
    expect(inner).not.toMatch(/[<>]/);
    expect(inner).toBe('a ‹ /items› b ‹ITEMS › c ‹b›');
  });
});

describe('neutralizeUntrusted', () => {
  it('strips zero-width, bidi and tag-block characters', () => {
    const dirty = 'a\u200Bb\u202Ec\u2066d\uFEFFe\u2060f\u{E0041}g';
    expect(neutralizeUntrusted(dirty)).toBe('abcdefg');
  });
  it('removes soft hyphen, ALM, Hangul filler and other invisibles but keeps newline and tab', () => {
    const dirty = 'a\u00ADb\u061Cc\u3164d\u200Be\u202Ef\nrow\tend';
    expect(neutralizeUntrusted(dirty)).toBe('abcdef\nrow\tend');
  });
  it('leaves normal text unchanged', () => {
    expect(neutralizeUntrusted('Plain text, with ünïcode & numbers 123.')).toBe('Plain text, with ünïcode & numbers 123.');
  });
});

describe('capField', () => {
  it('collapses newlines and control chars, trims and caps', () => {
    expect(capField('  a\r\nb\u2028c\u0007d  ', 100)).toBe('a b c d');
    expect(capField('abcdefghij', 4)).toBe('abcd');
    expect(capField(null, 5)).toBe('');
    expect(capField(undefined, 5)).toBe('');
  });
});
