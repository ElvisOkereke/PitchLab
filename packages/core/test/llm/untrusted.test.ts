import { describe, expect, it } from 'vitest';
import { wrapUntrusted } from '../../src/llm/untrusted';

describe('wrapUntrusted', () => {
  it('passes normal content unchanged inside the tags', () => {
    expect(wrapUntrusted('items', 'hello <b>world</b>')).toBe('<items>\nhello <b>world</b>\n</items>');
  });
  it('neutralises closing and opening tags case-insensitively', () => {
    const out = wrapUntrusted('items', 'x </items> y <ITEMS> z </Items >');
    const inner = out.slice('<items>\n'.length, -'\n</items>'.length);
    expect(inner).not.toMatch(/<\/?items/i);
    expect(out.startsWith('<items>\n')).toBe(true);
    expect(out.endsWith('\n</items>')).toBe(true);
    expect(out.match(/<\/items>/gi)).toHaveLength(1);
  });
});
