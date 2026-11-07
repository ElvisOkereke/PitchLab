import { describe, expect, it } from 'vitest';
import { setEnvValues } from '../../scripts/lib/env-file';

describe('setEnvValues', () => {
  it('replaces existing keys and keeps comments, order and other lines', () => {
    const text = '# top\nA=1\n\n# note\nB=2\nC=3\n';
    expect(setEnvValues(text, { B: 'new' })).toBe('# top\nA=1\n\n# note\nB=new\nC=3\n');
  });

  it('appends missing keys at the end', () => {
    expect(setEnvValues('A=1\n', { B: '2', C: '3' })).toBe('A=1\nB=2\nC=3\n');
  });

  it('adds a line break before appending when the file has no trailing newline', () => {
    expect(setEnvValues('A=1', { B: '2' })).toBe('A=1\nB=2\n');
  });

  it('appends to an empty file', () => {
    expect(setEnvValues('', { B: '2' })).toBe('B=2\n');
  });

  it('preserves CRLF, including on appended lines', () => {
    expect(setEnvValues('A=1\r\nB=2\r\n', { B: 'x', C: 'y' })).toBe('A=1\r\nB=x\r\nC=y\r\n');
  });

  it('preserves LF', () => {
    const out = setEnvValues('A=1\nB=2\n', { B: 'x', C: 'y' });
    expect(out).toBe('A=1\nB=x\nC=y\n');
    expect(out).not.toContain('\r');
  });

  it('handles values containing = and :', () => {
    const v = 'scrypt:32768:8:1:c2FsdA==:a2V5=';
    expect(setEnvValues('H=old\n', { H: v })).toBe(`H=${v}\n`);
  });

  it('is not fooled by $ patterns in values', () => {
    const v = '$&$1$$';
    expect(setEnvValues('A=1\n', { A: v })).toBe(`A=${v}\n`);
  });

  it('does not treat a commented-out key as the key', () => {
    const out = setEnvValues('# OWNER_PASSWORD_HASH=old\nX=1\n', { OWNER_PASSWORD_HASH: 'new' });
    expect(out).toBe('# OWNER_PASSWORD_HASH=old\nX=1\nOWNER_PASSWORD_HASH=new\n');
  });

  it('does not match a key that merely starts with the same letters', () => {
    expect(setEnvValues('SESSION_SECRET_OLD=1\n', { SESSION_SECRET: 'n' })).toBe('SESSION_SECRET_OLD=1\nSESSION_SECRET=n\n');
  });

  it('replaces the first duplicate and removes later duplicates', () => {
    expect(setEnvValues('A=1\nB=2\nA=3\nC=4\nA=5\n', { A: 'z' })).toBe('A=z\nB=2\nC=4\n');
  });

  it('rejects values with line breaks', () => {
    expect(() => setEnvValues('A=1\n', { A: 'x\ny' })).toThrow();
  });
});
