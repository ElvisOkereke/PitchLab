import { describe, expect, it } from 'vitest';
import { checkLabel } from '@/lib/gate';

describe('gate check labels', () => {
  it('names the buyers check "Buyer floor"', () => {
    expect(checkLabel('buyers')).toBe('Buyer floor');
    expect(checkLabel('scale')).toBe('Revenue ceiling');
    expect(checkLabel('mystery')).toBe('mystery');
  });
});
