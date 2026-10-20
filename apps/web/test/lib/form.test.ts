import { describe, expect, it } from 'vitest';
import { formToObject, toInt } from '@/lib/form';

describe('formToObject', () => {
  it('trims strings, turns repeated keys into arrays and keeps listed array keys as arrays', () => {
    const fd = new FormData();
    fd.set('a', '  x ');
    fd.append('r', '1');
    fd.append('r', ' 2 ');
    fd.set('one', 'only');
    fd.set('$ACTION_ID_abc', '');
    fd.set('file', new Blob(['x']), 'f.txt');
    expect(formToObject(fd, ['one', 'missing'])).toEqual({ a: 'x', r: ['1', '2'], one: ['only'], missing: [] });
  });
});

describe('toInt', () => {
  it('parses whole numbers only', () => {
    expect(toInt('12')).toBe(12);
    expect(toInt(' -3 ')).toBe(-3);
    expect(toInt(7)).toBe(7);
    for (const bad of ['', 'abc', '1.5', '1e3', 1.5, null, undefined, NaN, '9'.repeat(20)]) expect(toInt(bad)).toBeUndefined();
  });
});
