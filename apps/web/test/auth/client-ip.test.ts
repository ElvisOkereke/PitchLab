import { describe, expect, it } from 'vitest';
import { clientKey } from '@/lib/auth/client-ip';

describe('clientKey', () => {
  it('clientKey ignores X-Forwarded-For at 0 hops and takes the right-most trusted entry at 1', () => {
    const h = new Headers({ 'x-forwarded-for': '6.6.6.6, 1.2.3.4' });
    expect(clientKey(h, 0)).toBe('all');
    expect(clientKey(h, 1)).toBe('1.2.3.4');
    expect(clientKey(new Headers({ 'x-forwarded-for': 'evil, 1.2.3.4' }), 1)).toBe('1.2.3.4');
  });

  it('takes the Nth entry from the right with N hops', () => {
    const h = new Headers({ 'x-forwarded-for': '9.9.9.9, 5.5.5.5, 10.0.0.1' });
    expect(clientKey(h, 2)).toBe('5.5.5.5');
    expect(clientKey(h, 3)).toBe('9.9.9.9');
  });

  it('falls back to "unknown" for a missing, short or non-IP entry', () => {
    expect(clientKey(new Headers(), 1)).toBe('unknown');
    expect(clientKey(new Headers({ 'x-forwarded-for': '1.2.3.4' }), 2)).toBe('unknown');
    expect(clientKey(new Headers({ 'x-forwarded-for': '1.2.3.4, evil' }), 1)).toBe('unknown');
    expect(clientKey(new Headers({ 'x-forwarded-for': '1.2.3.4, ::1' }), 1)).toBe('::1');
  });

  it('ignores the header entirely at 0 hops, whatever it holds', () => {
    expect(clientKey(new Headers({ 'x-forwarded-for': '1.1.1.1' }), 0)).toBe('all');
    expect(clientKey(new Headers({ 'x-real-ip': '1.1.1.1' }), 0)).toBe('all');
  });
});
